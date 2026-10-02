// Loads records that went to the local fallback files (because Supabase couldn't be reached)
// into Supabase. Every write is checked against what is already there first, so running this
// twice changes nothing the second time. Nothing in the files is altered.
//
//   npm run replay-fallback            show what would be written, write nothing
//   npm run replay-fallback -- --apply write it
import { existsSync, readFileSync } from 'node:fs';
import { AGENT_FALLBACK_LOG } from '../src/agent/conversation.js';
import { FALLBACK_LOG_PATH } from '../src/mcp/toolLog.js';
import { TOOLS } from '../src/mcp/tools/index.js';
import { SWEEP_SUMMARY_PREFIX } from '../src/server/staleSweep.js';
import { db, must } from '../src/shared/db.js';

const APPLY = process.argv.includes('--apply');
const NOTE = 'Recorded from the fallback log after the database could not be reached';
type Entry = Record<string, any>;
type Outcome = 'written' | 'already present' | `skipped: ${string}`;

function readLines(path: string): Entry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
}

function channelOf(conversationId: string): 'voice' | 'text' | 'cli' {
  return conversationId.startsWith('vapi-') ? 'voice' : conversationId.startsWith('text-') ? 'text' : 'cli';
}

async function conversationExists(id: string): Promise<boolean> {
  const rows = must(await db().from('conversations').select('conversation_id').eq('conversation_id', id).limit(1)) as unknown[];
  return rows.length > 0;
}

// Every other record refers to its conversation, so it must exist first. Newer records carry
// the channel; for older ones it is read from the id's prefix.
async function ensureConversation(id: string, at: string, entry?: Entry): Promise<Outcome> {
  if (await conversationExists(id)) return 'already present';
  if (APPLY) {
    must(
      await db()
        .from('conversations')
        .upsert({ conversation_id: id, channel: entry?.channel ?? channelOf(id), caller_identifier: entry?.caller_identifier ?? null, started_at: at }, { onConflict: 'conversation_id', ignoreDuplicates: true }),
    );
  }
  return 'written';
}

