import type { ServerResponse } from 'node:http';
import { accountOverview, verifyCaller, type VerificationForm } from '../mcp/verifyCaller.js';
import { CONVERSATION_ID_PATTERN } from '../shared/domain.js';
import { HttpError, sendJson } from './httpUtil.js';
import { getConversation } from './registry.js';

// The secure verification form, shared by the voice page (/vapi/verify) and the text test
// channel (/chat/verify). Only a conversation that is live on this server can be verified, so
// nobody can verify (or probe accounts against) a conversation id they made up.

const FIELD_LIMITS: Record<keyof VerificationForm, number> = { customer_id: 20, full_name: 120, email: 254 };

export function readVerificationForm(body: Record<string, unknown>): VerificationForm {
  const form = {} as VerificationForm;
  for (const [field, max] of Object.entries(FIELD_LIMITS) as Array<[keyof VerificationForm, number]>) {
    const value = typeof body[field] === 'string' ? (body[field] as string).trim() : '';
    if (!value) throw new HttpError(400, `${field} is required`);
    if (value.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
    form[field] = value;
  }
  return form;
}

// Plain words for the caller's screen. Which detail failed is never said.
const MESSAGES = {
  mismatch: "Those details don't match our records.",
  too_many_attempts: 'Too many attempts for this call. You can still ask Relay to arrange a callback from a specialist.',
  missing_fields: 'Please fill in every field.',
  already_verified_as_another: 'This call is already verified for a different account.',
  unavailable: "We couldn't check your details just now. Please try again in a moment.",
} as const;

export async function verifyConversation(res: ServerResponse, conversationId: string, form: VerificationForm): Promise<void> {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw new HttpError(400, 'invalid conversation id');
  const conversation = getConversation(conversationId);
  if (!conversation) throw new HttpError(404, 'no live call with that id');

  const result = await verifyCaller(conversationId, conversation.channel, form);
  if (result.verified) {
    conversation.markVerified({ companyName: result.customer.company_name });
    sendJson(res, 200, { verified: true, customer_id: result.customer.customer_id, company_name: result.customer.company_name, contact_name: result.customer.contact_name });
    return;
  }
  sendJson(res, result.reason === 'unavailable' ? 503 : 200, {
    verified: false,
    reason: result.reason,
    message: MESSAGES[result.reason],
    attempts_left: result.attempts_left,
  });
}

// The verified caller's account panel. Same rule as verification: a live call on this server
// only, and the tool itself refuses unless that call is verified.
export async function accountPanel(res: ServerResponse, conversationId: string): Promise<void> {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw new HttpError(400, 'invalid conversation id');
  const conversation = getConversation(conversationId);
  if (!conversation) throw new HttpError(404, 'no live call with that id');
  const overview = await accountOverview(conversationId, conversation.channel);
  if (overview.status === 'not_verified') throw new HttpError(403, 'verify first');
  if (overview.status === 'unavailable') throw new HttpError(503, "We couldn't load your account just now.");
  sendJson(res, 200, overview.data);
}
