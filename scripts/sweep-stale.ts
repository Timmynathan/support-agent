// Gives a final status to conversations that never ended (the server also does this itself at
// startup and every 15 minutes). Safe to run any time: it only closes conversations still
// "in_progress" with no activity for an hour.
//
//   npm run sweep
import { STALE_AFTER_MS, sweepStaleConversations } from '../src/server/staleSweep.js';

const { closed, skipped } = await sweepStaleConversations();
for (const c of closed) process.stdout.write(`closed ${c.conversation_id} → ${c.final_status} (last activity ${c.idle_since})\n`);
process.stdout.write(`${closed.length} closed, ${skipped} left open (active within ${STALE_AFTER_MS / 60000} min or already closed)\n`);
process.exit(0);
