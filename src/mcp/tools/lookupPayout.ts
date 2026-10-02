import { z } from 'zod';
import { db, must } from '../../shared/db.js';
import { normalizeReference, STATUSES_REQUIRING_HUMAN } from '../../shared/domain.js';
import { defineTool, refused } from '../tool.js';
import { notOnThisAccount, verificationRequired, verifiedCustomerId } from '../verification.js';

// Only the verified owner of a payout learns anything about it, even its status.

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
    'required. Refuses if the caller is not verified, and only finds payouts on the verified caller\'s own account. ' +
    'Returns status, scheduled date, recipient, amount, a customer-safe failure reason and summary. If ' +
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

    const verified = await verifiedCustomerId(ctx);
    if (!verified) return verificationRequired();

    let query = db()
      .from('payouts')
      .select('payout_id, transaction_id, customer_id, recipient_name, amount, currency, status, scheduled_for, failure_reason, transactions(support_summary)')
      .limit(2);
    if (payoutId) query = query.eq('payout_id', payoutId);
    if (transactionId) query = query.eq('transaction_id', transactionId);

    const payouts = (must(await query) as unknown as PayoutRow[]).filter((payout) => payout.customer_id === verified);

    if (payouts.length === 0) return notOnThisAccount('payout');
    if (payouts.length > 1) {
      return refused('ambiguous_match', 'More than one payout belongs to that transaction. Ask the caller for the payout reference.');
    }

    const payout = payouts[0]!;

    return {
      status: 'ok',
      result: {
        ok: true,
        found: true,
        payout_id: payout.payout_id,
        status: payout.status,
        scheduled_for: payout.scheduled_for,
        failure_reason: payout.failure_reason,
        support_summary: payout.transactions?.support_summary ?? null,
        requires_escalation: STATUSES_REQUIRING_HUMAN.includes(payout.status),
        transaction_id: payout.transaction_id,
        customer_id: payout.customer_id,
        recipient_name: payout.recipient_name,
        amount: Number(payout.amount).toFixed(2),
        currency: payout.currency,
      },
      logSummary: { found: true, payout_id: payout.payout_id, status: payout.status },
    };
  },
});
