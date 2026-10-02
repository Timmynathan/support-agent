// Creates or updates the Vapi assistant. Vapi is the voice layer ONLY: every caller turn goes to
// this project's server as a custom LLM, so the assistant below carries no RelayPay knowledge,
// policy or escalation rules. Read VOICE_ONLY_PROMPT: if anything about fees, payouts or
// escalation ever appears in it, the layer boundary has broken.
//
//   npm run vapi-setup            show the config that would be sent, change nothing
//   npm run vapi-setup -- --apply create the assistant (or update VAPI_ASSISTANT_ID)
//
// Needs in .env: VAPI_PRIVATE_KEY, PUBLIC_URL (the tunnel URL), VAPI_WEBHOOK_CREDENTIAL_ID.

import { END_CALL_PHRASE } from '../src/agent/closing.js';

const VAPI_API = 'https://api.vapi.ai';

// Our server ignores this (it answers from its own prompt and rules). It exists because Vapi
// requires a model message, and it says nothing a caller could be harmed by if it leaked.
const VOICE_ONLY_PROMPT = 'You are the voice interface for RelayPay support. Speak the replies you receive exactly as written.';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env`);
  return value;
}

function assistantConfig(publicUrl: string, webhookCredentialId: string) {
  const base = publicUrl.replace(/\/+$/, '');
  return {
    name: 'RelayPay Support Voice',
    // The page opens the verification form when Relay says "verification form".
    firstMessage:
      "Hello, you've reached RelayPay support. To help with your account, please fill in your customer ID and email in the verification form on screen. If you just have a general question, go ahead and ask.",
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'custom-llm',
      // Vapi treats this as an OpenAI baseURL and calls `${url}/chat/completions`.
      url: `${base}/vapi`,
      model: 'relaypay-agent',
      // 'variable' makes Vapi send the call object, whose id keys the conversation.
      metadataSendMode: 'variable',
      // Above the server's own 20 s turn deadline, so the server's fallback line wins.
      timeoutSeconds: 25,
      messages: [{ role: 'system', content: VOICE_ONLY_PROMPT }],
    },
    // Speech recognition vocabulary, not support logic: in the first real call "RelayPay" was
    // transcribed as "the APA" and "Relay pay".
    transcriber: { provider: 'deepgram', model: 'nova-3', keyterm: ['RelayPay', 'TXN', 'payout', 'KYC', 'invoice'] },
    // In the first real call a pause mid-sentence ended the caller's turn, so fragments of one
    // question reached the agent as separate turns. LiveKit endpointing judges whether the caller
    // has finished from what they said, not only from silence (Vapi recommends it for English).
    startSpeakingPlan: { waitSeconds: 0.6, smartEndpointingPlan: { provider: 'livekit' } },
    server: { url: `${base}/vapi/webhook`, credentialId: webhookCredentialId, timeoutSeconds: 10 },
    serverMessages: ['status-update', 'end-of-call-report'],
    maxDurationSeconds: 900,
    // Said only by code, after a caller confirms they're finished (src/agent/closing.ts).
    endCallPhrases: [END_CALL_PHRASE],
    hooks: [
      {
        on: 'customer.speech.timeout',
        options: { timeoutSeconds: 12, triggerMaxCount: 2, triggerResetMode: 'onUserSpeech' },
        do: [{ type: 'say', exact: "Are you still there? I'm here whenever you're ready." }],
      },
    ],
  };
}

async function vapi(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${VAPI_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${required('VAPI_PRIVATE_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function main(): Promise<void> {
  const config = assistantConfig(required('PUBLIC_URL'), required('VAPI_WEBHOOK_CREDENTIAL_ID'));
  const existingId = process.env.VAPI_ASSISTANT_ID;
  process.stdout.write(`${existingId ? `PATCH /assistant/${existingId}` : 'POST /assistant'}\n${JSON.stringify(config, null, 2)}\n`);

  if (!process.argv.includes('--apply')) {
    process.stdout.write('\nDry run: nothing sent. Re-run with --apply to write this to Vapi.\n');
    return;
  }
  const result = existingId ? await vapi('PATCH', `/assistant/${existingId}`, config) : await vapi('POST', '/assistant', config);
  process.stdout.write(`\n${existingId ? 'Updated' : 'Created'} assistant ${String(result.id)}\n`);
  if (!existingId) process.stdout.write(`Add to .env:  VAPI_ASSISTANT_ID=${String(result.id)}\n`);
}

await main();
