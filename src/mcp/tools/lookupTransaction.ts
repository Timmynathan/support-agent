import { z } from 'zod';
import { db, must } from '../../shared/db.js';
import { normalizeReference, STATUSES_REQUIRING_HUMAN, todayIsoDate } from '../../shared/domain.js';
import { defineTool, refused } from '../tool.js';
import { verifiedCustomerId } from '../verification.js';

// Anyone who quotes a transaction reference gets the customer-safe status. Amount, currency and
// owner are only returned once the caller has verified as the owning customer in this
// conversation (kickoff point E).
const OWNER_ONLY_FIELDS = ['customer_id', 'amount', 'currency'];

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
    'Look up a transaction by the reference the caller gave (e.g. TXN-9001). Returns its status and customer-safe ' +
    'summary. Amount and currency are included only if the caller has already been verified as the owning customer ' +
    'via lookup_customer. Do not state an arrival time beyond estimated_arrival, and treat a null estimate as unknown.',
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

    const [rows, verified] = await Promise.all([
      db()
        .from('transactions')
        .select('transaction_id, customer_id, transaction_type, amount, currency, status, estimated_arrival, support_summary')
        .eq('transaction_id', transactionId)
        .maybeSingle()
        .then(must),
      verifiedCustomerId(ctx),
    ]);
    const row = rows as TransactionRow | null;

    if (!row) {
      return {
        status: 'not_found',
        result: {
          ok: true,
          found: false,
          transaction_id: transactionId,
          message_for_agent: 'No transaction has that reference. Read the reference back to the caller and ask them to confirm it; do not guess a status.',
        },
      };
    }

    const isOwner = verified === row.customer_id;
    const arrivalPassed = row.estimated_arrival !== null && row.status !== 'completed' && row.estimated_arrival < todayIsoDate();

    return {
      status: 'ok',
      result: {
        ok: true,
        found: true,
        view: isOwner ? 'full' : 'limited',
        transaction_id: row.transaction_id,
        type: row.transaction_type,
        status: row.status,
        estimated_arrival: row.estimated_arrival,
        estimated_arrival_known: row.estimated_arrival !== null,
        estimated_arrival_passed: arrivalPassed,
        support_summary: row.support_summary,
        requires_escalation: STATUSES_REQUIRING_HUMAN.includes(row.status),
        ...(isOwner
          ? { customer_id: row.customer_id, amount: Number(row.amount).toFixed(2), currency: row.currency }
          : { withheld_fields: OWNER_ONLY_FIELDS, withheld_reason: 'caller_not_verified_as_owner' }),
      },
      logSummary: { found: true, transaction_id: row.transaction_id, status: row.status, view: isOwner ? 'full' : 'limited' },
    };
  },
});
