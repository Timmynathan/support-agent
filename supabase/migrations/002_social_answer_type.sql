-- 002: allow the 'social' answer type on conversation turns.
--
-- Why: in the first real voice call, "It's over. Thank you." was forced through the grounding
-- rule and answered with the decline line. Greetings, thanks and goodbyes carry no product or
-- policy content, so they get their own answer type. The agent server only accepts it for short
-- replies containing no digits or references (src/agent/conversation.ts), so it can't be used to
-- slip an ungrounded claim past the grounding check.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

alter table conversation_turns drop constraint if exists conversation_turns_answer_type_check;
alter table conversation_turns add constraint conversation_turns_answer_type_check
  check (answer_type in ('answer', 'clarify', 'escalate', 'decline', 'social', 'error'));
