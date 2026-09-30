// Voice widget. Holds only the Vapi public key and assistant id (fetched from /config.json);
// every support decision happens on the server behind Vapi.
import * as VapiModule from 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.7.1/+esm';

const Vapi = VapiModule.default?.default ?? VapiModule.default;

const el = {
  console: document.getElementById('console'),
  callButton: document.getElementById('call-button'),
  callLabel: document.getElementById('call-label'),
  statusText: document.getElementById('status-text'),
  timer: document.getElementById('timer'),
  muteButton: document.getElementById('mute-button'),
  muteLabel: document.getElementById('mute-label'),
  micHint: document.getElementById('mic-hint'),
  levelRing: document.getElementById('level-ring'),
  error: document.getElementById('error'),
  errorText: document.getElementById('error-text'),
  errorDetailsWrap: document.getElementById('error-details-wrap'),
  errorDetails: document.getElementById('error-details'),
  captionCaller: document.getElementById('caption-caller'),
  captionAgent: document.getElementById('caption-agent'),
  chips: [...document.querySelectorAll('.chip')],
};

// Every state has its own words; "unavailable", "ended" and "error" never look the same.
const STATES = {
  loading: { status: 'Preparing…', label: 'Start call', action: 'Start call', enabled: false, inCall: false },
  unavailable: { status: 'Voice support is unavailable', label: 'Unavailable', action: 'Start call', enabled: false, inCall: false },
  ready: { status: 'Ready when you are', label: 'Start call', action: 'Start call', enabled: true, inCall: false },
  connecting: { status: 'Connecting…', label: 'Connecting', action: 'Cancel call', enabled: true, inCall: true },
  listening: { status: 'Listening', label: 'End call', action: 'End call', enabled: true, inCall: true },
  speaking: { status: 'RelayPay is speaking', label: 'End call', action: 'End call', enabled: true, inCall: true },
  ended: { status: 'Call ended', label: 'Call again', action: 'Start a new call', enabled: true, inCall: false },
  error: { status: 'The call could not continue', label: 'Try again', action: 'Try again', enabled: true, inCall: false },
};

// Why Vapi ended the call, in words a caller can act on. Anything not listed shows the raw reason.
const ENDED_REASONS = {
  'call.in-progress.error-assistant-did-not-receive-customer-audio':
    "We couldn't hear your microphone. Check that this page is allowed to use it, that the right microphone is selected, and that it isn't muted, then try again.",
  'pipeline-error-custom-llm-500-server-error': 'The support service could not be reached. Please try again in a moment.',
};

const MIC_HINT_AFTER_MS = 6000;
const MIC_HEARD_LEVEL = 0.02;
const GREETING_FALLBACK_MS = 8000;
const LEVEL_SMOOTHING = 0.35;
const LEVEL_RING_GROWTH = 0.45;
const CAPTION_SWAP_MS = 120;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let vapi = null;
let assistantId = null;
let state = 'loading';
let endedReason = null;
let callStartedAt = 0;
let timerInterval = null;
let micHintTimer = null;
let micHeard = false;
let pendingQuestion = null;
let greetingDone = false;
let greetingFallback = null;
const level = { mic: 0, agent: 0, shown: 0, frame: 0 };

// ── State ──────────────────────────────────────────────────────────

