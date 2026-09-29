// Shows what retrieval returns for every test-scenario question plus off-topic probes, so the
// MIN_SCORE threshold and synonym list are judged against real queries, not assumed.
import { loadKnowledgeBase } from '../src/knowledge/knowledgeBase.js';
import { buildRetriever, MIN_SCORE, TOP_K } from '../src/knowledge/retrieve.js';

const QUERIES: Array<[string, string]> = [
  ['S1 fees', 'What fees does RelayPay charge for international payments?'],
  ['S2 stuck', 'My payment is stuck.'],
  ['S3 account', 'I am Amara from LagosLedger. Can you check my account?'],
  ['S4 transaction', 'Can you check transaction TXN-9001?'],
  ['S5 payout', 'What is happening with payout PAY-7002?'],
  ['S6 invoice failed', 'My invoice payment failed and I need someone to look at it.'],
  ['S7 restricted', 'My account was restricted and nobody is helping me.'],
  ['S8 guarantee', 'Can RelayPay guarantee my payout arrives by 9am tomorrow?'],
  ['probe crypto', 'Can I pay my contractors in bitcoin?'],
  ['probe exchange', 'Are your exchange rates fixed?'],
  ['off-topic weather', "What's the weather like in Lagos today?"],
  ['off-topic tax', 'Should I register my company in Delaware for tax reasons?'],
  ['off-topic interest', 'What interest rate do you pay on balances?'],
];

const chunks = loadKnowledgeBase();
const retriever = buildRetriever(chunks);
process.stdout.write(`${chunks.length} chunks, top ${TOP_K}, min score ${MIN_SCORE}\n`);
for (const [label, query] of QUERIES) {
  const hits = retriever.search(query);
  process.stdout.write(`\n${label.padEnd(20)} "${query}"\n`);
  if (hits.length === 0) process.stdout.write('    (no chunk above threshold)\n');
  for (const hit of hits) process.stdout.write(`    ${hit.score.toFixed(2).padStart(6)}  ${hit.chunk.title}\n`);
}
