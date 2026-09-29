import { z } from 'zod';
import { db, must } from '../../shared/db.js';
import { normalizeReference, STATUSES_REQUIRING_HUMAN } from '../../shared/domain.js';
import { defineTool, refused } from '../tool.js';
import { verifiedCustomerId } from '../verification.js';

// The linked transaction id is withheld too: the KB says customer-facing tools don't surface
// transaction identifiers the user didn't provide themselves.
const OWNER_ONLY_FIELDS = ['transaction_id', 'customer_id', 'recipient_name', 'amount', 'currency'];

interface PayoutRow {
  payout_id: string;
  transaction_id: string;
  customer_id: string;
  recipient_name: string;
  amount: number;
  currency: string;
  status: string;
  scheduled_for: string | null;
  failure_reason: string | null;
  // Payouts have no support_summary column; the linked transaction's customer-safe summary is used.
  transactions: { support_summary: string } | null;
}

export const lookupPayout = defineTool({
  name: 'lookup_payout',
  purpose: 'Get the customer-safe status of a contractor payout the caller referenced',
  description:
    'Look up a contractor payout by payout_id (e.g. PAY-7002) or by the transaction_id it belongs to. At least one is ' +
    'required. Returns status, scheduled date, a customer-safe failure reason and summary. Recipient, amount and ' +
    'linked references are included only if the caller has been verified as the owning customer. If ' +
    'requires_escalation is true, do not try to resolve it — escalate.',
  input: z.object({
    payout_id: z.string().trim().min(1).max(20).optional(),
    transaction_id: z.string().trim().min(1).max(20).optional(),
  }),
  async handler(ctx, args) {
    if (args.payout_id === undefined && args.transaction_id === undefined) {
      return refused('needs_reference', 'Ask the caller for the payout reference (PAY followed by four digits) or the transaction reference.');
    }
    const payoutId = args.payout_id === undefined ? undefined : normalizeReference('PAY', args.payout_id);
    const transactionId = args.transaction_id === undefined ? undefined : normalizeReference('TXN', args.transaction_id);
    if (payoutId === null || transactionId === null) {
      return refused('invalid_reference', 'That reference is not in the expected format. Ask the caller to repeat it.');
    }

    let query = db()
      .from('payouts')
      .select('payout_id, transaction_id, customer_id, recipient_name, amount, currency, status, scheduled_for, failure_reason, transactions(support_summary)')
      .limit(2);
    if (payoutId) query = query.eq('payout_id', payoutId);
    if (transactionId) query = query.eq('transaction_id', transactionId);

    const [rows, verified] = await Promise.all([query.then(must), verifiedCustomerId(ctx)]);
    const payouts = rows as unknown as PayoutRow[];

    if (payouts.length === 0) {
      return {
        status: 'not_found',
        result: {
          ok: true,
          found: false,
          message_for_agent: 'No payout matches that reference. Read it back to the caller and ask them to confirm it; do not guess a status.',
        },
        logSummary: { found: false, payout_id: payoutId ?? null, transaction_id: transactionId ?? null },
      };
    }
    if (payouts.length > 1) {
      return refused('ambiguous_match', 'More than one payout belongs to that transaction. Ask the caller for the payout reference.');
    }

    const payout = payouts[0]!;
    const isOwner = verified === payout.customer_id;

    return {
      status: 'ok',
      result: {
        ok: true,
        found: true,
        view: isOwner ? 'full' : 'limited',
        payout_id: payout.payout_id,
        status: payout.status,
        scheduled_for: payout.scheduled_for,
        failure_reason: payout.failure_reason,
        support_summary: payout.transactions?.support_summary ?? null,
        requires_escalation: STATUSES_REQUIRING_HUMAN.includes(payout.status),
        ...(isOwner
          ? {
              transaction_id: payout.transaction_id,
              customer_id: payout.customer_id,
              recipient_name: payout.recipient_name,
              amount: Number(payout.amount).toFixed(2),
              currency: payout.currency,
            }
          : { withheld_fields: OWNER_ONLY_FIELDS, withheld_reason: 'caller_not_verified_as_owner' }),
      },
      logSummary: { found: true, payout_id: payout.payout_id, status: payout.status, view: isOwner ? 'full' : 'limited' },
    };
  },
});
