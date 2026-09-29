import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CONVERSATION_ID_PATTERN } from '../shared/domain.js';
import { Conversation } from '../agent/conversation.js';
import { AGENT_MODEL } from '../agent/session.js';

// The text endpoint has no caller authentication, so it listens on loopback only. The public
// voice webhook (Phase 3) is a separate route that verifies Vapi's signature before acting.
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);
const MAX_MESSAGE_CHARS = 2000;
const MAX_BODY_BYTES = 16 * 1024;
// Each open conversation holds a Claude process (~250 MB); idle ones are closed.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const conversations = new Map<string, Conversation>();

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    parts.push(chunk as Buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body must be a JSON object');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

async function getOrStartConversation(requestedId: unknown): Promise<Conversation> {
  if (requestedId !== undefined) {
    if (typeof requestedId !== 'string' || !CONVERSATION_ID_PATTERN.test(requestedId)) throw new HttpError(400, 'invalid conversation_id');
    const existing = conversations.get(requestedId);
    if (existing) return existing;
    throw new HttpError(404, 'no open conversation with that id; omit conversation_id to start one');
  }
  const conversation = await Conversation.start(`text-${randomUUID()}`, 'text', null);
  conversations.set(conversation.id, conversation);
  return conversation;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new HttpError(400, 'message is required');
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `message must be at most ${MAX_MESSAGE_CHARS} characters`);
  const conversation = await getOrStartConversation(body.conversation_id);
  send(res, 200, await conversation.handle(message));
}

async function handleStart(res: ServerResponse): Promise<void> {
  const conversation = await getOrStartConversation(undefined);
  send(res, 200, { conversation_id: conversation.id });
}

async function handleEnd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const id = body.conversation_id;
  const conversation = typeof id === 'string' ? conversations.get(id) : undefined;
  if (!conversation) throw new HttpError(404, 'no open conversation with that id');
  conversations.delete(conversation.id);
  const recorded = await conversation.end('caller_ended');
  if (!recorded) {
    send(res, 503, { conversation_id: conversation.id, ended: true, recorded: false, error: 'The conversation was closed, but its final status could not be saved to the database. It was written to the local fallback log.' });
    return;
  }
  send(res, 200, { conversation_id: conversation.id, ended: true, recorded: true });
}

const server = createServer((req, res) => {
  const route = `${req.method} ${req.url}`;
  const handler =
    route === 'POST /chat' ? handleChat(req, res)
    : route === 'POST /chat/start' ? handleStart(res)
    : route === 'POST /chat/end' ? handleEnd(req, res)
    : route === 'GET /health' ? Promise.resolve(send(res, 200, { ok: true, model: AGENT_MODEL, open_conversations: conversations.size }))
    : Promise.reject(new HttpError(404, 'not found'));

  handler.catch((error: unknown) => {
    const status = error instanceof HttpError ? error.status : 500;
    // Internal detail goes to the server log, not the response.
    if (status === 500) process.stderr.write(`${route} failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    send(res, status, { error: status === 500 ? 'internal error' : (error as Error).message });
  });
});

setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [id, conversation] of conversations) {
    if (conversation.lastActivity >= cutoff) continue;
    conversations.delete(id);
    conversation.end('idle').catch((error: unknown) => process.stderr.write(`closing idle ${id} failed: ${String(error)}\n`));
  }
}, 60_000).unref();

async function shutdown(): Promise<void> {
  await Promise.allSettled([...conversations.values()].map((conversation) => conversation.end('server_shutdown')));
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

server.listen(PORT, HOST, () => process.stdout.write(`RelayPay agent listening on http://${HOST}:${PORT} (model ${AGENT_MODEL})\n`));
