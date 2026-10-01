// Offline checks for the voice path: streaming parse of the structured turn output, and
// normalisation of references garbled by speech-to-text. No network, no model.
import { CLOSING_LINES, closingLine, END_CALL_PHRASE, withoutEndCallPhrase } from '../src/agent/closing.js';
import { StructuredSpeechParser } from '../src/agent/speechStream.js';
import { normalizeSpokenReferences, speakableReferences } from '../src/voice/transcript.js';

let bad = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// Parser: chunk boundaries like the real stream, including an escape split across chunks.
const BS = String.fromCharCode(92);
const chunks = [
  '{"answer_type": "answ',
  'er", "cited_chunk_ids": ["kb-a", "kb-b"]',
  ', "confidence_note": "fine"',
  `, "spoken_text": "Fees vary ${BS}`,
  `"by corridor${BS}`,
  'u0022. Shown first',
  '."}',
];
let meta: unknown = 'unset';
let text = '';
const p = new StructuredSpeechParser((m) => (meta = m), (t) => (text += t));
for (const c of chunks) p.feed(c);
check('parser meta', meta, { answer_type: 'answer', cited_chunk_ids: ['kb-a', 'kb-b'] });
check('parser text with split escapes', text, 'Fees vary "by corridor". Shown first.');
let meta2: unknown = 'unset';
new StructuredSpeechParser((m) => (meta2 = m), () => {}).feed('{"spoken_text": "early", "answer_type": "answer"}');
check('spoken_text before answer_type gives null meta (must buffer)', meta2, null);

const cases: Array<[string, string]> = [
  ['can you check t x n nine zero zero one', 'can you check TXN-9001'],
  ['transaction TXN 9001 please', 'transaction TXN-9001 please'],
  ['it is T.X.N. 90 01', 'it is TXN-9001'],
  ['payout P A Y seven zero zero two', 'payout PAY-7002'],
  ['I need to pay 7002 dollars', 'I need to pay 7002 dollars'],
  ['txn nine zero one', 'txn nine zero one'],
  ['my ticket is T K T zero zero zero one two', 'my ticket is TKT-00012'],
  ['customer C U S one oh oh one', 'customer CUS-1001'],
  ['I sent it to Kenya', 'I sent it to Kenya'],
  // Heard verbatim in the first real call.
  ["It's a transaction TXN of 9001.", "It's a transaction TXN-9001."],
  ['transaction number TXN number 9001', 'transaction number TXN-9001'],
  // Heard in real calls on 30 September.
  ['Please, can you check transaction on TXN 9, double o, 1?', 'Please, can you check transaction on TXN-9001?'],
  ['makes a TXN 9 double o 1.', 'makes a TXN-9001.'],
  ['Let me check transaction on TXN. N 9 w o 1.', 'Let me check transaction on TXN. N 9 w o 1.'],
  // Words after the reference stay words, even ones that sound like digits.
  ['TXN 9001 to Kenya', 'TXN-9001 to Kenya'],
  ['is TXN nine zero zero one for my supplier', 'is TXN-9001 for my supplier'],
];
for (const [input, want] of cases) check(`normalize "${input}"`, normalizeSpokenReferences(input).text, want);

// Speech: references are read out letter by letter and digit by digit, never as a minus sign.
const speech: Array<[string, string]> = [
  ['Transaction TXN-9001 is processing.', 'Transaction T X N nine zero zero one is processing.'],
  ['Your ticket is TKT-00012 and escalation ESC-00003.', 'Your ticket is T K T zero zero zero one two and escalation E S C zero zero zero zero three.'],
  ['Fees vary by corridor.', 'Fees vary by corridor.'],
];
for (const [input, want] of speech) check(`speak "${input}"`, speakableReferences(input), want);

