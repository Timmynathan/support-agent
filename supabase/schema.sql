-- RelayPay support agent — Supabase schema.
-- Run by hand in the Supabase SQL editor. Safe to re-run: everything is IF NOT EXISTS / OR REPLACE.
--
-- Access model: RLS is enabled on every table and NO policies exist, so the anon and
-- authenticated roles can read and write nothing. Only the service role (server-side only)
-- bypasses RLS. Grants to anon/authenticated are also revoked as a second layer.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────
-- Seed data (loaded by scripts/seed.ts from assets/seed-data/)
-- ─────────────────────────────────────────────────────────────

create table if not exists customers (
  customer_id     text primary key check (customer_id ~ '^CUS-[0-9]{4}$'),
  company_name    text not null,
  contact_name    text not null,
  contact_email   text not null,
  plan            text not null check (plan in ('Starter', 'Growth', 'Scale')),
  account_status  text not null check (account_status in ('active', 'restricted', 'pending verification')),
  region          text not null,
  kyc_status      text not null check (kyc_status in ('pending', 'approved', 'review required')),
  support_notes   text,
  -- Match keys: "Lagos Ledger" (as transcribed) must find "LagosLedger".
  company_key     text generated always as (lower(regexp_replace(company_name, '[^A-Za-z0-9]', '', 'g'))) stored,
  email_key       text generated always as (lower(contact_email)) stored
);

create index if not exists customers_company_key_idx on customers (company_key);
create index if not exists customers_email_key_idx on customers (email_key);

create table if not exists transactions (
  transaction_id       text primary key check (transaction_id ~ '^TXN-[0-9]{4}$'),
  customer_id          text not null references customers(customer_id),
  transaction_type     text not null check (transaction_type in ('incoming transfer', 'outgoing payout', 'invoice payment')),
  amount               numeric(14, 2) not null check (amount > 0),
  currency             char(3) not null,
  destination_country  text,
  status               text not null check (status in ('processing', 'completed', 'delayed', 'failed', 'review required')),
  -- The seed file carries dates only; storing them as timestamps would invent a time of day.
  created_at           date not null,
  estimated_arrival    date,          -- null = not known, never "arrived"
  support_summary      text not null
);

create table if not exists payouts (
  payout_id       text primary key check (payout_id ~ '^PAY-[0-9]{4}$'),
  transaction_id  text not null references transactions(transaction_id),
  customer_id     text not null references customers(customer_id),
  recipient_name  text not null,
  amount          numeric(14, 2) not null check (amount > 0),
  currency        char(3) not null,
  status          text not null check (status in ('scheduled', 'processing', 'completed', 'failed', 'review required')),
  scheduled_for   date,
  failure_reason  text               -- null = no failure recorded
);

-- ─────────────────────────────────────────────────────────────
-- Runtime records
-- ─────────────────────────────────────────────────────────────