async function turnId(conversationId: string, turnIndex: number): Promise<number | null> {
  const rows = must(await db().from('conversation_turns').select('id').eq('conversation_id', conversationId).eq('turn_index', turnIndex).limit(1)) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

async function eventFromEntryExists(conversationId: string, at: string): Promise<boolean> {
  const rows = must(await db().from('conversation_events').select('id').eq('conversation_id', conversationId).contains('metadata', { replayed_from_fallback_at: at }).limit(1)) as unknown[];
  return rows.length > 0;
}

async function insertEvent(conversationId: string, at: string, eventType: string, summary: string, metadata: Record<string, unknown>): Promise<Outcome> {
  if (await eventFromEntryExists(conversationId, at)) return 'already present';
  if (APPLY) must(await db().from('conversation_events').insert({ conversation_id: conversationId, event_type: eventType, summary, metadata: { ...metadata, replayed_from_fallback_at: at } }));
  return 'written';
}

async function replayAgentEntry(e: Entry): Promise<Outcome> {
  const id = e.conversation_id as string;
  if (e.stage === 'start_conversation') return ensureConversation(id, e.at, e);
  await ensureConversation(id, e.at);

  // The turn row itself couldn't be written; the caller heard the fixed failure line.
  if (e.stage === 'start_turn' && typeof e.user_transcript === 'string') {
    if ((await turnId(id, e.turn_index)) !== null) return 'already present';
    if (APPLY) {
      must(
        await db().from('conversation_turns').insert({
          conversation_id: id,
          turn_index: e.turn_index,
          user_transcript: e.user_transcript,
          assistant_response: e.assistant_response ?? null,
          answer_type: 'error',
          confidence_note: `failed at start_turn: the database could not be reached (${NOTE})`,
          created_at: e.at,
        }),
      );
      await insertEvent(id, e.at, 'error', `Turn ${e.turn_index} failed at start_turn`, { stage: 'start_turn', turn_index: e.turn_index, error: e.error ?? null });
    }
    return 'written';
  }

  if (e.stage === 'end_conversation') {
    const [row] = must(await db().from('conversations').select('final_status, summary').eq('conversation_id', id)) as Array<{ final_status: string; summary: string | null }>;
    // The real outcome replaces "in progress" or a sweep's "abandoned", never a status recorded live.
    const replaceable = row && (row.final_status === 'in_progress' || row.summary?.startsWith(SWEEP_SUMMARY_PREFIX));
    if (!replaceable) return row && row.final_status === e.final_status ? 'already present' : `skipped: already closed as ${row?.final_status}`;
    if (APPLY) must(await db().from('conversations').update({ final_status: e.final_status, ended_at: e.at, summary: `${e.summary} (${NOTE})` }).eq('conversation_id', id).eq('final_status', row.final_status));
    return 'written';
  }

  if (e.stage === 'finish_turn') {
    const reply = e.reply as { turn_index: number; reply: string; answer_type: string } & Record<string, unknown>;
    const [turn] = must(await db().from('conversation_turns').select('id, assistant_response').eq('conversation_id', id).eq('turn_index', reply.turn_index)) as Array<{ id: number; assistant_response: string | null }>;
    if (!turn) return 'skipped: the turn itself was never recorded';
    if (turn.assistant_response !== null) return 'already present';
    if (APPLY) {
      must(await db().from('conversation_turns').update({ assistant_response: reply.reply, answer_type: reply.answer_type, confidence_note: NOTE }).eq('id', turn.id).is('assistant_response', null));
      await insertEvent(id, e.at, 'decision', `Turn ${reply.turn_index}: ${reply.answer_type}`, {
        turn_index: reply.turn_index,
        answer_type: reply.answer_type,
        cited_chunk_ids: reply.cited_chunk_ids,
        enforced: reply.enforced,
        tools: reply.tools,
        timings_ms: reply.timings_ms,
      });
    }
    return 'written';
  }

  if (e.stage === 'log_retrieval') {
    const tid = await turnId(id, e.turn_index);
    const existing = must(await db().from('retrieval_logs').select('id').eq('conversation_id', id).eq('query', e.query).limit(1)) as unknown[];
    if (existing.length > 0) return 'already present';
    if (APPLY) {
      must(
        await db().from('retrieval_logs').insert({
          conversation_id: id,
          turn_id: tid,
          query: e.query,
          chunk_ids: e.chunk_ids ?? [],
          result_count: (e.chunk_ids ?? []).length,
          source_summary: `${NOTE}; source titles were not kept in the fallback record.`,
        }),
      );
      if ((e.triggers ?? []).length > 0) await insertEvent(id, e.at, 'escalation_triggered', `Triggers: ${e.triggers.join(', ')}`, { turn_index: e.turn_index, triggers: e.triggers });
    }
    return 'written';
  }

  // A turn that failed and couldn't log its failure (deadline, agent error, a log write that
  // failed): recorded as the error it was.
  return insertEvent(id, e.at, 'error', `Turn ${e.turn_index ?? '?'} failed at ${e.stage}`, { stage: e.stage, turn_index: e.turn_index ?? null, error: e.error ?? null, log_error: e.log_error ?? null });
}

const purposeOf = new Map(TOOLS.map((tool) => [tool.name, tool.purpose]));

async function replayToolEntry(e: Entry): Promise<Outcome> {
  const id = e.conversation_id as string;
  await ensureConversation(id, e.at);
  // The row was created but couldn't be finalised: finish it, once.
  if (e.phase === 'finish' && e.tool_call_id) {
    const [row] = must(await db().from('tool_calls').select('status').eq('id', e.tool_call_id)) as Array<{ status: string }>;
    if (!row) return 'skipped: its tool_calls row no longer exists';
    if (row.status !== 'started') return 'already present';
    if (APPLY) must(await db().from('tool_calls').update({ status: e.status, result_summary: e.result_summary, error_message: e.error_message, finished_at: e.at, duration_ms: e.duration_ms }).eq('id', e.tool_call_id).eq('status', 'started'));
    return 'written';
  }
  // The row was never created (the log write itself failed, so the tool did not run).
  const finishedAt = e.at as string;
  const existing = must(await db().from('tool_calls').select('id').eq('conversation_id', id).eq('tool_name', e.tool_name).eq('finished_at', finishedAt).limit(1)) as unknown[];
  if (existing.length > 0) return 'already present';
  if (APPLY) {
    must(
      await db().from('tool_calls').insert({
        conversation_id: id,
        tool_name: e.tool_name,
        purpose: purposeOf.get(e.tool_name) ?? `${e.tool_name} (purpose not on record)`,
        input_summary: e.input_summary ?? {},
        result_summary: e.result_summary ?? null,
        status: e.status,
        error_message: e.error_message ?? e.finish_error ?? NOTE,
        started_at: new Date(Date.parse(finishedAt) - (e.duration_ms ?? 0)).toISOString(),
        finished_at: finishedAt,
        duration_ms: e.duration_ms ?? null,
      }),
    );
  }
  return 'written';
}

const sources: Array<[string, Entry[], (e: Entry) => Promise<Outcome>]> = [
  ['agent', readLines(AGENT_FALLBACK_LOG), replayAgentEntry],
  ['tool', readLines(FALLBACK_LOG_PATH), replayToolEntry],
];
const totals: Record<string, number> = {};
for (const [kind, entries, replay] of sources) {
  for (const entry of entries) {
    const outcome = await replay(entry);
    const bucket = outcome.startsWith('skipped') ? 'skipped' : outcome;
    totals[bucket] = (totals[bucket] ?? 0) + 1;
    process.stdout.write(`${kind.padEnd(5)} ${entry.at} ${String(entry.stage ?? entry.phase).padEnd(18)} ${entry.conversation_id}  →  ${APPLY || outcome !== 'written' ? outcome : 'would write'}\n`);
  }
}
process.stdout.write(`\n${APPLY ? '' : 'Dry run, nothing written. '}${JSON.stringify(totals)}${APPLY ? '' : '  (add -- --apply to write)'}\n`);
process.exit(0);
