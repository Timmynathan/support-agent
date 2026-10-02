// Runs the text-channel test scenarios from assets/test-scenarios.md against the running agent
// server (POST /chat, exactly as curl would), then prints the Supabase rows each conversation
// produced. Full replies and rows are also written to logs/ for review.
//
// Each scenario is judged by checks in code against the replies AND the rows actually stored
// (never by reading the reply), and the verdict is saved to the evaluations table, numbered as
// the PRD's testing list (1-9). Test 8, voice, is recorded by scripts/voice-sim.ts.
//
//   npm run server            (in another terminal)
//   npm run scenarios         (all)      npm run scenarios -- S2 S7   (some)
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, must } from '../src/shared/db.js';
import { maskEmail } from '../src/mcp/redact.js';

const BASE_URL = process.env.AGENT_URL ?? 'http://127.0.0.1:8787';

type Rows = Awaited<ReturnType<typeof rowsFor>>;

interface Scenario {
  id: string;
  name: string;
  turns: string[];
  // The PRD testing item this scenario evidences, and what it expects.
  prd: number;
  expected: string;
  // Returns every way the run fell short; empty means passed.
  check(replies: any[], rows: Rows): string[];
}

const toolsUsed = (replies: any[]) => replies.flatMap((r) => r.tools as Array<{ name: string; outcome: string }>);
const usedOk = (replies: any[], name: string) => toolsUsed(replies).some((t) => t.name === name && t.outcome === 'ok');
const problems = (...checks: Array<[boolean, string]>) => checks.filter(([ok]) => !ok).map(([, why]) => why);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Follow-up turns are what a caller would plausibly say next; the scenario file lists only the
// opening line. They are here so multi-step behaviour (clarify, then act) can be checked.
export const SCENARIOS: Scenario[] = [
  {
    id: 'S1',
    name: 'Knowledge-grounded answer',
    turns: ['What fees does RelayPay charge for international payments?'],
    prd: 1,
    expected: 'Answers from the approved knowledge base (fees depend on corridor, method etc.; fees are shown before confirming), cites it, and invents no exact fee.',
    check: (r) => problems([r[0].answer_type === 'answer', 'not answered'], [r[0].cited_chunk_ids.length > 0, 'no knowledge chunk cited'], [!/\d+(\.\d+)?\s?%|\$\s?\d/.test(r[0].reply), 'states a specific fee']),
  },
  {
    id: 'S2',
    name: 'Clarifying question',
    turns: ['My payment is stuck.', "It's an incoming transfer. The reference is TXN-9005."],
    prd: 2,
    expected: 'Asks whether it is an incoming transfer, outgoing payout or invoice payment, and for a reference, before giving any status; then looks it up.',
    check: (r) => problems([r[0].answer_type === 'clarify', 'first reply is not a clarifying question'], [r[0].tools.length === 0, 'looked something up before clarifying'], [usedOk(r, 'lookup_transaction'), 'did not look up the transaction once clarified']),
  },
  {
    id: 'S3',
    name: 'Customer lookup',
    turns: ['I am Amara from LagosLedger. Can you check my account?'],
    prd: 3,
    expected: 'Uses the MCP customer lookup with the two details given, verifies the caller, and shares only safe account information (no email or internal notes).',
    check: (r, rows) => problems([usedOk(r, 'lookup_customer'), 'customer lookup did not succeed'], [(rows.conversation as any).verified_customer_id === 'CUS-1001', 'conversation not verified as CUS-1001'], [!EMAIL.test(r[0].reply), 'reply contains an email address']),
  },
  {
    id: 'S4',
    name: 'Transaction lookup (TXN-9001)',
    turns: ['Can you check transaction TXN-9001?'],
    prd: 4,
    expected: 'Uses the MCP transaction lookup and gives the customer-safe status without promising an arrival time beyond the record.',
    check: (r) => problems([usedOk(r, 'lookup_transaction'), 'transaction lookup did not succeed'], [r[0].answer_type === 'answer', 'did not answer'], [/processing/i.test(r[0].reply), 'does not report the recorded status (processing)']),
  },
  {
    id: 'S5',
    name: 'Payout lookup (PAY-7002)',
    turns: ['What is happening with payout PAY-7002?', "I'm Efua Mensah from AccraStack. Tomorrow afternoon works for a call."],
    prd: 4,
    expected: 'Uses the MCP payout lookup, identifies that the payout requires review, and escalates because it involves compliance review.',
    check: (r, rows) => problems([usedOk(r, 'lookup_payout'), 'payout lookup did not succeed'], [r[0].answer_type === 'escalate', 'did not escalate the review'], [rows.escalations.length === 1, 'no escalation record']),
  },
  {
    id: 'S6',
    name: 'Ticket creation',
    turns: ['My invoice payment failed and I need someone to look at it.', "I don't have the reference with me. Please just log it so someone can check."],
    prd: 5,
    expected: 'Asks for the reference if missing, then creates a support ticket through the MCP server, stored in Supabase, and tells the caller its reference.',
    check: (r, rows) => {
      const ticket = (rows.tickets as any[])[0];
      return problems([r[0].answer_type === 'clarify', 'did not ask for the reference first'], [rows.tickets.length === 1, `expected 1 ticket row, found ${rows.tickets.length}`], [!!ticket && r.at(-1).reply.includes(ticket.ticket_id), 'reply does not give the stored ticket reference']);
    },
  },
  {
    id: 'S7',
    name: 'Human escalation',
    turns: ['My account was restricted and nobody is helping me.', 'Daniel Mwangi, daniel@nairobiops.example, tomorrow at 10am.'],
    prd: 6,
    expected: 'Escalates to human support, collects name, email and callback time, and creates an escalation record, without explaining internal compliance decisions.',
    check: (r, rows) => {
      const esc = (rows.escalations as any[])[0];
      return problems([r[0].answer_type === 'escalate', 'did not escalate'], [!!esc, 'no escalation record'], [!!esc?.user_name && !!esc?.user_email, 'escalation is missing contact details'], [!!esc?.call_booked, 'callback time not recorded'], [!!esc && r.at(-1).reply.includes(esc.escalation_id), 'reply does not give the stored escalation reference']);
    },
  },
  {
    id: 'S8',
    name: 'Unsupported question (guarantee)',
    turns: ['Can RelayPay guarantee my payout arrives by 9am tomorrow?'],
    prd: 7,
    expected: 'Declines to guarantee the outcome, using only approved knowledge about payout timelines.',
    check: (r) => problems([/\b(can'?t|cannot|not able to|unable to|no,)\b/i.test(r[0].reply), 'does not decline the guarantee'], [r[0].answer_type === 'decline' || r[0].cited_chunk_ids.length > 0, 'answered without citing approved knowledge']),
  },
  {
    id: 'U1',
    name: 'Unsupported question (not in knowledge base)',
    turns: ['What interest rate do you pay on balances?'],
    prd: 7,
    expected: 'Says it cannot confidently answer (or escalates) because the knowledge base does not cover it, and states no rate.',
    check: (r) => problems([r[0].answer_type === 'decline' || r[0].answer_type === 'escalate', 'did not decline or escalate'], [!/\d+(\.\d+)?\s?%/.test(r[0].reply), 'states a rate']),
  },
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

function loggingProblems(id: string, replies: any[], rows: Rows): string[] {
  const conversation = rows.conversation as any;
  const loggedTools = toolsUsed(replies).filter((t) => t.outcome !== 'rejected').length;
  // Every turn individually: its reply stored, and its outcome recorded as a decision or, for a
  // turn that failed, as an error.
  const perTurn = replies.flatMap((reply, i): Array<[boolean, string]> => [
    [(rows.turns as any[]).some((t) => t.turn_index === i && t.answer_type !== null), `${id}: turn ${i} has no stored reply`],
    [
      (rows.events as any[]).some((e) => (e.event_type === 'decision' || e.event_type === 'error') && e.metadata?.turn_index === i),
      `${id}: turn ${i} has no decision or error event`,
    ],
  ]);
  return problems(
    [conversation.final_status !== 'in_progress', `${id}: conversation not closed`],
    [rows.turns.length === replies.length, `${id}: ${rows.turns.length} turn rows for ${replies.length} replies`],
    [rows.retrievals.length === replies.length, `${id}: ${rows.retrievals.length} retrieval rows for ${replies.length} turns`],
    [rows.toolCalls.length === loggedTools, `${id}: ${rows.toolCalls.length} tool-call rows for ${loggedTools} tool calls`],
    ...perTurn,
  );
}

async function recordEvaluation(row: { scenario_number: number; scenario_name: string; conversation_id: string | null; expected_behavior: string; actual_behavior: string; passed: boolean; notes: string | null }): Promise<void> {
  must(await db().from('evaluations').insert(row));
}

function describeRun(replies: any[]): string {
  return replies
    .map((r) => `(${r.answer_type}${r.tools.length ? `; ${r.tools.map((t: any) => `${t.name}→${t.outcome}`).join(', ')}` : ''}) ${r.reply}`)
    .join(' ⟶ ')
    .slice(0, 1000);
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const scenarios = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
  const report: unknown[] = [];
  const logging: string[] = [];
  const logged: object[] = [];
  let failures = 0;

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
    const failed = scenario.check(replies, rows);
    logging.push(...loggingProblems(scenario.id, replies, rows));
    logged.push({ turns: rows.turns.length, retrievals: rows.retrievals.length, toolCalls: rows.toolCalls.length, tickets: rows.tickets.length, escalations: rows.escalations.length, events: rows.events.length });
    await recordEvaluation({
      scenario_number: scenario.prd,
      scenario_name: `${scenario.name} [${scenario.id}]`,
      conversation_id: conversationId!,
      expected_behavior: scenario.expected,
      actual_behavior: describeRun(replies),
      passed: failed.length === 0,
      notes: failed.length ? `Failed checks: ${failed.join('; ')}` : null,
    });
    process.stdout.write(`\n  EVALUATION (PRD test ${scenario.prd}): ${failed.length === 0 ? 'PASS' : `FAIL: ${failed.join('; ')}`}\n`);
    report.push({ scenario, replies, rows, failed });
    if (failed.length) failures++;
  }

  // PRD test 9: every conversation's stored rows match what the agent reported doing.
  const totals = Object.fromEntries(['turns', 'retrievals', 'toolCalls', 'tickets', 'escalations', 'events'].map((k) => [k, logged.reduce((sum, row: any) => sum + row[k], 0)]));
  await recordEvaluation({
    scenario_number: 9,
    scenario_name: `Logging [${scenarios.map((x) => x.id).join(', ')}]`,
    conversation_id: null,
    expected_behavior: 'Supabase holds conversation, retrieval, MCP tool-call, ticket, escalation and evaluation records that match the test run.',
    actual_behavior: `${scenarios.length} conversations; rows: ${JSON.stringify(totals)}; ${scenarios.length} evaluation rows written (plus this one).`,
    passed: logging.length === 0,
    notes: logging.length ? `Mismatches: ${logging.join('; ')}` : null,
  });
  process.stdout.write(`\nEVALUATION (PRD test 9, logging): ${logging.length === 0 ? 'PASS' : `FAIL: ${logging.join('; ')}`}\n`);
  if (logging.length) failures++;

  const path = resolve(import.meta.dirname, `../logs/scenario-run-${Date.now()}.json`);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2));
  process.stdout.write(`\nfull replies and rows: ${path}\n${failures ? `${failures} evaluation(s) FAILED` : 'all evaluations passed'}; verdicts saved to the evaluations table\n`);
  process.exitCode = failures ? 1 : 0;
}

await main();
