// Redaction for anything that leaves a tool: log rows and speakable summaries.
// Logs are reviewed by people too, so they get the same treatment as spoken output.

const EMAIL_KEYS = new Set(['email', 'user_email', 'contact_email']);
const NAME_KEYS = new Set(['user_name', 'contact_name', 'recipient_name']);
const MAX_LOGGED_STRING = 300;

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => `${part[0] ?? ''}***`)
    .join(' ');
}

export function redactForLog(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && EMAIL_KEYS.has(key)) return maskEmail(value);
    if (key && NAME_KEYS.has(key)) return maskName(value);
    return value.length > MAX_LOGGED_STRING ? `${value.slice(0, MAX_LOGGED_STRING)}…[truncated]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactForLog(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactForLog(v, k)]));
  }
  return value;
}
