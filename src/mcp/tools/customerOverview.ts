import { z } from 'zod';
import { db, must } from '../../shared/db.js';
import { defineTool, refused } from '../tool.js';
import { verifiedCustomerId } from '../verification.js';

// What the caller sees in their account panel: their own records and nothing else. Only the
// caller's page can call this (the agent is never given it), and only for a verified call.
const RECENT_LIMIT = 10;
const CONVERSATION_LIMIT = 5;
const TURNS_PER_CONVERSATION = 30;

export const customerOverview = defineTool({
  name: 'customer_overview',
  purpose: "Show a verified caller their own account, requests, payments and past conversations on their screen",
  description: "Serves the verified caller's own account panel. Not for the agent.",
  input: z.object({}),
  async handler(ctx) {
    if (ctx.source !== 'caller_page') return refused('not_for_agent', 'This tool serves the caller’s own screen only.');
    const customerId = await verifiedCustomerId(ctx);
    if (!customerId) return refused('verification_required', 'The caller is not verified.');

    const [customers, tickets, escalations, transactions, payouts, conversations] = await Promise.all([
      db().from('customers').select('company_name, contact_name, plan, account_status, kyc_status').eq('customer_id', customerId).limit(1).then(must),
      // Their account's tickets, plus any opened earlier in this call before they verified.
      db()
        .from('support_tickets')
        .select('ticket_id, category, priority, status, summary, transaction_id, created_at')
        .or(`customer_id.eq.${customerId},conversation_id.eq.${ctx.conversationId}`)
        .order('created_at', { ascending: false })
        .limit(RECENT_LIMIT)
        .then(must),
      // The reason text is the agent's internal note and can mention compliance detail: not shown.
      db()
        .from('escalations')
        .select('escalation_id, category, status, call_booked, preferred_time, created_at')
        .or(`customer_id.eq.${customerId},conversation_id.eq.${ctx.conversationId}`)
        .order('created_at', { ascending: false })
        .limit(RECENT_LIMIT)
        .then(must),
      db()
        .from('transactions')
        .select('transaction_id, transaction_type, amount, currency, destination_country, status, created_at, estimated_arrival, support_summary')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(RECENT_LIMIT)
        .then(must),
      db()
        .from('payouts')
        .select('payout_id, transaction_id, recipient_name, amount, currency, status, scheduled_for, failure_reason')
        .eq('customer_id', customerId)
        .order('scheduled_for', { ascending: false, nullsFirst: false })
        .limit(RECENT_LIMIT)
        .then(must),
      db()
        .from('conversations')
        .select('conversation_id, channel, started_at, ended_at, final_status')
        .or(`verified_customer_id.eq.${customerId},conversation_id.eq.${ctx.conversationId}`)
        .order('started_at', { ascending: false })
        .limit(CONVERSATION_LIMIT)
        .then(must),
    ]);

    const conversationRows = conversations as Array<{ conversation_id: string } & Record<string, unknown>>;
    const turns = conversationRows.length
      ? ((must(
          await db()
            .from('conversation_turns')
            .select('conversation_id, turn_index, user_transcript, assistant_response')
            .in('conversation_id', conversationRows.map((c) => c.conversation_id))
            .order('turn_index')
            .limit(CONVERSATION_LIMIT * TURNS_PER_CONVERSATION),
        ) ?? []) as Array<{ conversation_id: string; turn_index: number; user_transcript: string; assistant_response: string | null }>)
      : [];

    const account = (customers as Array<Record<string, unknown>>)[0];
    if (!account) return refused('account_unavailable', 'The verified account could not be found.');
    return {
      status: 'ok',
      result: {
        ok: true,
        customer_id: customerId,
        account,
        tickets,
        escalations,
        transactions: (transactions as Array<Record<string, unknown>>).map((t) => ({ ...t, amount: Number(t.amount).toFixed(2) })),
        payouts: (payouts as Array<Record<string, unknown>>).map((p) => ({ ...p, amount: Number(p.amount).toFixed(2) })),
        conversations: conversationRows.map((c) => ({
          ...c,
          current: c.conversation_id === ctx.conversationId,
          turns: turns.filter((t) => t.conversation_id === c.conversation_id).map(({ turn_index, user_transcript, assistant_response }) => ({ turn_index, user_transcript, assistant_response })),
        })),
      },
      // Counts only: the panel's contents are already the caller's own records.
      logSummary: {
        customer_id: customerId,
        tickets: (tickets as unknown[]).length,
        escalations: (escalations as unknown[]).length,
        transactions: (transactions as unknown[]).length,
        payouts: (payouts as unknown[]).length,
        conversations: conversationRows.length,
      },
    };
  },
});
