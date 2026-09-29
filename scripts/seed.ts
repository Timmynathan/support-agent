// Loads assets/seed-data/ into customers, transactions and payouts. Idempotent: upserts on the
// primary key, so a second run changes nothing. Then re-reads every row and compares it with the
// CSV field by field — a clean exit means the data matches, not merely that nothing threw.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { db, must } from '../src/shared/db.js';
import { parseCsv } from './csv.js';

const SEED_DIR = resolve(import.meta.dirname, '../assets/seed-data');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, string | number | null>;

interface TableSpec {
  table: string;
  file: string;
  key: string;
  toRow(csv: Record<string, string>, line: number): Row;
}

// Blank CSV cells are unknown values, so they become NULL — never '' and never 0.
const blankToNull = (value: string): string | null => (value === '' ? null : value);

function requiredDate(value: string, field: string, line: number): string {
  if (!ISO_DATE.test(value)) throw new Error(`${field} on row ${line} is not a YYYY-MM-DD date: "${value}"`);
  return value;
}

function optionalDate(value: string, field: string, line: number): string | null {
  return value === '' ? null : requiredDate(value, field, line);
}

function positiveAmount(value: string, line: number): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`amount on row ${line} is not a positive number: "${value}"`);
  return amount;
}

const TABLES: TableSpec[] = [
  {
    table: 'customers',
    file: 'customers.csv',
    key: 'customer_id',
    toRow: (c) => ({
      customer_id: c.customer_id!,
      company_name: c.company_name!,
      contact_name: c.contact_name!,
      contact_email: c.contact_email!,
      plan: c.plan!,
      account_status: c.account_status!,
      region: c.region!,
      kyc_status: c.kyc_status!,
      support_notes: blankToNull(c.support_notes!),
    }),
  },
  {
    table: 'transactions',
    file: 'transactions.csv',
    key: 'transaction_id',
    toRow: (c, line) => ({
      transaction_id: c.transaction_id!,
      customer_id: c.customer_id!,
      transaction_type: c.transaction_type!,
      amount: positiveAmount(c.amount!, line),
      currency: c.currency!,
      destination_country: blankToNull(c.destination_country!),
      status: c.status!,
      created_at: requiredDate(c.created_at!, 'created_at', line),
      estimated_arrival: optionalDate(c.estimated_arrival!, 'estimated_arrival', line),
      support_summary: c.support_summary!,
    }),
  },
  {
    table: 'payouts',
    file: 'payouts.csv',
    key: 'payout_id',
    toRow: (c, line) => ({
      payout_id: c.payout_id!,
      transaction_id: c.transaction_id!,
      customer_id: c.customer_id!,
      recipient_name: c.recipient_name!,
      amount: positiveAmount(c.amount!, line),
      currency: c.currency!,
      status: c.status!,
      scheduled_for: optionalDate(c.scheduled_for!, 'scheduled_for', line),
      failure_reason: blankToNull(c.failure_reason!),
    }),
  },
];

async function loadRows(spec: TableSpec): Promise<Row[]> {
  const text = await readFile(resolve(SEED_DIR, spec.file), 'utf8');
  return parseCsv(text, spec.file).map((csv, index) => spec.toRow(csv, index + 2));
}

function sameValue(expected: Row[string], actual: unknown): boolean {
  if (expected === null) return actual === null;
  if (typeof expected === 'number') return Number(actual) === expected;
  return String(actual).trim() === expected;
}

async function verify(spec: TableSpec, expected: Row[]): Promise<string[]> {
  const ids = expected.map((row) => row[spec.key] as string);
  const stored = must(await db().from(spec.table).select(Object.keys(expected[0]!).join(', ')).in(spec.key, ids)) as unknown as Row[];
  const byId = new Map(stored.map((row) => [row[spec.key] as string, row]));
  const problems: string[] = [];
  for (const row of expected) {
    const id = row[spec.key] as string;
    const actual = byId.get(id);
    if (!actual) {
      problems.push(`${id}: missing after upsert`);
      continue;
    }
    for (const [field, value] of Object.entries(row)) {
      if (!sameValue(value, actual[field])) problems.push(`${id}.${field}: expected ${JSON.stringify(value)}, stored ${JSON.stringify(actual[field])}`);
    }
  }
  return problems;
}

async function tableCount(table: string): Promise<number> {
  const { count, error } = await db().from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main(): Promise<void> {
  let failed = false;
  // Order matters: transactions reference customers, payouts reference both.
  for (const spec of TABLES) {
    const rows = await loadRows(spec);
    must(await db().from(spec.table).upsert(rows, { onConflict: spec.key }));
    const problems = await verify(spec, rows);
    const total = await tableCount(spec.table);
    const extra = total - rows.length;
    const verdict = problems.length === 0 ? 'OK' : 'MISMATCH';
    process.stdout.write(
      `${spec.table.padEnd(13)} csv=${rows.length}  in_table=${total}  verified=${rows.length - new Set(problems.map((p) => p.split(/[.:]/)[0])).size}/${rows.length}  ${verdict}` +
        (extra > 0 ? `  (${extra} row(s) in table not from the seed file)` : '') +
        '\n',
    );
    for (const problem of problems) process.stdout.write(`    ${problem}\n`);
    if (problems.length > 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}

await main();
