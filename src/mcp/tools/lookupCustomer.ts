import { z } from 'zod';
import { db, must } from '../../shared/db.js';
import { companyKey, customerHandling, normalizeReference } from '../../shared/domain.js';
import { defineTool, refused } from '../tool.js';
import { bindVerifiedCustomer } from '../verification.js';

// Minimum identifying context before any account lookup. support-decision-rules.md doesn't set
// a number; two independent identifiers matching one record is the agreed rule (kickoff point B).
const REQUIRED_FACTORS = 2;

// support_notes are internal (schema guide: "Short internal support note") and contact details
// are personal; neither leaves the server. The model gets derived flags instead.
const WITHHELD_FIELDS = ['support_notes', 'contact_name', 'contact_email', 'region'];

interface CustomerRow {
  customer_id: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  plan: string;
  account_status: string;
  kyc_status: string;
  company_key: string;
  email_key: string;
}

const input = z.object({
  customer_id: z.string().trim().min(1).max(20).optional(),
  email: z.string().trim().min(3).max(254).optional(),
  company_name: z.string().trim().min(1).max(120).optional(),
  contact_name: z.string().trim().min(1).max(120).optional(),
});
type Input = z.infer<typeof input>;

export const lookupCustomer = defineTool({
  name: 'lookup_customer',
  purpose: 'Find a customer account from caller-supplied identifying details and verify the caller for this conversation',
  description:
    'Look up a RelayPay customer account. Requires at least TWO of: customer_id (e.g. CUS-1001), email, company_name, ' +
    'contact_name (the caller\'s name). With fewer, it refuses — ask the caller for another detail. A match verifies the ' +
    'caller as that customer for the rest of this conversation, which unlocks full transaction and payout details. ' +
    'Returns only customer-safe fields; never read identifiers back in full.',
  input,
  async handler(ctx, args) {
    const provided = presentFactors(args);
    if (provided.length < REQUIRED_FACTORS) {
      return refused(
        'needs_more_context',
        'Not enough identifying details to look up an account. Ask the caller for one more of: company name, ' +
          'their name, the account email, or their customer ID.',
        { provided_factors: provided },
      );
    }

    let customerId: string | null = null;
    if (args.customer_id !== undefined) {
      customerId = normalizeReference('CUS', args.customer_id);
      if (!customerId) {
        return refused(
          'invalid_customer_id',
          'That customer ID is not in the expected format (CUS followed by four digits). Ask the caller to repeat it.',
        );
      }
    }

    const candidates = await findCandidates(args, customerId);
    const { matches, mismatchedOn } = filterMatches(candidates, args, customerId);

    if (matches.length === 0) {
      return {
        status: 'not_found',
        result: {
          ok: true,
          found: false,
          message_for_agent:
            'No account matched those details together. Do not tell the caller which detail did not match. ' +
            'Ask them to check the details, or offer to escalate to a specialist.',
        },
        logSummary: { found: false, provided_factors: provided, candidates_considered: candidates.length, mismatched_on: mismatchedOn },
      };
    }
    if (matches.length > 1) {
      return refused('ambiguous_match', 'More than one account matches. Ask the caller for their customer ID or account email.', {
        provided_factors: provided,
        match_count: matches.length,
      });
    }

    const customer = matches[0]!;
    const bind = await bindVerifiedCustomer(ctx, customer.customer_id);
    if (bind === 'conflict') {
      return refused(
        'identity_conflict',
        'This conversation is already verified as a different customer. Do not look up another account in this ' +
          'conversation; offer to escalate to a specialist instead.',
        { attempted_customer_id: customer.customer_id },
      );
    }

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
      logSummary: { found: true, customer_id: customer.customer_id, provided_factors: provided, verification: bind },
    };
  },
});

function presentFactors(args: Input): string[] {
  return (['customer_id', 'email', 'company_name', 'contact_name'] as const).filter((key) => args[key] !== undefined);
}

// Query by the most specific identifier given, then check every other identifier in code.
async function findCandidates(args: Input, customerId: string | null): Promise<CustomerRow[]> {
  const columns = 'customer_id, company_name, contact_name, contact_email, plan, account_status, kyc_status, company_key, email_key';
  const query = db().from('customers').select(columns).limit(5);
  if (customerId) return must(await query.eq('customer_id', customerId)) as CustomerRow[];
  if (args.email) return must(await query.eq('email_key', args.email.toLowerCase())) as CustomerRow[];
  if (args.company_name) return must(await query.eq('company_key', companyKey(args.company_name))) as CustomerRow[];
  // Only contact_name + nothing indexable can't reach here: two factors always include one of the above.
  return [];
}

function filterMatches(candidates: CustomerRow[], args: Input, customerId: string | null) {
  const mismatchedOn = new Set<string>();
  const matches = candidates.filter((row) => {
    const checks: Array<[string, boolean]> = [];
    if (customerId) checks.push(['customer_id', row.customer_id === customerId]);
    if (args.email) checks.push(['email', row.email_key === args.email.toLowerCase()]);
    if (args.company_name) checks.push(['company_name', row.company_key === companyKey(args.company_name)]);
    if (args.contact_name) checks.push(['contact_name', nameMatches(row.contact_name, args.contact_name)]);
    for (const [factor, ok] of checks) if (!ok) mismatchedOn.add(factor);
    return checks.every(([, ok]) => ok);
  });
  return { matches, mismatchedOn: [...mismatchedOn] };
}

// "Amara" or "Amara Okafor" both identify Amara Okafor; a caller rarely gives a full name.
function nameMatches(recorded: string, given: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const full = normalize(recorded);
  const spoken = normalize(given);
  return spoken === full || spoken === full.split(' ')[0];
}
