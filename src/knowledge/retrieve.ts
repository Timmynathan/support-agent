import type { KnowledgeChunk } from './knowledgeBase.js';

// BM25 keyword ranking over the knowledge-base chunks. The KB is one ~12 KB file of ~45 short
// chunks; this is the "prove simple is insufficient first" baseline from the kickoff.

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2;
export const TOP_K = 3;
// Below this a chunk shares only incidental words with the query. Tuned against the nine test
// scenarios plus off-topic probes (see scripts/retrieval-check.ts) — change it only with that run.
export const MIN_SCORE = 2.5;

const STOPWORDS = new Set(
  ('a an and are as at be by can could do does for from has have how i if in is it its me my of on or our ' +
    'please should so that the their them there this to us was we what when where which who why will with ' +
    'would you your yes no not tell know about any get')
    .split(' '),
);

// Callers and the KB use different words for the same thing. Each spoken word maps onto the
// KB's vocabulary; the KB text itself is never rewritten.
const SYNONYMS: Record<string, string[]> = {
  stuck: ['delay'],
  late: ['delay'],
  slow: ['delay'],
  cost: ['fee'],
  price: ['fee'],
  pricing: ['fee'],
  charge: ['fee'],
  arrive: ['process', 'timeline'],
  arrival: ['process', 'timeline'],
  long: ['timeline'],
  suspend: ['restrict', 'suspension'],
  suspension: ['restrict'],
  frozen: ['restrict'],
  blocked: ['restrict'],
  kyc: ['verification', 'identity'],
  verify: ['verification'],
  refund: ['refund', 'dispute'],
  cancel: ['cancellation'],
  crypto: ['cryptocurrency'],
  bitcoin: ['cryptocurrency'],
  international: ['international', 'cross-border'],
  guaranteed: ['guarantee'],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

// Deliberately crude: enough to match "fees"/"fee", "payouts"/"payout", "delayed"/"delay".
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function expandQuery(tokens: string[]): string[] {
  return [...new Set(tokens.flatMap((token) => [token, ...(SYNONYMS[token] ?? []).map(stem)]))];
}

export interface RetrievalHit {
  chunk: KnowledgeChunk;
  score: number;
}

export interface Retriever {
  search(query: string): RetrievalHit[];
}

export function buildRetriever(chunks: KnowledgeChunk[]): Retriever {
  const docs = chunks.map((chunk) => {
    const titleTokens = tokenize(chunk.title);
    const tokens = [...tokenize(chunk.text), ...Array.from({ length: TITLE_WEIGHT - 1 }, () => titleTokens).flat()];
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    return { chunk, length: tokens.length, freq };
  });
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
  const docFreq = new Map<string, number>();
  for (const doc of docs) for (const token of doc.freq.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);

  const idf = (token: string) => {
    const n = docFreq.get(token) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };

  return {
    search(query) {
      const terms = expandQuery(tokenize(query));
      return docs
        .map((doc) => {
          let score = 0;
          for (const term of terms) {
            const tf = doc.freq.get(term) ?? 0;
            if (tf === 0) continue;
            score += idf(term) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength)));
          }
          return { chunk: doc.chunk, score };
        })
        .filter((hit) => hit.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K);
    },
  };
}