function setState(name) {
  state = name;
  const s = STATES[name];
  el.console.dataset.state = name;
  el.console.dataset.inCall = String(s.inCall);
  el.statusText.textContent = s.status;
  el.callLabel.textContent = s.label;
  el.callButton.setAttribute('aria-label', s.action);
  el.callButton.disabled = !s.enabled;
  el.muteButton.hidden = !(name === 'listening' || name === 'speaking');
  el.timer.hidden = !(name === 'listening' || name === 'speaking');
  for (const chip of el.chips) chip.disabled = !(s.enabled || s.inCall) || name === 'connecting';
  if (!s.inCall) stopCallEffects();
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

// ── Captions ───────────────────────────────────────────────────────

// A new utterance crossfades in (blur bridges old and new); updates within one utterance, like
// live partial words, change in place so the text doesn't flicker.
function setCaption(node, text, { partial = false, tag = null, newUtterance = true } = {}) {
  const apply = () => {
    node.textContent = text;
    if (tag) {
      const span = document.createElement('span');
      span.className = 'caption-tag';
      span.textContent = tag;
      node.append(span);
    }
    node.classList.toggle('is-partial', partial);
    node.classList.remove('is-empty', 'is-changing');
  };
  if (!newUtterance || reduceMotion.matches) {
    apply();
    return;
  }
  node.classList.add('is-changing');
  setTimeout(apply, CAPTION_SWAP_MS);
}

let callerUtteranceOpen = false;

function onTranscript(message) {
  if (message.role === 'user') {
    const final = message.transcriptType === 'final';
    setCaption(el.captionCaller, message.transcript, { partial: !final, newUtterance: !callerUtteranceOpen });
    callerUtteranceOpen = !final;
    return;
  }
  if (message.role === 'assistant' && message.transcriptType === 'final') {
    setCaption(el.captionAgent, message.transcript);
  }
}

// ── Level ring and timer ───────────────────────────────────────────

// Smooths the audio level and sets the ring's transform directly each frame.
function animateLevel() {
  const target = state === 'speaking' ? level.agent : level.mic;
  level.shown += (target - level.shown) * LEVEL_SMOOTHING;
  if (!reduceMotion.matches) el.levelRing.style.transform = `scale(${1 + level.shown * LEVEL_RING_GROWTH})`;
  level.frame = requestAnimationFrame(animateLevel);
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function startCallEffects() {
  callStartedAt = Date.now();
  el.timer.textContent = '0:00';
  timerInterval = setInterval(() => (el.timer.textContent = formatElapsed(Date.now() - callStartedAt)), 1000);
  micHeard = false;
  el.micHint.hidden = true;
  micHintTimer = setTimeout(() => {
    if (!micHeard) el.micHint.hidden = false;
  }, MIC_HINT_AFTER_MS);
  cancelAnimationFrame(level.frame);
  level.frame = requestAnimationFrame(animateLevel);
}

function stopCallEffects() {
  clearInterval(timerInterval);
  clearTimeout(micHintTimer);
  clearTimeout(greetingFallback);
  cancelAnimationFrame(level.frame);
  level.mic = level.agent = level.shown = 0;
  el.levelRing.style.transform = '';
  el.micHint.hidden = true;
  el.muteButton.setAttribute('aria-pressed', 'false');
  el.muteLabel.textContent = 'Mute';
}

// ── Typed questions ────────────────────────────────────────────────

// Adds a question to the live call as if the caller had said it. Before the call, it waits for
// the greeting to finish so the question isn't talked over.
function askTyped(question) {
  setCaption(el.captionCaller, question, { tag: 'typed' });
  callerUtteranceOpen = false;
  vapi.send({ type: 'add-message', message: { role: 'user', content: question }, triggerResponseEnabled: true });
}

function flushPendingQuestion() {
  if (!pendingQuestion) return;
  const question = pendingQuestion;
  pendingQuestion = null;
  askTyped(question);
}

async function onChip(question) {
  if (state === 'listening' || state === 'speaking') {
    askTyped(question);
    return;
  }
  pendingQuestion = question;
  await startCall();
}

// ── Call ───────────────────────────────────────────────────────────

function attachEvents() {
  vapi.on('call-start', () => {
    setState('listening');
    startCallEffects();
    greetingDone = false;
    greetingFallback = setTimeout(() => {
      greetingDone = true;
      flushPendingQuestion();
    }, GREETING_FALLBACK_MS);
  });
  vapi.on('call-end', () => {
    const expected = !endedReason || /customer-ended-call|assistant-ended-call/.test(endedReason);
    if (expected) {
      setState('ended');
      return;
    }
    setState('error');
    showError(ENDED_REASONS[endedReason] ?? 'The call ended unexpectedly. Please try again.', `Vapi ended reason: ${endedReason}`);
  });
  vapi.on('speech-start', () => {
    if (state === 'listening') setState('speaking');
  });
  vapi.on('speech-end', () => {
    if (state === 'speaking') setState('listening');
    if (!greetingDone) {
      greetingDone = true;
      clearTimeout(greetingFallback);
      flushPendingQuestion();
    }
  });
  vapi.on('volume-level', (value) => (level.agent = value));
  vapi.on('local-volume-level', (value) => {
    level.mic = value;
    if (value > MIC_HEARD_LEVEL && !micHeard) {
      micHeard = true;
      el.micHint.hidden = true;
    }
  });
  vapi.on('message', (message) => {
    if (message?.type === 'status-update' && message.status === 'ended' && typeof message.endedReason === 'string') {
      endedReason = message.endedReason;
    }
    if (message?.type === 'transcript') onTranscript(message);
  });
  vapi.on('error', (error) => {
    setState('error');
    showError('Something interrupted the call. Please try again.', describe(error));
  });
}

async function startCall() {
  clearError();
  endedReason = null;
  setState('connecting');
  try {
    await vapi.start(assistantId);
  } catch (error) {
    pendingQuestion = null;
    setState('error');
    const text = describe(error);
    const micBlocked = /permission|notallowed|denied/i.test(text);
    showError(
      micBlocked ? 'Microphone access was blocked. Allow microphone access for this page and try again.' : 'The call could not be started. Please try again.',
      text,
    );
  }
}

async function onCallButton() {
  if (STATES[state].inCall) {
    pendingQuestion = null;
    await vapi.stop();
    return;
  }
  await startCall();
}

function onMute() {
  const muted = !vapi.isMuted();
  vapi.setMuted(muted);
  el.muteLabel.textContent = muted ? 'Unmute' : 'Mute';
  el.muteButton.setAttribute('aria-pressed', String(muted));
}

async function init() {
  setState('loading');
  try {
    const response = await fetch('/config.json');
    if (!response.ok) throw new Error(`config request failed with ${response.status}`);
    const config = await response.json();
    assistantId = config.assistantId;
    vapi = new Vapi(config.publicKey);
    attachEvents();
    setState('ready');
  } catch (error) {
    setState('unavailable');
    showError('Voice support could not be loaded. Please refresh the page or try again later.', describe(error));
  }
}

el.callButton.addEventListener('click', () => void onCallButton());
el.muteButton.addEventListener('click', onMute);
for (const chip of el.chips) chip.addEventListener('click', () => void onChip(chip.dataset.question));
void init();
