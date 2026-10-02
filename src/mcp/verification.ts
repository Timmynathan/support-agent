import { db, must, mustRow } from '../shared/db.js';
import type { ToolContext } from './context.js';
import { refused, type ToolOutcome } from './tool.js';

// No account, transaction or payout detail of any kind is released before the caller has
// verified through the secure form (product decision, 2 Oct: this replaces the kickoff's
// "anyone with a reference gets the customer-safe status").
export function verificationRequired(): ToolOutcome {
  return refused(
    'verification_required',
    'The caller is not verified, so no account, transaction or payout details can be shared. Ask them to fill in ' +
      'their customer ID and email in the verification form on screen (set ask_to_type to verification). ' +
      'Do not ask for these details aloud, and do not say whether the reference exists.',
  );
}

// Said for a reference that doesn't exist AND for one that belongs to someone else, so a caller
// can't tell the two apart (or learn which references are real).
export function notOnThisAccount(kind: 'transaction' | 'payout'): ToolOutcome {
  return {
    status: 'not_found',
    result: {
      ok: true,
      found: false,
      message_for_agent: `No ${kind} with that reference is on the caller's account. Read the reference back and ask them to confirm it; do not guess a status.`,
    },
  };
}

const ensuredConversations = new Set<string>();

// Tool-call rows reference the conversation, so it must exist before the first log write.
export async function ensureConversation(ctx: ToolContext): Promise<void> {
  if (ensuredConversations.has(ctx.conversationId)) return;
  must(
    await db()
      .from('conversations')
      .upsert({ conversation_id: ctx.conversationId, channel: ctx.channel }, { onConflict: 'conversation_id', ignoreDuplicates: true }),
  );
  ensuredConversations.add(ctx.conversationId);
}

export async function verifiedCustomerId(ctx: ToolContext): Promise<string | null> {
  const row = must(
    await db().from('conversations').select('verified_customer_id').eq('conversation_id', ctx.conversationId).maybeSingle(),
  );
  return (row?.verified_customer_id as string | null | undefined) ?? null;
}

export type CustomerForWrite = { ok: true; customerId: string | null } | { ok: false };

// Tickets and escalations attach to the verified customer automatically. A customer_id the
// model supplies is accepted only if it IS that customer — otherwise anyone could file records
// against an account they never proved they own.
export async function customerForWrite(ctx: ToolContext, requested: string | null): Promise<CustomerForWrite> {
  const verified = await verifiedCustomerId(ctx);
  if (requested !== null && requested !== verified) return { ok: false };
  return { ok: true, customerId: verified };
}

export type BindResult = 'bound' | 'already_bound' | 'conflict';

// A conversation verifies as exactly one customer. A second, different identity mid-call is
// refused here, and the conversations_verified_customer_guard trigger refuses it again in the
// database if this check is ever bypassed.
// The common case (first verification) is a single conditional update — one round trip on a
// voice call. Only when it matches nothing is the current binding read to say why.
export async function bindVerifiedCustomer(ctx: ToolContext, customerId: string): Promise<BindResult> {
  const updated = mustRow(
    await db()
      .from('conversations')
      .update({ verified_customer_id: customerId, verified_at: new Date().toISOString() })
      .eq('conversation_id', ctx.conversationId)
      .is('verified_customer_id', null)
      .select('verified_customer_id'),
  );
  if (updated.length === 1) return 'bound';

  return (await verifiedCustomerId(ctx)) === customerId ? 'already_bound' : 'conflict';
}
