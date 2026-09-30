// Simulates Vapi against the local voice listener, so the voice path can be verified without
// Vapi, a tunnel or a microphone: signed webhooks, streaming custom-LLM requests, a caller who
// interrupts, and every authentication failure (each must be refused).
//
//   npm run voice-sim            (server must be running with the same VAPI_* secrets)
import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.VOICE_URL ?? 'http://127.0.0.1:8788';
const LLM_SECRET = process.env.VAPI_LLM_SECRET ?? '';
const WEBHOOK_SECRET = process.env.VAPI_WEBHOOK_SECRET ?? '';
const callId = `sim-${randomUUID()}`;
let failures = 0;

function expect(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

function signed(body: string, secret = WEBHOOK_SECRET, timestamp = String(Date.now())) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { 'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature };
}

async function webhook(message: Record<string, unknown>, headers?: Record<string, string>): Promise<number> {
  const body = JSON.stringify({ message: { ...message, call: { id: callId } } });
  const response = await fetch(`${BASE}/vapi/webhook`, { method: 'POST', headers: headers ?? signed(body), body });
  return response.status;
}

const history: Array<{ role: string; content: string }> = [{ role: 'assistant', content: "Hello, you've reached RelayPay support. How can I help you today?" }];

// Sends one caller turn the way Vapi does and reads the SSE stream, timing the first words.
async function turn(callerText: string, options: { abortAfterFirstChunk?: boolean; token?: string } = {}) {
  history.push({ role: 'user', content: callerText });
  const controller = new AbortController();
  const started = performance.now();
  const response = await fetch(`${BASE}/vapi/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token ?? LLM_SECRET}` },
    body: JSON.stringify({ model: 'relaypay-agent', stream: true, messages: [{ role: 'system', content: 'voice' }, ...history], call: { id: callId } }),
    signal: controller.signal,
  });
  if (!response.ok || !response.body) return { status: response.status, text: '', firstMs: null as number | null, totalMs: 0, done: false };

  let text = '';
  let firstMs: number | null = null;
  let done = false;
  const decoder = new TextDecoder();
  try {
    for await (const bytes of response.body) {
      for (const line of decoder.decode(bytes as Uint8Array, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          done = true;
          continue;
        }
        const content = JSON.parse(data).choices?.[0]?.delta?.content;
        if (!content) continue;
        firstMs ??= Math.round(performance.now() - started);
        text += content;
        if (options.abortAfterFirstChunk) controller.abort();
      }
    }
  } catch (error) {
    if (!options.abortAfterFirstChunk) throw error;
  }
  history.push({ role: 'assistant', content: text.trim() });
  return { status: response.status, text: text.trim(), firstMs, totalMs: Math.round(performance.now() - started), done };
}

async function main(): Promise<void> {
  if (!LLM_SECRET || !WEBHOOK_SECRET) throw new Error('VAPI_LLM_SECRET and VAPI_WEBHOOK_SECRET must be set (same values as the server)');
  process.stdout.write(`call ${callId}\n\n— authentication (each must be refused)\n`);

  expect('model request without token → 401', (await turn('hello', { token: '' })).status === 401, '');
  history.pop();
  expect('model request with wrong token → 401', (await turn('hello', { token: 'wrong' })).status === 401, '');
  history.pop();
  const body = JSON.stringify({ message: { type: 'status-update', status: 'in-progress', call: { id: callId } } });
  expect('webhook with wrong secret → 401', (await webhook({ type: 'status-update', status: 'in-progress' }, signed(body, 'wrong-secret'))) === 401, '');
  expect('webhook with stale timestamp → 401', (await webhook({ type: 'status-update', status: 'in-progress' }, signed(body, WEBHOOK_SECRET, String(Date.now() - 10 * 60 * 1000)))) === 401, '');
  expect('webhook with no signature → 401', (await webhook({ type: 'status-update', status: 'in-progress' }, { 'content-type': 'application/json' })) === 401, '');
  const textRoute = await fetch(`${BASE}/chat`, { method: 'POST', body: '{"message":"hi"}' });
  expect('text channel is not reachable on the voice listener → 404', textRoute.status === 404, `got ${textRoute.status}`);

  process.stdout.write('\n— call\n');
  const warmStarted = performance.now();
  expect('signed call-started webhook → 200 (warms the agent)', (await webhook({ type: 'status-update', status: 'in-progress' })) === 200, '');
  // Vapi speaks its greeting while the agent warms up; a real caller starts talking after it.
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const turns: Array<[string, { abortAfterFirstChunk?: boolean }]> = [
    ['What fees does RelayPay charge for international payments?', {}],
    ['Can you check transaction t x n nine zero zero one?', {}],
    ['Are exchange rates fixed?', { abortAfterFirstChunk: true }],
    ['Sorry, I interrupted you. Can RelayPay guarantee my payout arrives by 9am tomorrow?', {}],
  ];
  for (const [text, options] of turns) {
    const result = await turn(text, options);
    process.stdout.write(`\ncaller: ${text}${options.abortAfterFirstChunk ? '   [caller interrupts after the first words]' : ''}\n`);
    process.stdout.write(`agent:  ${result.text || '(nothing)'}\n`);
    process.stdout.write(`        first words ${result.firstMs ?? '—'} ms, stream ${options.abortAfterFirstChunk ? 'aborted' : `complete ${result.totalMs} ms, [DONE] ${result.done ? 'yes' : 'NO'}`}\n`);
    if (!options.abortAfterFirstChunk) expect('turn streamed and finished', result.status === 200 && result.done && result.text.length > 0, '');
  }

  expect('signed end-of-call webhook → 200', (await webhook({ type: 'end-of-call-report', endedReason: 'customer-ended-call' })) === 200, '');
  process.stdout.write(`\nconversation id: vapi-${callId}   (${Math.round(performance.now() - warmStarted)} ms since call start)\n`);
  process.stdout.write(`${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}\n`);
  if (failures > 0) process.exitCode = 1;
}

await main();
