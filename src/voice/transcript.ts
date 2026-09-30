// Speech-to-text turns "TXN-9001" into things like "t x n nine zero zero one" or "TXN 90 01".
// This rewrites the recognisable shapes back into canonical references before the agent sees
// them. It only ever produces a reference when the result has exactly the right number of
// digits; anything else is left alone for the agent to ask about, rather than guessed.

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4',
  five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
};

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

const DIGIT_TOKEN = String.raw`(?:\d+|${Object.keys(DIGIT_WORDS).join('|')})`;

export function normalizeSpokenReferences(text: string): { text: string; replaced: string[] } {
  const replaced: string[] = [];
  let result = text;
  for (const rule of PREFIXES) {
    const pattern = new RegExp(String.raw`\b(?:${rule.pattern})(?:\s+(?:of|number|no\.?))?(?:\s*(?:-|dash|hyphen)\s*|\s+|(?=\d))(${DIGIT_TOKEN}(?:[\s-]+${DIGIT_TOKEN}){0,${rule.digits - 1}})\b`, 'gi');
    result = result.replace(pattern, (match, digitPart: string) => {
      const digits = digitPart
        .trim()
        .split(/[\s-]+/)
        .map((token) => (/^\d+$/.test(token) ? token : DIGIT_WORDS[token.toLowerCase()] ?? ''))
        .join('');
      if (digits.length !== rule.digits) return match;
      const canonical = `${rule.canonical}-${digits}`;
      replaced.push(`${match.trim()} → ${canonical}`);
      return canonical;
    });
  }
  return { text: result, replaced };
}