create table if not exists conversations (
  conversation_id       text primary key check (conversation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  channel               text not null check (channel in ('voice', 'text', 'cli')),
  caller_identifier     text,
  -- Set only by lookup_customer after a two-factor match. Gates the full view of records.
  verified_customer_id  text references customers(customer_id),
  verified_at           timestamptz,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  final_status          text not null default 'in_progress'
                        check (final_status in ('in_progress', 'resolved', 'escalated', 'declined', 'abandoned', 'failed')),
  summary               text
);

-- A conversation cannot switch to a different verified customer once bound.
create or replace function guard_verified_customer() returns trigger language plpgsql as $$
begin
  if old.verified_customer_id is not null
     and new.verified_customer_id is distinct from old.verified_customer_id then
    raise exception 'verified_customer_id is already bound for conversation %', old.conversation_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists conversations_verified_customer_guard on conversations;
create trigger conversations_verified_customer_guard
  before update of verified_customer_id on conversations
  for each row execute function guard_verified_customer();

create table if not exists conversation_turns (
  id                  bigint generated always as identity primary key,
  conversation_id     text not null references conversations(conversation_id),
  turn_index          int not null check (turn_index >= 0),
  user_transcript     text not null,
  assistant_response  text,          -- null = no response produced (e.g. caller hung up)
  answer_type         text check (answer_type in ('answer', 'clarify', 'escalate', 'decline', 'social', 'error')),
  confidence_note     text,
  created_at          timestamptz not null default now(),
  unique (conversation_id, turn_index)
);

create table if not exists retrieval_logs (
  id               bigint generated always as identity primary key,
  conversation_id  text not null references conversations(conversation_id),
  turn_id          bigint references conversation_turns(id),
  query            text not null,
  chunk_ids        text[] not null default '{}',
  source_titles    text[] not null default '{}',
  source_summary   text,
  result_count     int not null check (result_count >= 0),
  created_at       timestamptz not null default now()
);

create table if not exists tool_calls (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text not null references conversations(conversation_id),
  tool_name        text not null,
  purpose          text not null,
  input_summary    jsonb not null,    -- redacted before insert
  result_summary   jsonb,             -- null while status = 'started'
  status           text not null default 'started'
                   check (status in ('started', 'ok', 'not_found', 'refused', 'failed')),
  error_message    text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  duration_ms      int
);

create index if not exists tool_calls_conversation_idx on tool_calls (conversation_id, started_at);

-- A tool-call row is written as 'started' before the call and finalised exactly once after it.
create or replace function guard_tool_call_finalise() returns trigger language plpgsql as $$
begin
  if old.status <> 'started' then
    raise exception 'tool_call % is already finalised as %', old.id, old.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists tool_calls_finalise_once on tool_calls;
create trigger tool_calls_finalise_once
  before update on tool_calls
  for each row execute function guard_tool_call_finalise();

create table if not exists conversation_events (
  id               bigint generated always as identity primary key,
  conversation_id  text not null references conversations(conversation_id),
  event_type       text not null check (event_type in
                     ('decision', 'clarification', 'escalation_triggered', 'decline', 'handoff', 'error', 'note')),
  summary          text not null,
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

-- Short, speakable references ("ticket T K T zero zero zero one two") rather than UUIDs.
create sequence if not exists support_ticket_seq;
create sequence if not exists escalation_seq;

create table if not exists support_tickets (
  ticket_id        text primary key default ('TKT-' || lpad(nextval('support_ticket_seq')::text, 5, '0')),
  conversation_id  text not null references conversations(conversation_id),
  customer_id      text references customers(customer_id),
  transaction_id   text references transactions(transaction_id),
  category         text not null check (category in ('compliance', 'account', 'dispute', 'payment', 'other')),
  priority         text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  summary          text not null check (length(summary) between 10 and 1000),
  status           text not null default 'open' check (status in ('open', 'in progress', 'closed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Idempotency: one open ticket per conversation per category. A retried webhook
-- that tries to open the same ticket again hits this and gets the existing one back.
create unique index if not exists support_tickets_one_open_per_category
  on support_tickets (conversation_id, category) where status <> 'closed';

create table if not exists escalations (
  escalation_id           text primary key default ('ESC-' || lpad(nextval('escalation_seq')::text, 5, '0')),
  conversation_id         text not null references conversations(conversation_id),
  ticket_id               text references support_tickets(ticket_id),
  customer_id             text references customers(customer_id),
  user_name               text,
  user_email              text,
  contact_source          text not null check (contact_source in ('caller', 'verified_record', 'mixed', 'none')),
  contact_missing_reason  text,
  category                text not null check (category in ('compliance', 'account', 'dispute', 'payment', 'other')),
  reason                  text not null check (length(reason) between 5 and 1000),
  call_booked             boolean not null default false,
  preferred_time          text,       -- the caller's own words; not parsed into a timestamp
  status                  text not null default 'open' check (status in ('open', 'in progress', 'closed')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  -- Missing contact details must be explained, never silently blank.
  constraint escalation_contact_present_or_explained
    check ((user_name is not null and user_email is not null) or contact_missing_reason is not null)
);

-- Idempotency: one open escalation per conversation.
create unique index if not exists escalations_one_open_per_conversation
  on escalations (conversation_id) where status <> 'closed';

create table if not exists evaluations (
  id                 bigint generated always as identity primary key,
  scenario_number    int not null check (scenario_number between 1 and 9),
  scenario_name      text not null,
  conversation_id    text references conversations(conversation_id),
  expected_behavior  text not null,
  actual_behavior    text not null,
  passed             boolean not null,
  notes              text,
  created_at         timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- History is kept: log tables are append-only.
-- ─────────────────────────────────────────────────────────────

create or replace function forbid_delete() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; rows cannot be deleted', tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

do $$
declare t text;
begin
  foreach t in array array['conversation_turns', 'retrieval_logs', 'tool_calls', 'conversation_events', 'evaluations', 'support_tickets', 'escalations']
  loop
    execute format('drop trigger if exists %I_no_delete on %I', t, t);
    execute format('create trigger %I_no_delete before delete on %I for each row execute function forbid_delete()', t, t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────
-- Row Level Security: enabled everywhere, no policies. Nothing here is public.
-- ─────────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array['customers', 'transactions', 'payouts', 'conversations', 'conversation_turns',
                           'retrieval_logs', 'tool_calls', 'conversation_events', 'support_tickets',
                           'escalations', 'evaluations']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

revoke all on sequence support_ticket_seq, escalation_seq from anon, authenticated;
