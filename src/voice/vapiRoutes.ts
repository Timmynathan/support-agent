import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { SpeechSink } from '../agent/conversation.js';
import { fromRoot } from '../shared/paths.js';
import { endConversation, getOrStartConversation } from '../server/registry.js';
import { HttpError, parseJsonObject, readBody, sendJson } from '../server/httpUtil.js';
import { verifyBearer, verifyWebhookSignature } from './auth.js';
import { normalizeSpokenReferences } from './transcript.js';

// Vapi is the voice layer only: speech to text, text to speech, call handling. Every support
// decision is made by the agent behind these routes. Vapi calls:
//   POST /vapi/chat/completions  (custom LLM: once per caller turn, OpenAI-compatible SSE)
//   POST /vapi/webhook           (call status + end-of-call report)

const MODEL_NAME = 'relaypay-agent';
const PUBLIC_DIR = fromRoot('public');
// Only these files are served; no path from the request ever reaches the filesystem.
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/tokens.css': { file: 'tokens.css', type: 'text/css; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

function requireSecret(name: 'VAPI_LLM_SECRET' | 'VAPI_WEBHOOK_SECRET'): string {
  const value = process.env[name];
  // Fail closed: an unconfigured secret must not mean an open endpoint.
  if (!value) throw new HttpError(503, 'voice channel is not configured');
  return value;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

// Vapi resends the whole conversation each turn; the agent keeps its own history, so only the
// caller's words since the assistant last spoke are new.
function newCallerText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const list = messages as ChatMessage[];
  let lastAssistant = -1;
  list.forEach((message, index) => {
    if (message.role === 'assistant') lastAssistant = index;
  });
  return list
    .slice(lastAssistant + 1)
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .join(' ')
    .trim();
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : '')).join(' ');
}

function sseChunk(id: string, delta: Record<string, unknown>, finishReason: string | null): string {
  const chunk = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL_NAME, choices: [{ index: 0, delta, finish_reason: finishReason }] };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = verifyBearer(req.headers, requireSecret('VAPI_LLM_SECRET'));
  if (!auth.ok) {
    process.stderr.write(`rejected /vapi/chat/completions: ${auth.reason}\n`);
    throw new HttpError(401, 'unauthorized');
  }
  const body = parseJsonObject(await readBody(req));
  const call = body.call as { id?: unknown } | undefined;
  if (typeof call?.id !== 'string') throw new HttpError(400, 'call.id missing — set the assistant model metadataSendMode to "variable"');
  const rawTranscript = newCallerText(body.messages);
  const conversation = await getOrStartConversation(`vapi-${call.id}`, 'voice', null);
  const streaming = body.stream !== false;
  const completionId = `chatcmpl-${randomUUID()}`;

  if (!rawTranscript) {
    // Nothing new from the caller (Vapi can ask the model to speak unprompted); say nothing.
    if (streaming) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.end(`${sseChunk(completionId, {}, 'stop')}data: [DONE]\n\n`);
    } else {
      sendJson(res, 200, completion(completionId, ''));
    }
    return;
  }

  const normalized = normalizeSpokenReferences(rawTranscript);
  let finished = false;
  const sink: SpeechSink & { closed: boolean } = {
    closed: false,
    say(text) {
      if (!streaming || this.closed) return;
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(sseChunk(completionId, { role: 'assistant' }, null));
      }
      res.write(sseChunk(completionId, { content: text }, null));
    },
  };
  // The caller spoke over the agent, or hung up: Vapi drops this request mid-stream.
  res.on('close', () => {
    if (finished) return;
    sink.closed = true;
    void conversation.interruptCurrentTurn();
  });

  const reply = await conversation.handle({ text: normalized.text, rawTranscript, sink });
  finished = true;
  if (sink.closed) return;
  if (!streaming) {
    sendJson(res, 200, completion(completionId, reply.reply));
    return;
  }
  if (!res.headersSent) sink.say(reply.reply);
  res.end(`${sseChunk(completionId, {}, 'stop')}data: [DONE]\n\n`);
}

function completion(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawBody = await readBody(req);
  const auth = verifyWebhookSignature(rawBody, req.headers, requireSecret('VAPI_WEBHOOK_SECRET'));
  if (!auth.ok) {
    process.stderr.write(`rejected /vapi/webhook: ${auth.reason}\n`);
    throw new HttpError(401, 'unauthorized');
  }
  const message = parseJsonObject(rawBody).message as { type?: unknown; status?: unknown; endedReason?: unknown; call?: { id?: unknown } } | undefined;
  const callId = typeof message?.call?.id === 'string' ? message.call.id : null;
  // Acknowledge at once; Vapi doesn't wait on these, and neither should the call.
  sendJson(res, 200, { received: true });
  if (!message || !callId) return;

  const conversationId = `vapi-${callId}`;
  if (message.type === 'status-update' && message.status === 'in-progress') {
    // Start the ~10 s Claude process while Vapi speaks its greeting, not on the first question.
    getOrStartConversation(conversationId, 'voice', null).catch((error: unknown) => process.stderr.write(`warm start ${conversationId} failed: ${String(error)}\n`));
    return;
  }
  const ended = (message.type === 'status-update' && message.status === 'ended') || message.type === 'end-of-call-report';
  if (ended) {
    const reason = typeof message.endedReason === 'string' ? message.endedReason : 'call_ended';
    endConversation(conversationId, `vapi:${reason}`).catch((error: unknown) => process.stderr.write(`ending ${conversationId} failed: ${String(error)}\n`));
  }
}

async function staticFile(res: ServerResponse, entry: { file: string; type: string }): Promise<void> {
  const content = await readFile(resolve(PUBLIC_DIR, entry.file));
  res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-cache' });
  res.end(content);
}

// The widget needs exactly two values, both public by Vapi's design: the public key and the
// assistant id. Nothing else from the environment is ever sent to a browser.
function widgetConfig(res: ServerResponse): void {
  const publicKey = process.env.VAPI_PUBLIC_KEY;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!publicKey || !assistantId) throw new HttpError(503, 'voice widget is not configured');
  sendJson(res, 200, { publicKey, assistantId });
}

export function routeVoice(req: IncomingMessage, res: ServerResponse): Promise<void> | null {
  const path = (req.url ?? '/').split('?')[0]!;
  if (req.method === 'POST' && path === '/vapi/chat/completions') return chatCompletions(req, res);
  if (req.method === 'POST' && path === '/vapi/webhook') return webhook(req, res);
  if (req.method === 'GET' && path === '/config.json') return Promise.resolve(widgetConfig(res));
  if (req.method === 'GET' && path === '/health') return Promise.resolve(sendJson(res, 200, { ok: true }));
  const entry = req.method === 'GET' ? STATIC_FILES[path] : undefined;
  if (entry) return staticFile(res, entry);
  return null;
}
