// Every database-level guard, exercised by deliberately doing the wrong thing straight against
// the tables — bypassing the MCP tools entirely. Each case PASSES only if the database refuses.
// Rows written here are append-only by design, so they stay under a "guard-<timestamp>" conversation.
import { createClient } from '@supabase/supabase-js';
import { db, must, mustRow } from '../src/shared/db.js';

interface Attempt {
  error: { code?: string; message: string } | null;
  data?: unknown;
}

let failures = 0;

function expectRefused(name: string, attempt: Attempt, expectedCode?: string): void {
  const refused = attempt.error !== null && (!expectedCode || attempt.error.code === expectedCode);
  if (!refused) failures++;
  const detail = attempt.error ? `${attempt.error.code ?? '?'}: ${attempt.error.message}` : `NOT refused — returned ${JSON.stringify(attempt.data)}`;
  process.stdout.write(`${refused ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}\n`);
}

async function anonCases(): Promise<void> {
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    process.stdout.write('SKIP  anon-key cases (SUPABASE_ANON_KEY not set in .env)\n');
    return;
  }
  const anon = createClient(process.env.SUPABASE_URL!, anonKey, { auth: { persistSession: false } });
  for (const table of ['customers', 'transactions', 'payouts', 'tool_calls', 'escalations']) {
    expectRefused(`anon key cannot read ${table}`, await anon.from(table).select('*').limit(1));
  }
  expectRefused('anon key cannot create a conversation', await anon.from('conversations').insert({ conversation_id: 'anon-probe', channel: 'text' }));
}

async function main(): Promise<void> {
  const conversationId = `guard-${Date.now()}`;
  must(await db().from('conversations').insert({ conversation_id: conversationId, channel: 'cli' }));
  process.stdout.write(`conversation ${conversationId}\n\n`);

  await anonCases();

  const logRow = mustRow(
    await db().from('tool_calls').insert({ conversation_id: conversationId, tool_name: 'guard_test', purpose: 'guard test', input_summary: {} }).select('id').single(),
  );
  must(await db().from('tool_calls').update({ status: 'ok', finished_at: new Date().toISOString() }).eq('id', logRow.id));
  expectRefused('a finalised tool_call cannot be rewritten', await db().from('tool_calls').update({ status: 'failed' }).eq('id', logRow.id), '23514');
  expectRefused('tool_calls rows cannot be deleted', await db().from('tool_calls').delete().eq('id', logRow.id), '42501');

  must(await db().from('conversations').update({ verified_customer_id: 'CUS-1001' }).eq('conversation_id', conversationId));
  expectRefused(
    'a verified conversation cannot switch to another customer',
    await db().from('conversations').update({ verified_customer_id: 'CUS-1003' }).eq('conversation_id', conversationId),
    '23514',
  );

  const ticket = { conversation_id: conversationId, category: 'payment', priority: 'normal', summary: 'guard test duplicate ticket' };
  must(await db().from('support_tickets').insert(ticket));
  expectRefused('a second open ticket in the same category is refused', await db().from('support_tickets').insert(ticket), '23505');
  expectRefused(
    'an unknown ticket priority is refused',
    await db().from('support_tickets').insert({ ...ticket, category: 'other', priority: 'critical' }),
    '23514',
  );
  expectRefused('support_tickets rows cannot be deleted', await db().from('support_tickets').delete().eq('conversation_id', conversationId), '42501');

  expectRefused(
    'an escalation with no contact details and no reason for their absence is refused',
    await db().from('escalations').insert({ conversation_id: conversationId, category: 'account', reason: 'guard test', contact_source: 'none' }),
    '23514',
  );
  expectRefused(
    'a transaction status outside the allowed set is refused',
    await db().from('transactions').update({ status: 'lost' }).eq('transaction_id', 'TXN-9001'),
    '23514',
  );

  process.stdout.write(`\n${failures === 0 ? 'all guards held' : `${failures} guard(s) did NOT hold`}\n`);
  if (failures > 0) process.exitCode = 1;
}

await main();
