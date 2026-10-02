import { z } from 'zod';
import { db, must } from '../../shared/db.js';
import { customerHandling, normalizeReference } from '../../shared/domain.js';
import type { ToolContext } from '../context.js';
import { defineTool, refused, type ToolOutcome } from '../tool.js';
import { bindVerifiedCustomer, verifiedCustomerId } from '../verification.js';

// A caller proves who they are only by typing all three into the secure form: something the
// account has (its ID), its contact's full name, and its email. Saying a name and a company
// is not enough: both are easy to find. The agent itself can never verify anyone.
export const MAX_VERIFICATION_ATTEMPTS = 3;

// support_notes are internal (schema guide: "Short internal support note") and contact details
// are personal; neither is given to the model. The model gets derived flags instead.
const WITHHELD_FIELDS = ['support_notes', 'contact_name', 'contact_email', 'region'];

interface CustomerRow {
  customer_id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  plan: string;
  account_status: string;
  kyc_status: string;
  email_key: string;
}
const COLUMNS = 'customer_id, company_name, contact_name, contact_email, plan, account_status, kyc_status, email_key';

const input = z.object({
  customer_id: z.string().trim().min(1).max(20).optional(),
  contact_name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().min(3).max(254).optional(),
});
type Input = z.infer<typeof input>;

export const lookupCustomer = defineTool({
  name: 'lookup_customer',
  purpose: 'Verify a caller from the secure form, or return the verified caller’s own account summary',
  description:
    'Returns the account summary of the caller verified in this conversation (call it with no input). It cannot verify ' +
    'anyone: callers verify themselves by typing their customer ID, full name and email into the secure form on screen. ' +
    'If the caller is not verified it refuses; then ask them to fill in that form. Never ask for those details aloud.',
  input,
  async handler(ctx, args) {
    return ctx.source === 'caller_page' ? verifyFromForm(ctx, args) : verifiedAccountSummary(ctx);
  },
});

function summary(customer: CustomerRow, bind: string): ToolOutcome {
  return {
    status: 'ok',
    result: {
      ok: true,
      found: true,
      customer_id: customer.customer_id,
      company_name: customer.company_name,
      plan: customer.plan,
      account_status: customer.account_status,
      kyc_status: customer.kyc_status,
      ...customerHandling(customer.account_status, customer.kyc_status),
      verified_for_conversation: true,
      withheld_fields: WITHHELD_FIELDS,
    },
    logSummary: { found: true, customer_id: customer.customer_id, verification: bind, source: 'agent' },
  };
}

async function verifiedAccountSummary(ctx: ToolContext): Promise<ToolOutcome> {
  const verified = await verifiedCustomerId(ctx);
  if (!verified) {
    return refused(
      'verification_required',
      'The caller is not verified. Ask them to fill in their customer ID, full name and email in the verification form ' +
        'on screen (set ask_to_type to verification). Do not ask for these details aloud and do not share account details.',
    );
  }
  const [customer] = must(await db().from('customers').select(COLUMNS).eq('customer_id', verified).limit(1)) as CustomerRow[];
  if (!customer) return refused('account_unavailable', 'The verified account could not be found. Offer to escalate to a specialist.');
  return summary(customer, 'already_bound');
}

async function failedAttempts(ctx: ToolContext): Promise<number> {
  const result = await db()
    .from('tool_calls')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', ctx.conversationId)
    .eq('tool_name', lookupCustomer.name)
    .eq('status', 'not_found');
  must(result);
  return result.count ?? 0;
}

async function verifyFromForm(ctx: ToolContext, args: Input): Promise<ToolOutcome> {
  const missing = (['customer_id', 'contact_name', 'email'] as const).filter((key) => !args[key]);
  if (missing.length > 0) return refused('missing_fields', `Fill in every field: ${missing.join(', ')}.`, { missing });

  const used = await failedAttempts(ctx);
  if (used >= MAX_VERIFICATION_ATTEMPTS) {
    return refused('too_many_attempts', 'Too many verification attempts for this call.', { attempts_used: used, attempts_left: 0 });
  }

  const customerId = normalizeReference('CUS', args.customer_id!);
  const [row] = customerId
    ? (must(await db().from('customers').select(COLUMNS).eq('customer_id', customerId).limit(1)) as CustomerRow[])
    : [];
  const matches =
    !!row && row.email_key === args.email!.trim().toLowerCase() && normalizeName(row.contact_name) === normalizeName(args.contact_name!);

  if (!matches) {
    // Which detail failed is logged for support staff, never returned to the caller.
    const mismatched = !row ? ['customer_id'] : [row.email_key !== args.email!.trim().toLowerCase() && 'email', normalizeName(row.contact_name) !== normalizeName(args.contact_name!) && 'contact_name'].filter(Boolean);
    const attemptsLeft = MAX_VERIFICATION_ATTEMPTS - used - 1;
    return {
      status: 'not_found',
      result: { ok: true, found: false, verified: false, attempts_left: attemptsLeft },
      logSummary: { found: false, verified: false, mismatched_on: mismatched, attempts_left: attemptsLeft, source: 'caller_page' },
    };
  }

  const bind = await bindVerifiedCustomer(ctx, row.customer_id);
  if (bind === 'conflict') {
    return refused('identity_conflict', 'This call is already verified as a different customer.', { attempted_customer_id: row.customer_id });
  }
  return {
    status: 'ok',
    // Goes back to the verified caller's own screen, so their name and company are fine to show there.
    result: { ok: true, found: true, verified: true, customer_id: row.customer_id, company_name: row.company_name, contact_name: row.contact_name },
    logSummary: { found: true, verified: true, customer_id: row.customer_id, verification: bind, source: 'caller_page' },
  };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}
