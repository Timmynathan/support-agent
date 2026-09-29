import { z } from 'zod';
import { db, DbError, must, mustRow, UNIQUE_VIOLATION } from '../../shared/db.js';
import { CATEGORIES, normalizeReference } from '../../shared/domain.js';
import type { ToolContext } from '../context.js';
import { defineTool, refused } from '../tool.js';
import { customerForWrite } from '../verification.js';

interface Contact {
  user_name: string | null;
  user_email: string | null;
  contact_source: 'caller' | 'verified_record' | 'mixed' | 'none';
  contact_missing_reason: string | null;
}

export const createEscalation = defineTool({
  name: 'create_escalation',
  purpose: 'Hand the conversation to a human specialist and record the callback request',
  description:
    'Escalate to human support. Use for account restrictions, compliance or verification concerns, disputes, refunds, ' +
    'cancellations, a frustrated caller, or anything the knowledge base does not cover. Map refunds and cancellations ' +
    'to category "dispute". If the caller is verified, their name and email are taken from the account record, so ' +
    'do not ask them to spell an email. preferred_time is the caller\'s own words. Speak follow_up_summary to the ' +
    'caller; never read back their email. One open escalation per conversation — calling again returns the existing one.',
  input: z.object({
    ticket_id: z.string().trim().min(1).max(20).optional(),
    customer_id: z.string().trim().min(1).max(20).optional(),
    user_name: z.string().trim().min(1).max(120).optional(),
    user_email: z.email().max(254).optional(),
    category: z.enum(CATEGORIES),
    reason: z.string().trim().min(5).max(1000),
    preferred_time: z.string().trim().min(1).max(120).optional(),
  }),
  async handler(ctx, args) {
    const requestedCustomer = args.customer_id === undefined ? null : normalizeReference('CUS', args.customer_id);
    if (args.customer_id !== undefined && requestedCustomer === null) {
      return refused('invalid_customer_id', 'That customer ID is not valid. Escalate without customer_id.');
    }
    const customer = await customerForWrite(ctx, requestedCustomer);
    if (!customer.ok) {
      return refused(
        'customer_not_verified',
        'An escalation can only be attached to the customer verified in this conversation. Escalate without customer_id.',
      );
    }

    let ticketId: string | null = null;
    if (args.ticket_id !== undefined) {
      ticketId = normalizeReference('TKT', args.ticket_id);
      if (!ticketId || !(await ticketBelongsToConversation(ctx, ticketId))) {
        return refused('unknown_ticket', 'That ticket is not one created in this conversation. Escalate without ticket_id.');
      }
    }

    const contact = await resolveContact(args.user_name ?? null, args.user_email ?? null, customer.customerId);

    const insert = await db()
      .from('escalations')
      .insert({
        conversation_id: ctx.conversationId,
        ticket_id: ticketId,
        customer_id: customer.customerId,
        ...contact,
        category: args.category,
        reason: args.reason,
        // A callback counts as booked only when the caller gave a time to book it for.
        call_booked: args.preferred_time !== undefined,
        preferred_time: args.preferred_time ?? null,
      })
      .select('escalation_id, status, preferred_time, user_name, user_email')
      .single();

    if (insert.error?.code === UNIQUE_VIOLATION) {
      const existing = await openEscalationFor(ctx);
      return {
        status: 'ok',
        result: {
          ok: true,
          escalation_id: existing.escalation_id,
          status: existing.status,
          already_existed: true,
          follow_up_summary: followUpSummary(existing),
        },
      };
    }
    const escalation = mustRow(insert) as EscalationSummaryRow;
    return {
      status: 'ok',
      result: {
        ok: true,
        escalation_id: escalation.escalation_id,
        status: escalation.status,
        already_existed: false,
        follow_up_summary: followUpSummary(escalation),
        ...(contact.contact_source === 'none'
          ? {
              message_for_agent:
                'No contact details are on this escalation, so nobody can call back yet. Ask for a name and email, ' +
                'or tell the caller they can also reach support through the RelayPay dashboard.',
            }
          : {}),
      },
      logSummary: {
        escalation_id: escalation.escalation_id,
        category: args.category,
        customer_id: customer.customerId,
        ticket_id: ticketId,
        contact_source: contact.contact_source,
        call_booked: args.preferred_time !== undefined,
        already_existed: false,
      },
    };
  },
});

// Caller-given details win (they may want a different callback address); gaps are filled from
// the verified record; anything still missing is recorded as missing, with the reason why.
async function resolveContact(name: string | null, email: string | null, verifiedCustomerId: string | null): Promise<Contact> {
  let recordName: string | null = null;
  let recordEmail: string | null = null;
  if (verifiedCustomerId && (!name || !email)) {
    const row = mustRow(
      await db().from('customers').select('contact_name, contact_email').eq('customer_id', verifiedCustomerId).single(),
    ) as { contact_name: string; contact_email: string };
    recordName = row.contact_name;
    recordEmail = row.contact_email;
  }

  const userName = name ?? recordName;
  const userEmail = email ?? recordEmail;
  const fromCaller = [name, email].filter((v) => v !== null).length;
  const fromRecord = [!name && recordName, !email && recordEmail].filter(Boolean).length;
  const source: Contact['contact_source'] =
    fromCaller === 0 && fromRecord === 0 ? 'none' : fromRecord === 0 ? 'caller' : fromCaller === 0 ? 'verified_record' : 'mixed';

  const complete = userName !== null && userEmail !== null;
  return {
    user_name: userName,
    user_email: userEmail,
    contact_source: source,
    contact_missing_reason: complete
      ? null
      : verifiedCustomerId
        ? 'caller_did_not_provide_and_record_incomplete'
        : 'caller_not_verified_and_did_not_provide',
  };
}

interface EscalationSummaryRow {
  escalation_id: string;
  status: string;
  preferred_time: string | null;
  user_name: string | null;
  user_email: string | null;
}

// Built in code so the spoken confirmation never promises a timeline or outcome
// (escalation-rules.md: "must not ... provide timelines ... promise specific outcomes").
function followUpSummary(row: EscalationSummaryRow): string {
  const reference = `Your reference is ${row.escalation_id}.`;
  if (!row.user_name || !row.user_email) {
    return `I've passed this to a RelayPay support specialist. ${reference}`;
  }
  const when = row.preferred_time ? `, and I've noted that you asked for ${row.preferred_time}` : '';
  return `A RelayPay support specialist will follow up with you${when}. ${reference}`;
}

async function ticketBelongsToConversation(ctx: ToolContext, ticketId: string): Promise<boolean> {
  const row = must(
    await db().from('support_tickets').select('ticket_id').eq('ticket_id', ticketId).eq('conversation_id', ctx.conversationId).maybeSingle(),
  );
  return row !== null;
}

async function openEscalationFor(ctx: ToolContext): Promise<EscalationSummaryRow> {
  const row = must(
    await db()
      .from('escalations')
      .select('escalation_id, status, preferred_time, user_name, user_email')
      .eq('conversation_id', ctx.conversationId)
      .neq('status', 'closed')
      .maybeSingle(),
  );
  if (!row) throw new DbError('unique violation reported but no open escalation found', 'inconsistent');
  return row as EscalationSummaryRow;
}
