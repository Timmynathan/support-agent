import type { Category } from '../shared/domain.js';

// Escalation triggers from assets/escalation-rules.md, checked in code on every turn so they
// don't depend on the model noticing. Deliberately broad: a false escalation costs a callback;
// a missed one leaves an upset customer talking to a bot about their money.

export type TriggerKind = 'frustration' | 'dispute' | 'restriction' | 'compliance' | 'human_requested';

interface TriggerRule {
  kind: TriggerKind;
  category: Category;
  pattern: RegExp;
}

const RULES: TriggerRule[] = [
  // "Expresses frustration or urgency"
  { kind: 'frustration', category: 'other', pattern: /\b(no ?one|nobody) (is |has been |will )?(help|respond|answer|getting back)/i },
  { kind: 'frustration', category: 'other', pattern: /\b(fed up|ridiculous|unacceptable|outrageous|useless|furious|angry|frustrat\w*|disgust\w*|pathetic)\b/i },
  { kind: 'frustration', category: 'other', pattern: /\b(waste of (my )?time|this is a joke|sick of|had enough)\b/i },
  { kind: 'frustration', category: 'other', pattern: /\b(third|3rd|fourth|4th|fifth|several|many) times?\b.*\b(call|ask|contact|tr(y|ied))/i },
  { kind: 'frustration', category: 'other', pattern: /\b(urgent(ly)?|asap|immediately|right now|emergency)\b/i },
  // "Requests dispute, refund, or cancellation support"
  { kind: 'dispute', category: 'dispute', pattern: /\b(dispute|refund|chargeback|charge back|cancel+(ation|ed|ing)?|reverse|reversal|money back)\b/i },
  // "Reports an account restriction or suspension"
  { kind: 'restriction', category: 'account', pattern: /\b(restrict\w*|suspend\w*|suspension|frozen|freeze|locked|blocked|deactivat\w*|closed my account)\b/i },
  // "Raises compliance or identity verification concerns"
  { kind: 'compliance', category: 'compliance', pattern: /\b(compliance|kyc|kyb|aml|money laundering|identity verification|verify my (identity|business)|documents? (were |was )?(rejected|declined))\b/i },
  // Not in the rules list, but a person asking for a person must never be argued with.
  { kind: 'human_requested', category: 'other', pattern: /\b(speak|talk) (to|with) (a |an |someone|somebody)?\s*(human|person|agent|manager|supervisor|real)|\b(human|real person|manager|supervisor) please\b/i },
];

export interface TriggerHit {
  kind: TriggerKind;
  category: Category;
  matched: string;
}

export function detectTriggers(text: string): TriggerHit[] {
  const hits: TriggerHit[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match && !hits.some((hit) => hit.kind === rule.kind)) {
      hits.push({ kind: rule.kind, category: rule.category, matched: match[0] });
    }
  }
  return hits;
}

// When several triggers fire, the most specific category wins; frustration alone is 'other'.
export function escalationCategory(hits: TriggerHit[]): Category {
  const order: Category[] = ['compliance', 'dispute', 'account', 'payment', 'other'];
  return order.find((category) => hits.some((hit) => hit.category === category)) ?? 'other';
}
