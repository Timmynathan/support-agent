import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// Two different checks for two different Vapi request types — kept separate on purpose:
//
// - Model requests (custom LLM, one per caller turn): Vapi's custom-llm credential sends a
//   static key as `Authorization: Bearer <key>`. Vapi offers no signing for these, so this is
//   a shared-secret check, compared in constant time.
// - Webhooks (call status, end-of-call report): a Vapi webhook credential with an HMAC plan
//   signs `{timestamp}.{body}` with SHA-256 (hex) into x-signature / x-timestamp. The
//   timestamp window stops a captured webhook being replayed later.

export const MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

export type AuthResult = { ok: true } | { ok: false; reason: string };

export function verifyBearer(headers: IncomingHttpHeaders, secret: string): AuthResult {
  const header = headers.authorization;
  if (!header?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer token' };
  // Hashing first makes the comparison length-independent, so length leaks nothing either.
  const given = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: 'bad bearer token' };
}

export function verifyWebhookSignature(rawBody: string, headers: IncomingHttpHeaders, secret: string, now = Date.now()): AuthResult {
  const signature = single(headers['x-signature']);
  const timestamp = single(headers['x-timestamp']);
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature or timestamp header' };

  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return { ok: false, reason: 'unreadable timestamp' };
  // Vapi's docs don't state the unit; accept seconds or milliseconds, never a stale request.
  const timestampMs = numeric > 1e12 ? numeric : numeric * 1000;
  if (Math.abs(now - timestampMs) > MAX_WEBHOOK_AGE_MS) return { ok: false, reason: 'timestamp outside the allowed window' };

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const given = signature.replace(/^sha256=/, '');
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
