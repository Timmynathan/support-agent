import type { Channel } from '../shared/domain.js';
import { Conversation } from '../agent/conversation.js';

// Each open conversation holds a Claude process (~250 MB); idle ones are closed.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const conversations = new Map<string, Conversation>();
// Starts in flight, so a webhook and the first model request arriving together share one.
const starting = new Map<string, Promise<Conversation>>();

export function getConversation(id: string): Conversation | undefined {
  return conversations.get(id);
}

export function openConversationCount(): number {
  return conversations.size;
}

export async function getOrStartConversation(id: string, channel: Channel, callerIdentifier: string | null): Promise<Conversation> {
  const existing = conversations.get(id);
  if (existing) return existing;
  const inFlight = starting.get(id);
  if (inFlight) return inFlight;

  const start = Conversation.start(id, channel, callerIdentifier).then((conversation) => {
    conversations.set(id, conversation);
    return conversation;
  });
  starting.set(id, start);
  try {
    return await start;
  } finally {
    starting.delete(id);
  }
}

// Idempotent: the call-ended webhook and end-of-call report can both arrive for one call.
export async function endConversation(id: string, reason: string): Promise<boolean | null> {
  const conversation = conversations.get(id);
  if (!conversation) return null;
  conversations.delete(id);
  return conversation.end(reason);
}

export async function endAll(reason: string): Promise<void> {
  await Promise.allSettled([...conversations.keys()].map((id) => endConversation(id, reason)));
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [id, conversation] of conversations) {
    if (conversation.lastActivity >= cutoff) continue;
    endConversation(id, 'idle').catch((error: unknown) => process.stderr.write(`closing idle ${id} failed: ${String(error)}\n`));
  }
}, 60_000).unref();
