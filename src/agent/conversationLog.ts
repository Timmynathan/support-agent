// Writes to the log tables the agent server owns: conversations, conversation_turns,
// retrieval_logs and conversation_events. It never reads customers, transactions or payouts —
// those are reachable only through the MCP tools, where every access is a logged tool call.
import { db, must, mustRow } from '../shared/db.js';
import type { Channel } from '../shared/domain.js';
import type { RetrievalHit } from '../knowledge/retrieve.js';
import type { AnswerType } from './prompt.js';

export type FinalStatus = 'resolved' | 'escalated' | 'declined' | 'abandoned' | 'failed';

export async function startConversation(conversationId: string, channel: Channel, callerIdentifier: string | null): Promise<void> {
  must(
    await db()
      .from('conversations')
      .upsert(
        { conversation_id: conversationId, channel, caller_identifier: callerIdentifier },
        { onConflict: 'conversation_id', ignoreDuplicates: true },
      ),
  );
}

export async function endConversation(conversationId: string, finalStatus: FinalStatus, summary: string): Promise<void> {
  must(
    await db()
      .from('conversations')
      .update({ final_status: finalStatus, ended_at: new Date().toISOString(), summary })
      .eq('conversation_id', conversationId),
  );
}

// Written BEFORE the model is called, so a turn that dies midway still leaves the caller's words.
export async function startTurn(conversationId: string, turnIndex: number, userTranscript: string): Promise<number> {
  const row = mustRow(
    await db()
      .from('conversation_turns')
      .insert({ conversation_id: conversationId, turn_index: turnIndex, user_transcript: userTranscript })
      .select('id')
      .single(),
  );
  return row.id as number;
}

export async function finishTurn(turnId: number, response: string, answerType: AnswerType | 'error', confidenceNote: string): Promise<void> {
  must(
    await db()
      .from('conversation_turns')
      .update({ assistant_response: response, answer_type: answerType, confidence_note: confidenceNote })
      .eq('id', turnId),
  );
}

export async function logRetrieval(conversationId: string, turnId: number, query: string, hits: RetrievalHit[]): Promise<void> {
  must(
    await db()
      .from('retrieval_logs')
      .insert({
        conversation_id: conversationId,
        turn_id: turnId,
        query,
        chunk_ids: hits.map((hit) => hit.chunk.id),
        source_titles: hits.map((hit) => hit.chunk.title),
        source_summary: hits.length === 0 ? null : hits.map((hit) => `${hit.chunk.summary} (score ${hit.score.toFixed(2)})`).join(' | '),
        result_count: hits.length,
      }),
  );
}

export type EventType = 'decision' | 'clarification' | 'escalation_triggered' | 'decline' | 'handoff' | 'error' | 'note';

export async function logEvent(conversationId: string, eventType: EventType, summary: string, metadata: Record<string, unknown> = {}): Promise<void> {
  must(await db().from('conversation_events').insert({ conversation_id: conversationId, event_type: eventType, summary, metadata }));
}
