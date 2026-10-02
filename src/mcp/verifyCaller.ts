import type { Channel } from '../shared/domain.js';
import type { ToolContext } from './context.js';
import { runLogged } from './toolLog.js';
import { lookupCustomer } from './tools/lookupCustomer.js';

// The secure verification form, run through the same lookup_customer tool code as everything
// else (so verification stays in the MCP layer and every attempt is in tool_calls). Only server
// code calls this; the agent cannot reach it.
export interface VerificationForm {
  customer_id: string;
  full_name: string;
  email: string;
}

export type VerificationResult =
  | { verified: true; customer: { customer_id: string; company_name: string; contact_name: string } }
  | { verified: false; reason: 'mismatch' | 'too_many_attempts' | 'missing_fields' | 'already_verified_as_another' | 'unavailable'; attempts_left: number | null };

export async function verifyCaller(conversationId: string, channel: Channel, form: VerificationForm): Promise<VerificationResult> {
  const ctx: ToolContext = { conversationId, channel, source: 'verification_form' };
  const input = { customer_id: form.customer_id, contact_name: form.full_name, email: form.email };
  const outcome = await runLogged(ctx, lookupCustomer, input, () => lookupCustomer.run(ctx, input));
  const result = outcome.result as Record<string, any>;

  if (outcome.status === 'ok' && result.verified === true) {
    return { verified: true, customer: { customer_id: result.customer_id, company_name: result.company_name, contact_name: result.contact_name } };
  }
  if (outcome.status === 'not_found') return { verified: false, reason: 'mismatch', attempts_left: result.attempts_left ?? null };
  if (outcome.status === 'refused') {
    const reason = result.reason === 'too_many_attempts' ? 'too_many_attempts' : result.reason === 'identity_conflict' ? 'already_verified_as_another' : 'missing_fields';
    return { verified: false, reason, attempts_left: reason === 'too_many_attempts' ? 0 : null };
  }
  return { verified: false, reason: 'unavailable', attempts_left: null };
}
