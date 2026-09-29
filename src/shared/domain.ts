// Every enum and rule constant lives here once. schema.sql mirrors these as CHECK constraints
// so the database refuses what the code would refuse.

export const CHANNELS = ['voice', 'text', 'cli'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CATEGORIES = ['compliance', 'account', 'dispute', 'payment', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export const EVENT_TYPES = [
  'decision',
  'clarification',
  'escalation_triggered',
  'decline',
  'handoff',
  'error',
  'note',
] as const;

export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const REFERENCE_PATTERNS = {
  CUS: /^CUS-\d{4}$/,
  TXN: /^TXN-\d{4}$/,
  PAY: /^PAY-\d{4}$/,
  TKT: /^TKT-\d{5}$/,
} as const;
export type ReferencePrefix = keyof typeof REFERENCE_PATTERNS;

// Accepts "txn 9001", "TXN_9001", "txn9001" — the shapes a person or a transcript produces.
// Returns null when the result still isn't a valid reference, so callers can't guess.
export function normalizeReference(prefix: ReferencePrefix, raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s_.-]+/g, '');
  if (!compact.startsWith(prefix)) return null;
  const candidate = `${prefix}-${compact.slice(prefix.length)}`;
  return REFERENCE_PATTERNS[prefix].test(candidate) ? candidate : null;
}

// Same normalisation the customers.company_key generated column applies.
export function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Record statuses that mean a human must handle any account-specific follow-up.
// Source: escalation-rules.md (compliance, failed transactions) and the KB FAQ
// "Account-specific questions, disputes, failed transactions, and compliance-related issues
// are handled by human support teams."
export const STATUSES_REQUIRING_HUMAN: readonly string[] = ['review required', 'failed'];

export type CustomerHandling =
  | { requires_escalation: false; escalation_hint: null }
  | { requires_escalation: true; escalation_hint: 'account_restricted' | 'verification_pending' | 'compliance_review' };

// Derived from structured status fields rather than from the free-text support_notes,
// which are internal and never leave the MCP server.
export function customerHandling(accountStatus: string, kycStatus: string): CustomerHandling {
  if (accountStatus === 'restricted') return { requires_escalation: true, escalation_hint: 'account_restricted' };
  if (kycStatus === 'review required') return { requires_escalation: true, escalation_hint: 'compliance_review' };
  if (accountStatus === 'pending verification' || kycStatus === 'pending') {
    return { requires_escalation: true, escalation_hint: 'verification_pending' };
  }
  return { requires_escalation: false, escalation_hint: null };
}

export function todayIsoDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
