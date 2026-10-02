import { CHANNELS, CONVERSATION_ID_PATTERN, type Channel } from '../shared/domain.js';

// The conversation a server instance serves is fixed by whoever spawned it (the agent server,
// or the CLI), never by the model. Tool inputs have no conversation_id field, so a caller
// cannot talk the model into acting on, or borrowing verification from, another conversation.
export interface ToolContext {
  conversationId: string;
  channel: Channel;
  // Who is calling the tool. 'verification_form' is set only by server code handling the
  // secure form the caller types into; the MCP server the agent talks to is always 'agent',
  // so the model can never present itself as the form.
  source: 'agent' | 'verification_form';
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): ToolContext {
  const conversationId = env.MCP_CONVERSATION_ID;
  if (!conversationId || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new Error('MCP_CONVERSATION_ID must be set to a valid conversation id before starting the MCP server');
  }
  const channel = env.MCP_CHANNEL ?? 'cli';
  if (!isChannel(channel)) {
    throw new Error(`MCP_CHANNEL must be one of ${CHANNELS.join(', ')}`);
  }
  return { conversationId, channel, source: 'agent' };
}

function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}