// The reply heard on 30 September: the model spelled the ticket out itself, with "dash".
const modelSpelled = "I've logged this as ticket T K T dash zero zero zero one three so our team can look into it.";
check('model-spelled reference → one written form', normalizeSpokenReferences(modelSpelled).text, "I've logged this as ticket TKT-00013 so our team can look into it.");
check(
  'model-spelled reference → spoken without "dash"',
  speakableReferences(normalizeSpokenReferences(modelSpelled).text),
  "I've logged this as ticket T K T zero zero zero one three so our team can look into it.",
);

// Closing lines: which one code adds, and when.
check('goodbye line contains the end-call phrase', CLOSING_LINES.goodbye.toLowerCase().includes(END_CALL_PHRASE), true);
check('model text cannot end the call', withoutEndCallPhrase('Thanks, goodbye for now!').toLowerCase().includes(END_CALL_PHRASE), false);
const base = { askToType: 'none', endCall: false, answerType: 'answer', text: 'Fees vary by corridor.', escalationCreatedThisTurn: false, followUpDeferred: false } as const;
const closings: Array<[string, Parameters<typeof closingLine>[0], string | null]> = [
  ['answer gets the follow-up question', base, CLOSING_LINES.anythingElse],
  ['answer already ending in a question gets nothing', { ...base, text: 'Would you like me to raise it?' }, null],
  ['decline gets the follow-up question', { ...base, answerType: 'decline' }, CLOSING_LINES.anythingElse],
  ['clarify gets nothing', { ...base, answerType: 'clarify', text: 'Is it a payout?' }, null],
  ['escalation still collecting details gets nothing', { ...base, answerType: 'escalate', text: 'Could you tell me your name.' }, null],
  ['escalation just created gets the follow-up question', { ...base, answerType: 'escalate', text: 'Your reference is ESC-00004.', escalationCreatedThisTurn: true }, CLOSING_LINES.anythingElse],
  ['caller finished: goodbye line', { ...base, answerType: 'social', endCall: true, text: "You're welcome." }, CLOSING_LINES.goodbye],
  ['thanks without finishing: nothing', { ...base, answerType: 'social', text: "You're welcome." }, null],
  ['end_call on a non-social reply is ignored', { ...base, endCall: true, text: 'Fees vary.' }, CLOSING_LINES.anythingElse],
  ['email needed: type line', { ...base, answerType: 'clarify', askToType: 'email', text: 'What email should we use?' }, CLOSING_LINES.type_email],
  ['customer ID needed: type line', { ...base, answerType: 'clarify', askToType: 'customer_id', text: 'I can look that up.' }, CLOSING_LINES.type_customer_id],
  ['type line not repeated', { ...base, answerType: 'escalate', askToType: 'email', text: 'Please type your email in the chat box below.' }, null],
  // One question at a time (the simulator's TXN-9001 reply ended on an offer, and got two).
  ['answer ending on an offer: held back', { ...base, text: "It's past its estimate, so I can raise this with our team to look into it if you'd like." }, null],
  ['answer ending on "would you like": held back', { ...base, text: 'It is processing. Would you like me to raise it' }, null],
  ['offer earlier, statement last: asked', { ...base, text: "If you'd like a copy, it's in your dashboard. Payouts take two to five days." }, CLOSING_LINES.anythingElse],
  ['caller declines the offer: asked now', { ...base, answerType: 'social', text: 'No problem.', followUpDeferred: true }, CLOSING_LINES.anythingElse],
  ['caller accepts, ticket created: asked now', { ...base, text: "I've logged ticket TKT-00015.", followUpDeferred: true }, CLOSING_LINES.anythingElse],
  ['caller finishes instead: goodbye wins', { ...base, answerType: 'social', endCall: true, text: 'Goodbye.', followUpDeferred: true }, CLOSING_LINES.goodbye],
];
for (const [name, input, want] of closings) check(`closing: ${name}`, closingLine(input)?.line ?? null, want);
check('closing: held back is recorded as deferred', closingLine({ ...base, text: "I can raise it if you'd like." })?.note, 'follow_up_question_deferred');
process.exitCode = bad;
