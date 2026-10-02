import { z } from 'zod';
import { db, must } from '../../shared/db.js';
import { normalizeReference, STATUSES_REQUIRING_HUMAN, todayIsoDate } from '../../shared/domain.js';
import { defineTool, refused } from '../tool.js';
import { notOnThisAccount, verificationRequired, verifiedCustomerId } from '../verification.js';

// Only the verified owner of a transaction learns anything about it, even its status.

interface TransactionRow {
  transaction_id: string;
  customer_id: string;
  transaction_type: string;
  amount: number;
  currency: string;
  status: string;
  estimated_arrival: string | null;
  support_summary: string;
}

export const lookupTransaction = defineTool({
  name: 'lookup_transaction',
  purpose: 'Get the customer-safe status of a transaction the caller referenced',
  description:
    'Look up one of the verified caller\'s own transactions by the reference they gave (e.g. TXN-9001). Refuses if the ' +
    'caller is not verified. Returns status, estimated arrival, amount and a customer-safe summary. Do not state an ' +
    'arrival time beyond estimated_arrival, and treat a null estimate as unknown.',
  input: z.object({
    transaction_id: z.string().trim().min(1).max(20),
  }),
  async handler(ctx, args) {
    const transactionId = normalizeReference('TXN', args.transaction_id);
    if (!transactionId) {
      return refused(
        'invalid_reference',
        'That transaction reference is not in the expected format (TXN followed by four digits). Ask the caller to repeat it.',
      );
    }

    const verified = await verifiedCustomerId(ctx);
    if (!verified) return verificationRequired();
    const row = must(
      await db()
        .from('transactions')
        .select('transaction_id, customer_id, transaction_type, amount, currency, status, estimated_arrival, support_summary')
        .eq('transaction_id', transactionId)
        .maybeSingle(),
    ) as TransactionRow | null;
    if (!row || row.customer_id !== verified) return notOnThisAccount('transaction');

    const arrivalPassed = row.estimated_arrival !== null && row.status !== 'completed' && row.estimated_arrival < todayIsoDate();

    return {
      status: 'ok',
      result: {
        ok: true,
        found: true,
        transaction_id: row.transaction_id,
        type: row.transaction_type,
        status: row.status,
        estimated_arrival: row.estimated_arrival,
        estimated_arrival_known: row.estimated_arrival !== null,
        estimated_arrival_passed: arrivalPassed,
        support_summary: row.support_summary,
        requires_escalation: STATUSES_REQUIRING_HUMAN.includes(row.status),
        customer_id: row.customer_id,
        amount: Number(row.amount).toFixed(2),
        currency: row.currency,
      },
      logSummary: { found: true, transaction_id: row.transaction_id, status: row.status },
    };
  },
});
