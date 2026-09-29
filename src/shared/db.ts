import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// A voice caller is waiting on every query. Past this, fail and say so rather than hang.
export const DB_TIMEOUT_MS = 4000;

export class DbError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new DbError('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set', 'config');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout },
  });
  return client;
}

function fetchWithTimeout(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(DB_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

interface PostgrestLikeError {
  message: string;
  code?: string;
  details?: string | null;
}

// supabase-js reports failures in the return value instead of throwing; this makes them throw
// so a failed query can never be mistaken for an empty result.
export function must<T>(result: { data: T; error: PostgrestLikeError | null }): T {
  if (result.error) {
    const detail = result.error.details ? ` (${result.error.details})` : '';
    throw new DbError(`${result.error.message}${detail}`, result.error.code ?? null);
  }
  return result.data;
}

// For queries that must return exactly one row (.single(), insert...select().single()).
export function mustRow<T>(result: { data: T; error: PostgrestLikeError | null }): NonNullable<T> {
  const data = must(result);
  if (data === null || data === undefined) throw new DbError('expected one row, got none', 'no_row');
  return data;
}

export const UNIQUE_VIOLATION = '23505';
