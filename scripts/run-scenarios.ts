// Runs the text-channel test scenarios from assets/test-scenarios.md against the running agent
// server (POST /chat, exactly as curl would), then prints the Supabase rows each conversation
// produced. Full replies and rows are also written to logs/ for review.
//
//   npm run server            (in another terminal)
//   npm run scenarios         (all)      npm run scenarios -- S2 S7   (some)
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, must } from '../src/shared/db.js';
import { maskEmail } from '../src/mcp/redact.js';

const BASE_URL = process.env.AGENT_URL ?? 'http://127.0.0.1:8787';

interface Scenario {
  id: string;
  name: string;
  turns: string[];
}

// Follow-up turns are what a caller would plausibly say next; the scenario file lists only the
// opening line. They are here so multi-step behaviour (clarify, then act) can be checked.
export const SCENARIOS: Scenario[] = [
  { id: 'S1', name: 'Knowledge-grounded answer', turns: ['What fees does RelayPay charge for international payments?'] },
  { id: 'S2', name: 'Clarifying question', turns: ['My payment is stuck.', "It's an incoming transfer. The reference is TXN-9005."] },
  { id: 'S3', name: 'Customer lookup', turns: ['I am Amara from LagosLedger. Can you check my account?'] },
  { id: 'S4', name: 'Transaction lookup', turns: ['Can you check transaction TXN-9001?'] },
  {
    id: 'S5',
    name: 'Payout lookup',
    turns: ['What is happening with payout PAY-7002?', "I'm Efua Mensah from AccraStack. Tomorrow afternoon works for a call."],
  },
  {
    id: 'S6',
    name: 'Ticket creation',
    turns: ['My invoice payment failed and I need someone to look at it.', "I don't have the reference with me. Please just log it so someone can check."],
  },
  {
    id: 'S7',
    name: 'Human escalation',
    turns: ['My account was restricted and nobody is helping me.', 'Daniel Mwangi, daniel@nairobiops.example, tomorrow at 10am.'],
  },
  { id: 'S8', name: 'Unsupported question (guarantee)', turns: ['Can RelayPay guarantee my payout arrives by 9am tomorrow?'] },
  { id: 'U1', name: 'Unsupported question (not in KB)', turns: ['What interest rate do you pay on balances?'] },
];

async function post(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function rowsFor(conversationId: string) {
  const q = (table: string, columns: string, order = 'created_at') =>
    db().from(table).select(columns).eq('conversation_id', conversationId).order(order).then(must).then((rows) => (rows ?? []) as unknown[]);
  const [conversation, turns, retrievals, toolCalls, tickets, escalations, events] = await Promise.all([
    db().from('conversations').select('conversation_id, channel, verified_customer_id, final_status, summary').eq('conversation_id', conversationId).single().then(must),
    q('conversation_turns', 'turn_index, answer_type, confidence_note'),
    q('retrieval_logs', 'query, chunk_ids, result_count'),
    q('tool_calls', 'tool_name, status, input_summary, error_message, duration_ms', 'started_at'),
    q('support_tickets', 'ticket_id, category, priority, customer_id, transaction_id, summary, status'),
    q('escalations', 'escalation_id, category, customer_id, user_name, user_email, contact_source, call_booked, preferred_time, reason, status'),
    q('conversation_events', 'event_type, summary, metadata'),
  ]);
  const maskedEscalations = (escalations as any[]).map((row) => ({ ...row, user_email: row.user_email ? maskEmail(row.user_email) : row.user_email }));
  return { conversation, turns, retrievals, toolCalls, tickets, escalations: maskedEscalations, events };
}

function printScenario(scenario: Scenario, replies: any[], rows: Awaited<ReturnType<typeof rowsFor>>): void {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out(`\n${'═'.repeat(78)}\n${scenario.id} ${scenario.name}   [${replies[0]?.conversation_id}]`);
  scenario.turns.forEach((text, i) => {
    const r = replies[i];
    out(`\n  caller: ${text}`);
    out(`  agent (${r.answer_type}): ${r.reply}`);
    const detail = [
      r.tools.length ? `tools: ${r.tools.map((t: any) => `${t.name}→${t.outcome}`).join(', ')}` : null,
      r.cited_chunk_ids.length ? `cited: ${r.cited_chunk_ids.join(', ')}` : null,
      r.triggers.length ? `triggers: ${r.triggers.join(', ')}` : null,
      r.enforced.length ? `ENFORCED: ${r.enforced.join(', ')}` : null,
      `${r.timings_ms.total} ms (api ${r.timings_ms.model_api ?? '—'})`,
      r.cost_usd === null ? 'cost —' : `$${r.cost_usd.toFixed(4)}`,
    ].filter(Boolean);
    out(`    ${detail.join(' | ')}`);
  });
  const c = rows.conversation as any;
  out(`\n  rows: conversation final_status=${c.final_status} verified=${c.verified_customer_id ?? '—'}`);
  out(`        turns=${rows.turns.length} retrieval_logs=${rows.retrievals.length} tool_calls=${rows.toolCalls.length} tickets=${rows.tickets.length} escalations=${rows.escalations.length} events=${rows.events.length}`);
  for (const t of rows.toolCalls as any[]) out(`        tool_call  ${t.tool_name} ${t.status} ${JSON.stringify(t.input_summary)} ${t.duration_ms} ms`);
  for (const t of rows.tickets as any[]) out(`        ticket     ${t.ticket_id} ${t.category}/${t.priority} customer=${t.customer_id ?? '—'} txn=${t.transaction_id ?? '—'} "${t.summary}"`);
  for (const e of rows.escalations as any[]) out(`        escalation ${e.escalation_id} ${e.category} customer=${e.customer_id ?? '—'} name=${e.user_name ?? '—'} email=${e.user_email ?? '—'} source=${e.contact_source} booked=${e.call_booked} time=${e.preferred_time ?? '—'}`);
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const scenarios = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
  const report: unknown[] = [];

  for (const scenario of scenarios) {
    const replies: any[] = [];
    let conversationId: string | undefined;
    for (const text of scenario.turns) {
      const reply = await post('/chat', conversationId ? { conversation_id: conversationId, message: text } : { message: text });
      conversationId = reply.conversation_id;
      replies.push(reply);
    }
    await post('/chat/end', { conversation_id: conversationId });
    const rows = await rowsFor(conversationId!);
    printScenario(scenario, replies, rows);
    report.push({ scenario, replies, rows });
  }

  const path = resolve(import.meta.dirname, `../logs/scenario-run-${Date.now()}.json`);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2));
  process.stdout.write(`\nfull replies and rows: ${path}\n`);
}

await main();
