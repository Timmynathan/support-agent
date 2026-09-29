import { z } from 'zod';
import { db, DbError, must, mustRow, UNIQUE_VIOLATION } from '../../shared/db.js';
import { CATEGORIES, normalizeReference, PRIORITIES } from '../../shared/domain.js';
import type { ToolContext } from '../context.js';
import { defineTool, refused } from '../tool.js';
import { customerForWrite } from '../verification.js';

export const createSupportTicket = defineTool({
  name: 'create_support_ticket',
  purpose: 'Record an issue for human support follow-up',
  description:
    'Create a support ticket for follow-up. The ticket is attached to this conversation, and to the verified customer ' +
    'if the caller has been verified. Only pass customer_id if it is that verified customer. Pass transaction_id if the ' +
    'caller gave one. Calling it again for the same category in the same conversation returns the existing open ticket ' +
    'instead of creating a duplicate.',
  input: z.object({
    customer_id: z.string().trim().min(1).max(20).optional(),
    transaction_id: z.string().trim().min(1).max(20).optional(),
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    summary: z.string().trim().min(10).max(1000),
  }),
  async handler(ctx, args) {
    const requestedCustomer = args.customer_id === undefined ? null : normalizeReference('CUS', args.customer_id);
    if (args.customer_id !== undefined && requestedCustomer === null) {
      return refused('invalid_customer_id', 'That customer ID is not valid. Create the ticket without customer_id.');
    }
    const customer = await customerForWrite(ctx, requestedCustomer);
    if (!customer.ok) {
      return refused(
        'customer_not_verified',
        'A ticket can only be attached to the customer verified in this conversation. Create it without customer_id, or verify the caller first.',
      );
    }

    let transactionId: string | null = null;
    if (args.transaction_id !== undefined) {
      transactionId = normalizeReference('TXN', args.transaction_id);
      if (!transactionId || !(await transactionExists(transactionId))) {
        return refused(
          'unknown_transaction',
          'That transaction reference does not exist. Confirm it with the caller, or create the ticket without it and put what they said in the summary.',
          { transaction_id_given: args.transaction_id },
        );
      }
    }

    const insert = await db()
      .from('support_tickets')
      .insert({
        conversation_id: ctx.conversationId,
        customer_id: customer.customerId,
        transaction_id: transactionId,
        category: args.category,
        priority: args.priority,
        summary: args.summary,
      })
      .select('ticket_id, status')
      .single();

    if (insert.error?.code === UNIQUE_VIOLATION) {
      const existing = await openTicketFor(ctx, args.category);
      return {
        status: 'ok',
        result: { ok: true, ticket_id: existing.ticket_id, status: existing.status, already_existed: true },
      };
    }
    const ticket = mustRow(insert);
    return {
      status: 'ok',
      result: { ok: true, ticket_id: ticket.ticket_id, status: ticket.status, already_existed: false },
      logSummary: {
        ticket_id: ticket.ticket_id,
        customer_id: customer.customerId,
        transaction_id: transactionId,
        category: args.category,
        priority: args.priority,
        already_existed: false,
      },
    };
  },
});

async function transactionExists(transactionId: string): Promise<boolean> {
  const row = must(await db().from('transactions').select('transaction_id').eq('transaction_id', transactionId).maybeSingle());
  return row !== null;
}

async function openTicketFor(ctx: ToolContext, category: string): Promise<{ ticket_id: string; status: string }> {
  const row = must(
    await db()
      .from('support_tickets')
      .select('ticket_id, status')
      .eq('conversation_id', ctx.conversationId)
      .eq('category', category)
      .neq('status', 'closed')
      .maybeSingle(),
  );
  if (!row) throw new DbError('unique violation reported but no open ticket found', 'inconsistent');
  return row as { ticket_id: string; status: string };
}
