import { db, must } from '../shared/db.js';
import { getConversation } from './registry.js';

// A conversation gets its final status when it ends. If the server restarts mid-call (every
// deploy does) or the end signal never arrives, it would stay "in_progress" forever. This closes
// those, and only those: nothing that has seen activity in the last hour (calls are capped at
// 15 minutes and idle conversations close after 10), and never one that already has a status.
export const STALE_AFTER_MS = 60 * 60 * 1000;
export const SWEEP_SUMMARY_PREFIX = 'Closed by the stale-conversation sweep';

export interface SweepResult {
  closed: Array<{ conversation_id: string; final_status: string; idle_since: string }>;
  skipped: number;
}

export async function sweepStaleConversations(now = Date.now()): Promise<SweepResult> {
  const cutoff = new Date(now - STALE_AFTER_MS).toISOString();
  const candidates = must(
    await db().from('conversations').select('conversation_id, started_at').eq('final_status', 'in_progress').lt('started_at', cutoff),
  ) as Array<{ conversation_id: string; started_at: string }>;

  const result: SweepResult = { closed: [], skipped: 0 };
  for (const { conversation_id: id, started_at: startedAt } of candidates) {
    // Open in this process: it is live here, whatever the database says.
    if (getConversation(id)) {
      result.skipped++;
      continue;
    }
    const [turns, events, escalations] = await Promise.all([
      db().from('conversation_turns').select('created_at').eq('conversation_id', id).order('created_at', { ascending: false }).limit(1).then(must),
      // Events loaded later from the fallback log carry the time they were loaded, not activity.
      db().from('conversation_events').select('created_at').eq('conversation_id', id).is('metadata->>replayed_from_fallback_at', null).order('created_at', { ascending: false }).limit(1).then(must),
      db().from('escalations').select('escalation_id').eq('conversation_id', id).limit(1).then(must),
    ]);
    const counted = await db().from('conversation_turns').select('id', { count: 'exact', head: true }).eq('conversation_id', id);
    must(counted);
    const turnCount = counted.count ?? 0;
    // Compared as times, not text: the database and JavaScript format timestamps differently.
    const lastActivityMs = Math.max(...[startedAt, (turns as any[])[0]?.created_at, (events as any[])[0]?.created_at].filter(Boolean).map((t: string) => Date.parse(t)));
    const lastActivity = new Date(lastActivityMs).toISOString();
    if (lastActivityMs > now - STALE_AFTER_MS) {
      result.skipped++;
      continue;
    }
    // Only what the records show: an escalation was created, or the outcome is unknown. A
    // conversation that never ended is not claimed as resolved.
    const finalStatus = (escalations as any[]).length > 0 ? 'escalated' : 'abandoned';
    const summary = `${SWEEP_SUMMARY_PREFIX}: never ended (a server restart or a lost end signal); last activity ${lastActivity}; ${turnCount} turn(s).`;
    const updated = must(
      await db()
        .from('conversations')
        .update({ final_status: finalStatus, ended_at: lastActivity, summary })
        .eq('conversation_id', id)
        .eq('final_status', 'in_progress')
        .select('conversation_id'),
    ) as unknown[];
    if (updated.length === 0) {
      result.skipped++;
      continue;
    }
    must(await db().from('conversation_events').insert({
      conversation_id: id,
      event_type: 'note',
      summary: `Closed as ${finalStatus} by the stale-conversation sweep`,
      metadata: { swept_at: new Date(now).toISOString(), last_activity: lastActivity, final_status: finalStatus },
    }));
    result.closed.push({ conversation_id: id, final_status: finalStatus, idle_since: lastActivity });
  }
  return result;
}
