// Lines code adds to the end of a voice reply, and the rules for when. The model only reports
// what it needs (ask_to_type) and whether the caller is finished (end_call); the words, and
// the decision to say them, are here.

// Vapi hangs up when the assistant says this (assistant endCallPhrases, scripts/vapi-setup.ts).
// Only the goodbye line below may contain it: model text is stripped of it before it is spoken.
export const END_CALL_PHRASE = 'goodbye for now';

export const CLOSING_LINES = {
  anythingElse: 'Is there anything else I can help you with?',
  goodbye: 'Thanks for calling RelayPay support. Goodbye for now.',
  // Emails and customer IDs are typed, not spoken: speech-to-text garbles both.
  type_email: 'Please type your email in the chat box below.',
  type_customer_id: 'Please type your customer ID in the chat box below.',
} as const;

export const ASK_TO_TYPE = ['none', 'email', 'customer_id'] as const;
export type AskToType = (typeof ASK_TO_TYPE)[number];

export interface ClosingInput {
  askToType: AskToType;
  endCall: boolean;
  // After the code's own checks, which may differ from what the model chose.
  answerType: string;
  // Everything the caller will hear before any closing line.
  text: string;
  // An escalation was created this turn, so its reference has just been given.
  escalationCreatedThisTurn: boolean;
  // The previous reply finished something but left the caller a question or an offer to answer
  // first, so "anything else?" was held back until now.
  followUpDeferred: boolean;
}

// `line` is null when the follow-up question is held back for a later turn.
export interface Closing {
  line: string | null;
  note: string;
}

const ENDS_WITH_QUESTION = /\?\s*$/;
const ASKS_TO_TYPE = /\btype your\b/i;
// An offer phrased without a question mark: "I can raise this with the team if you'd like."
const OFFER = /\b(if you'?d like|if you would like|if you want|would you like|do you want|want me to|shall i|should i|let me know)\b/i;

function lastSentence(text: string): string {
  return text.trim().split(/(?<=[.!?])\s+/).at(-1) ?? '';
}

// The caller has something to answer first: a question, an offer, or a detail to type.
function awaitsCaller(text: string): boolean {
  return ENDS_WITH_QUESTION.test(text) || ASKS_TO_TYPE.test(text) || OFFER.test(lastSentence(text));
}

export function closingLine(input: ClosingInput): Closing | null {
  if (input.askToType !== 'none' && input.answerType !== 'social') {
    if (ASKS_TO_TYPE.test(input.text)) return null;
    return { line: CLOSING_LINES[`type_${input.askToType}`], note: `ask_to_type_${input.askToType}` };
  }
  if (input.endCall && input.answerType === 'social') {
    return { line: CLOSING_LINES.goodbye, note: 'call_ended_by_agent' };
  }
  // Only once something is finished: an answer, a decline, or an escalation just created. An
  // escalation still collecting details is waiting on the caller, not done. A short reply to an
  // earlier offer ("no thanks" → "No problem.") finishes the thing that offer held back.
  const finished =
    input.answerType === 'answer' ||
    input.answerType === 'decline' ||
    (input.answerType === 'escalate' && input.escalationCreatedThisTurn) ||
    (input.answerType === 'social' && input.followUpDeferred);
  if (!finished) return null;
  // One question at a time: ask "anything else?" once the caller has answered this one.
  if (awaitsCaller(input.text)) return { line: null, note: 'follow_up_question_deferred' };
  return { line: CLOSING_LINES.anythingElse, note: 'follow_up_question_added' };
}

// The model may not end the call by saying the phrase itself.
export function withoutEndCallPhrase(text: string): string {
  return text.replace(new RegExp(END_CALL_PHRASE, 'gi'), 'goodbye');
}
