// Voice widget. Holds only the Vapi public key and assistant id (fetched from /config.json);
// every support decision happens on the server behind Vapi.
import * as VapiModule from 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.7.1/+esm';

const Vapi = VapiModule.default?.default ?? VapiModule.default;

const el = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  callButton: document.getElementById('call-button'),
  muteButton: document.getElementById('mute-button'),
  error: document.getElementById('error'),
  errorText: document.getElementById('error-text'),
  errorDetailsWrap: document.getElementById('error-details-wrap'),
  errorDetails: document.getElementById('error-details'),
  caption: document.getElementById('caption'),
  captionText: document.getElementById('caption-text'),
};

// Every state has its own words; "unavailable" and "ended" never look the same.
const STATES = {
  loading: { text: 'Loading…', button: 'Start call', enabled: false },
  unavailable: { text: 'Voice support is unavailable', button: 'Start call', enabled: false },
  ready: { text: 'Ready to call', button: 'Start call', enabled: true },
  connecting: { text: 'Connecting…', button: 'Connecting…', enabled: false },
  'in-call': { text: 'Connected. Go ahead and speak.', button: 'End call', enabled: true },
  'agent-speaking': { text: 'Agent is speaking', button: 'End call', enabled: true },
  ended: { text: 'Call ended', button: 'Start a new call', enabled: true },
  error: { text: 'The call could not continue', button: 'Try again', enabled: true },
};

let vapi = null;
let assistantId = null;
let inCall = false;

function setState(name) {
  const state = STATES[name];
  el.status.dataset.state = name === 'agent-speaking' ? 'in-call' : name;
  el.statusText.textContent = state.text;
  el.callButton.textContent = state.button;
  el.callButton.disabled = !state.enabled;
  el.muteButton.hidden = !(name === 'in-call' || name === 'agent-speaking');
}

function showError(message, details) {
  el.errorText.textContent = message;
  el.errorDetails.textContent = details ?? '';
  el.errorDetailsWrap.hidden = !details;
  el.error.hidden = false;
}

function clearError() {
  el.error.hidden = true;
}

// Vapi's error events are nested objects of varying shape; show the readable part plus the raw
// object, never "[object Object]".
function describe(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  const inner = error.error ?? error;
  const readable = [inner?.message, inner?.errorMsg, inner?.msg, error.type].find((value) => typeof value === 'string');
  let raw;
  try {
    raw = JSON.stringify(error);
  } catch {
    raw = String(error);
  }
  return readable ? `${readable} — ${raw}` : raw;
}

// Why Vapi ended the call, in words a caller can act on. Anything not listed shows the raw reason.
const ENDED_REASONS = {
  'call.in-progress.error-assistant-did-not-receive-customer-audio':
    "We couldn't hear your microphone. Check that this page is allowed to use it, that the right microphone is selected, and that it isn't muted, then try again.",
  'pipeline-error-custom-llm-500-server-error': 'The support service could not be reached. Please try again in a moment.',
};
let endedReason = null;

async function loadConfig() {
  const response = await fetch('/config.json');
  if (!response.ok) throw new Error(`config request failed with ${response.status}`);
  return response.json();
}

function attachEvents() {
  vapi.on('call-start', () => {
    inCall = true;
    setState('in-call');
  });
  vapi.on('call-end', () => {
    inCall = false;
    const expected = !endedReason || /customer-ended-call|assistant-ended-call/.test(endedReason);
    if (expected) {
      setState('ended');
      return;
    }
    setState('error');
    showError(ENDED_REASONS[endedReason] ?? 'The call ended unexpectedly. Please try again.', `Vapi ended reason: ${endedReason}`);
  });
  vapi.on('speech-start', () => inCall && setState('agent-speaking'));
  vapi.on('speech-end', () => inCall && setState('in-call'));
  vapi.on('message', (message) => {
    if (message?.type === 'status-update' && message.status === 'ended' && typeof message.endedReason === 'string') {
      endedReason = message.endedReason;
    }
    if (message?.type === 'transcript' && message.role === 'assistant' && message.transcriptType === 'final') {
      el.captionText.textContent = message.transcript;
      el.caption.hidden = false;
    }
  });
  vapi.on('error', (error) => {
    inCall = false;
    setState('error');
    showError('Something interrupted the call. Please try again.', describe(error));
  });
}

async function toggleCall() {
  clearError();
  if (inCall) {
    await vapi.stop();
    return;
  }
  setState('connecting');
  endedReason = null;
  el.caption.hidden = true;
  try {
    await vapi.start(assistantId);
  } catch (error) {
    setState('error');
    const text = describe(error);
    const micBlocked = /permission|notallowed|denied/i.test(text);
    showError(micBlocked ? 'Microphone access was blocked. Allow microphone access for this page and try again.' : 'The call could not be started. Please try again.', text);
  }
}

function toggleMute() {
  const muted = !vapi.isMuted();
  vapi.setMuted(muted);
  el.muteButton.textContent = muted ? 'Unmute' : 'Mute';
  el.muteButton.setAttribute('aria-pressed', String(muted));
}

async function init() {
  setState('loading');
  try {
    const config = await loadConfig();
    assistantId = config.assistantId;
    vapi = new Vapi(config.publicKey);
    attachEvents();
    setState('ready');
  } catch (error) {
    setState('unavailable');
    showError('Voice support could not be loaded. Please refresh the page or try again later.', describe(error));
  }
}

el.callButton.addEventListener('click', () => void toggleCall());
el.muteButton.addEventListener('click', toggleMute);
void init();
