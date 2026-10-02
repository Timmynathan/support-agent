import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONVERSATION_ID_PATTERN } from '../shared/domain.js';
import { AGENT_MODEL } from '../agent/session.js';
import { endConversation, getConversation, getOrStartConversation, openConversationCount } from './registry.js';
import { HttpError, parseJsonObject, readBody, sendJson } from './httpUtil.js';
import { readVerificationForm, verifyConversation } from './verification.js';

// The plain-text channel used for testing without voice. It has no caller authentication, so
// it is only ever served on the loopback-only listener, never through the tunnel.
const MAX_MESSAGE_CHARS = 2000;

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseJsonObject(await readBody(req));
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new HttpError(400, 'message is required');
  if (message.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `message must be at most ${MAX_MESSAGE_CHARS} characters`);

  let conversation;
  if (body.conversation_id === undefined) {
    conversation = await getOrStartConversation(`text-${randomUUID()}`, 'text', null);
  } else {
    if (typeof body.conversation_id !== 'string' || !CONVERSATION_ID_PATTERN.test(body.conversation_id)) throw new HttpError(400, 'invalid conversation_id');
    conversation = getConversation(body.conversation_id);
    if (!conversation) throw new HttpError(404, 'no open conversation with that id; omit conversation_id to start one');
  }
  sendJson(res, 200, await conversation.handle({ text: message }));
}

// The verification form for the text test channel (the voice page uses /vapi/verify).
async function verify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseJsonObject(await readBody(req));
  await verifyConversation(res, typeof body.conversation_id === 'string' ? body.conversation_id : '', readVerificationForm(body));
}

async function start(res: ServerResponse): Promise<void> {
  const conversation = await getOrStartConversation(`text-${randomUUID()}`, 'text', null);
  sendJson(res, 200, { conversation_id: conversation.id });
}

async function end(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseJsonObject(await readBody(req));
  const id = typeof body.conversation_id === 'string' ? body.conversation_id : '';
  const recorded = await endConversation(id, 'caller_ended');
  if (recorded === null) throw new HttpError(404, 'no open conversation with that id');
  if (!recorded) {
    sendJson(res, 503, {
      conversation_id: id,
      ended: true,
      recorded: false,
      error: 'The conversation was closed, but its final status could not be saved to the database. It was written to the local fallback log.',
    });
    return;
  }
  sendJson(res, 200, { conversation_id: id, ended: true, recorded: true });
}

export function routeText(req: IncomingMessage, res: ServerResponse): Promise<void> | null {
  const route = `${req.method} ${req.url}`;
  if (route === 'POST /chat') return chat(req, res);
  if (route === 'POST /chat/start') return start(res);
  if (route === 'POST /chat/verify') return verify(req, res);
  if (route === 'POST /chat/end') return end(req, res);
  if (route === 'GET /health') return Promise.resolve(sendJson(res, 200, { ok: true, model: AGENT_MODEL, open_conversations: openConversationCount() }));
  return null;
}
