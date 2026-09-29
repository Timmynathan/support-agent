import { z } from 'zod';
import { db, mustRow } from '../../shared/db.js';
import { EVENT_TYPES } from '../../shared/domain.js';
import { redactForLog } from '../redact.js';
import { defineTool, refused } from '../tool.js';

const MAX_METADATA_CHARS = 4000;

export const logConversationEvent = defineTool({
  name: 'log_conversation_event',
  purpose: 'Record an agent decision or notable event in the conversation log',
  description:
    'Record an important decision or event in this conversation: which response path you chose and why, a ' +
    'clarification asked, an escalation triggered, a decline, or an error the caller experienced. Keep summary ' +
    'short and factual. Do not put full emails or account details in it.',
  input: z.object({
    event_type: z.enum(EVENT_TYPES),
    summary: z.string().trim().min(1).max(500),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  async handler(ctx, args) {
    const metadata = redactForLog(args.metadata ?? {}) as Record<string, unknown>;
    if (JSON.stringify(metadata).length > MAX_METADATA_CHARS) {
      return refused('metadata_too_large', `Keep metadata under ${MAX_METADATA_CHARS} characters; put the essentials in summary.`);
    }
    const row = mustRow(
      await db()
        .from('conversation_events')
        .insert({ conversation_id: ctx.conversationId, event_type: args.event_type, summary: args.summary, metadata })
        .select('id')
        .single(),
    );
    return {
      status: 'ok',
      result: { ok: true, logged: true },
      logSummary: { logged: true, event_id: row.id, event_type: args.event_type },
    };
  },
});
