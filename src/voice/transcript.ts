// Speech-to-text turns "TXN-9001" into things like "t x n nine zero zero one" or "TXN 90 01".
// This rewrites the recognisable shapes back into canonical references before the agent sees
// them. It only ever produces a reference when the result has exactly the right number of
// digits; anything else is left alone for the agent to ask about, rather than guessed.

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4',
  five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
};

const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

interface PrefixRule {
  canonical: string;
  digits: number;
  // Spoken forms of the prefix. PAY is only accepted spelled out, because "pay 7002" in normal
  // speech is far more likely to be an amount than a payout reference.
  pattern: string;
}

const PREFIXES: PrefixRule[] = [
  { canonical: 'TXN', digits: 4, pattern: String.raw`t\.?\s*x\.?\s*n\.?|txn` },
  { canonical: 'PAY', digits: 4, pattern: String.raw`p\.?\s+a\.?\s+y\.?|p\.a\.y\.?` },
  { canonical: 'CUS', digits: 4, pattern: String.raw`c\.?\s*u\.?\s*s\.?|cus` },
  { canonical: 'TKT', digits: 5, pattern: String.raw`t\.?\s*k\.?\s*t\.?|tkt` },
  { canonical: 'ESC', digits: 5, pattern: String.raw`e\.?\s*s\.?\s*c\.?|esc` },
];

// One spoken digit group: "9001", "nine", or "double o" (said for "00").
const DIGIT_TOKEN = String.raw`(?:double[\s-]+)?(?:\d+|${Object.keys(DIGIT_WORDS).join('|')})`;
const SEPARATOR = String.raw`[\s,-]+`;

function tokenDigits(token: string): string {
  const value = token.replace(/^double[\s-]+/i, '');
  const digits = /^\d+$/.test(value) ? value : DIGIT_WORDS[value.toLowerCase()] ?? '';
  return value === token ? digits : digits + digits;
}

// Reads digit groups from the start of `spoken` until exactly `count` digits are collected.
// Returns the digits and where they end, so words after the reference ("…9001 to Kenya") stay.
function readDigits(spoken: string, count: number): { digits: string; end: number } | null {
  const token = new RegExp(`(?:${SEPARATOR})?(${DIGIT_TOKEN})\\b`, 'giy');
  let digits = '';
  let end = 0;
  let found: RegExpExecArray | null;
  while (digits.length < count && (found = token.exec(spoken))) {
    digits += tokenDigits(found[1] ?? '');
    end = token.lastIndex;
  }
  return digits.length === count ? { digits, end } : null;
}

export function normalizeSpokenReferences(text: string): { text: string; replaced: string[] } {
  const replaced: string[] = [];
  let result = text;
  for (const rule of PREFIXES) {
    const pattern = new RegExp(String.raw`\b(?:${rule.pattern})(?:\s+(?:of|number|no\.?))?(?:\s*(?:-|dash|hyphen)\s*|\s+|(?=\d))(${DIGIT_TOKEN}(?:${SEPARATOR}${DIGIT_TOKEN}){0,${rule.digits - 1}})\b`, 'gi');
    result = result.replace(pattern, (match, digitPart: string) => {
      const read = readDigits(digitPart, rule.digits);
      if (!read) return match;
      const canonical = `${rule.canonical}-${read.digits}`;
      const consumed = match.slice(0, match.length - digitPart.length + read.end);
      replaced.push(`${consumed.trim()} → ${canonical}`);
      return canonical + digitPart.slice(read.end);
    });
  }
  return { text: result, replaced };
}

// The other direction, for the voice only: text-to-speech reads "TXN-9001" as "TXN minus nine
// thousand and one". Spelled out letter by letter and digit by digit, it is read the way a
// caller would say it back.
const CANONICAL_REFERENCE = new RegExp(String.raw`\b(${PREFIXES.map((rule) => rule.canonical).join('|')})-(\d+)\b`, 'g');

export function speakableReferences(text: string): string {
  return text.replace(CANONICAL_REFERENCE, (_match, prefix: string, digits: string) =>
    `${prefix.split('').join(' ')} ${[...digits].map((digit) => DIGIT_NAMES[Number(digit)]).join(' ')}`,
  );
}
