// Offline checks for the voice path: streaming parse of the structured turn output, and
// normalisation of references garbled by speech-to-text. No network, no model.
import { StructuredSpeechParser } from '../src/agent/speechStream.js';
import { normalizeSpokenReferences } from '../src/voice/transcript.js';

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
];
for (const [input, want] of cases) check(`normalize "${input}"`, normalizeSpokenReferences(input).text, want);
process.exitCode = bad;
