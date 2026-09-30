// Voice widget. Holds only the Vapi public key and assistant id (fetched from /config.json);
// every support decision happens on the server behind Vapi.
import * as VapiModule from 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.7.1/+esm';

const Vapi = VapiModule.default?.default ?? VapiModule.default;

const el = {
  console: document.getElementById('console'),
  callButton: document.getElementById('call-button'),
  callLabel: document.getElementById('call-label'),
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  timer: document.getElementById('timer'),
  muteButton: document.getElementById('mute-button'),
  muteLabel: document.getElementById('mute-label'),
  micHint: document.getElementById('mic-hint'),
  mascot: document.getElementById('mascot'),
  error: document.getElementById('error'),
  errorText: document.getElementById('error-text'),
  errorDetailsWrap: document.getElementById('error-details-wrap'),
  errorDetails: document.getElementById('error-details'),
  thread: document.getElementById('thread'),
  threadToggle: document.getElementById('thread-toggle'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  chatSend: document.getElementById('chat-send'),
  chips: [...document.querySelectorAll('.chip')],
};

// Every state has its own words; "unavailable", "ended" and "error" never look the same.
// `face` is what Relay's face does in that state (public/face.js).
const STATES = {
// Labels are short because the call button sits in the chat bar. Each action contains its label
// so the name a screen reader announces matches the visible word.
  loading: { status: 'Preparing…', label: 'Call', action: 'Call Relay', enabled: false, inCall: false, face: 'idle' },
  unavailable: { status: 'Voice support is unavailable', label: 'Unavailable', action: 'Call unavailable', enabled: false, inCall: false, face: 'idle' },
  ready: { status: '', label: 'Call', action: 'Call Relay', enabled: true, inCall: false, face: 'idle' },
  connecting: { status: 'Connecting…', label: 'Cancel', action: 'Cancel call', enabled: true, inCall: true, face: 'connecting' },
  listening: { status: 'Relay is listening', label: 'End', action: 'End call', enabled: true, inCall: true, face: 'listening' },
  thinking: { status: 'Relay is thinking…', label: 'End', action: 'End call', enabled: true, inCall: true, face: 'thinking' },
  speaking: { status: 'Relay is speaking', label: 'End', action: 'End call', enabled: true, inCall: true, face: 'speaking' },
  ended: { status: 'Conversation ended', label: 'Call again', action: 'Call again', enabled: true, inCall: false, face: 'idle' },
  error: { status: 'The call could not continue', label: 'Try again', action: 'Try the call again', enabled: true, inCall: false, face: 'idle' },
};
const LIVE_STATES = new Set(['listening', 'thinking', 'speaking']);

// Why Vapi ended the call, in words a caller can act on. Anything not listed shows the raw reason.
const ENDED_REASONS = {
  'call.in-progress.error-assistant-did-not-receive-customer-audio':
    "We couldn't hear your microphone. Check that this page is allowed to use it, that the right microphone is selected, and that it isn't muted, then try again.",
  'pipeline-error-custom-llm-500-server-error': 'The support service could not be reached. Please try again in a moment.',
};

const MIC_HINT_AFTER_MS = 6000;
// Vapi connects in under a second when the browser's audio gets through; when it doesn't,
// Vapi waits ~15 s and gives up. Past this point, say so instead of spinning silently.
const SLOW_CONNECT_MS = 8000;
const MIC_HEARD_LEVEL = 0.02;
const GREETING_FALLBACK_MS = 8000;
const MIC_HINT_TEXT = "I can't hear you yet. Check that your microphone is on, selected and not muted.";
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let vapi = null;
let assistantId = null;
let state = 'loading';
let endedReason = null;
let callStartedAt = 0;
let timerInterval = null;
let micHintTimer = null;
let slowConnectTimer = null;
let micHeard = false;
let pendingQuestion = null;
let greetingDone = false;
let greetingFallback = null;
let face = null;
const level = { mic: 0, agent: 0 };

// ── State ──────────────────────────────────────────────────────────

function setState(name) {
  state = name;
  const s = STATES[name];
  el.console.dataset.state = name;
  el.console.dataset.inCall = String(s.inCall);
  el.callButton.dataset.state = name;
  el.callButton.dataset.inCall = String(s.inCall);
  el.statusText.textContent = s.status;
  el.status.hidden = !s.status;
  el.callLabel.textContent = s.label;
  el.callButton.setAttribute('aria-label', s.action);
  el.callButton.disabled = !s.enabled;
  el.muteButton.hidden = !LIVE_STATES.has(name);
  el.timer.hidden = !LIVE_STATES.has(name);
  const canAsk = (s.enabled || s.inCall) && name !== 'connecting';
  for (const chip of el.chips) chip.disabled = !canAsk;
  el.chatInput.disabled = !canAsk;
  el.chatSend.disabled = !canAsk;
  face?.setState(s.face);
  feedFaceLevel();
  if (!s.inCall) stopCallEffects();
}

// The face follows whoever is audible: its jaw moves with the agent's voice; while listening it reacts to the caller's mic.
function feedFaceLevel() {
  face?.setLevel(state === 'speaking' ? level.agent : state === 'listening' ? level.mic : 0);
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

// ── Conversation panel ─────────────────────────────────────────────

// The bubble still being spoken into (the caller's live words), and Relay's bubble for the
// current turn; Relay's sentences in one turn join the same bubble.
const chat = { callerBubble: null, relayBubble: null };
// Only follow new messages if the reader is already at the bottom: never yank them away from
// something they scrolled up to read.
const STICK_TO_BOTTOM_PX = 48;

function nearBottom() {
  const log = el.chatLog;
  return log.scrollHeight - log.scrollTop - log.clientHeight < STICK_TO_BOTTOM_PX;
}

function appendToLog(node) {
  const follow = nearBottom();
  el.chatLog.append(node);
  el.thread.hidden = false;
  if (follow) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function addBubble(role, text, { partial = false, tag = null } = {}) {
  const item = document.createElement('li');
  item.className = `chat-message chat-message--${role}`;
  const who = document.createElement('span');
  who.className = 'visually-hidden';
  who.textContent = role === 'caller' ? 'You said: ' : 'Relay said: ';
  const body = document.createElement('p');
  body.className = 'chat-text';
  item.append(who, body);
  setBubbleText(item, text, { partial, tag });
  appendToLog(item);
  return item;
}

function setBubbleText(item, text, { partial = false, tag = null } = {}) {
  const follow = nearBottom();
  const body = item.querySelector('.chat-text');
  body.textContent = text;
  if (tag) {
    const label = document.createElement('span');
    label.className = 'chat-tag';
    label.textContent = tag;
    body.append(label);
  }
  item.classList.toggle('is-partial', partial);
  if (follow) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function addDivider(text) {
  const item = document.createElement('li');
  item.className = 'chat-divider';
  item.textContent = text;
  appendToLog(item);
  chat.callerBubble = null;
  chat.relayBubble = null;
}

function onTranscript(message) {
  if (message.role === 'user') {
    const final = message.transcriptType === 'final';
    if (chat.callerBubble) setBubbleText(chat.callerBubble, message.transcript, { partial: !final });
    else chat.callerBubble = addBubble('caller', message.transcript, { partial: !final });
    if (!final) return;
    chat.callerBubble = null;
    chat.relayBubble = null;
    // The caller has finished a sentence: Relay is working on the answer until it speaks.
    if (state === 'listening') setState('thinking');
    return;
  }
  if (message.role === 'assistant' && message.transcriptType === 'final') {
    if (!chat.relayBubble) {
      chat.relayBubble = addBubble('relay', message.transcript);
      return;
    }
    const current = chat.relayBubble.querySelector('.chat-text').textContent;
    setBubbleText(chat.relayBubble, `${current} ${message.transcript}`);
  }
}

// ── Face and timer ─────────────────────────────────────────────────

// Loaded separately so the call works even if 3D can't: on any failure (no WebGL, the CDN or
// the model not loading) the face stays a still, solid shape, the same one shown while loading.
async function loadFace() {
  try {
    const { createFace } = await import('/face.js');
    face = await createFace(el.mascot, { reduceMotion });
  } catch {
    face = null;
  }
  if (!face) {
    el.mascot.dataset.fallback = 'true';
    return;
  }
  face.setState(STATES[state].face);
  feedFaceLevel();
  el.mascot.dataset.ready = 'true';
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function startCallEffects() {
  clearTimeout(slowConnectTimer);
  el.micHint.textContent = MIC_HINT_TEXT;
  callStartedAt = Date.now();
  el.timer.textContent = '0:00';
  timerInterval = setInterval(() => (el.timer.textContent = formatElapsed(Date.now() - callStartedAt)), 1000);
  micHeard = false;
  el.micHint.hidden = true;
  micHintTimer = setTimeout(() => {
    if (!micHeard) el.micHint.hidden = false;
  }, MIC_HINT_AFTER_MS);
}

function stopCallEffects() {
  clearTimeout(slowConnectTimer);
  clearInterval(timerInterval);
  clearTimeout(micHintTimer);
  clearTimeout(greetingFallback);
  level.mic = level.agent = 0;
  face?.setLevel(0);
  el.micHint.hidden = true;
  el.muteButton.setAttribute('aria-pressed', 'false');
  el.muteLabel.textContent = 'Mute';
}

// ── Typed questions ────────────────────────────────────────────────

// Adds a question to the live call as if the caller had said it. Before the call, it waits for
// the greeting to finish so the question isn't talked over.
function askTyped(question) {
  addBubble('caller', question, { tag: 'typed' });
  chat.callerBubble = null;
  chat.relayBubble = null;
  vapi.send({ type: 'add-message', message: { role: 'user', content: question }, triggerResponseEnabled: true });
  if (state === 'listening') setState('thinking');
}

function flushPendingQuestion() {
  if (!pendingQuestion) return;
  const question = pendingQuestion;
  pendingQuestion = null;
  askTyped(question);
}

async function onAsk(question) {
  if (LIVE_STATES.has(state)) {
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
    addDivider('Conversation started');
    greetingDone = false;
    greetingFallback = setTimeout(() => {
      greetingDone = true;
      flushPendingQuestion();
    }, GREETING_FALLBACK_MS);
  });
  vapi.on('call-end', () => {
    addDivider('Conversation ended');
    const expected = !endedReason || /customer-ended-call|assistant-ended-call/.test(endedReason);
    if (expected) {
      setState('ended');
      return;
    }
    setState('error');
    showError(ENDED_REASONS[endedReason] ?? 'The call ended unexpectedly. Please try again.', `Vapi ended reason: ${endedReason}`);
  });
  vapi.on('speech-start', () => {
    if (state === 'listening' || state === 'thinking') setState('speaking');
  });
  vapi.on('speech-end', () => {
    if (state === 'speaking') setState('listening');
    if (!greetingDone) {
      greetingDone = true;
      clearTimeout(greetingFallback);
      flushPendingQuestion();
    }
  });
  vapi.on('volume-level', (value) => {
    level.agent = value;
    feedFaceLevel();
  });
  vapi.on('local-volume-level', (value) => {
    level.mic = value;
    feedFaceLevel();
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
  clearTimeout(slowConnectTimer);
  slowConnectTimer = setTimeout(() => {
    if (state !== 'connecting') return;
    el.micHint.textContent = 'Still connecting. This is usually the network: if it keeps taking this long, try another connection (a phone hotspot, for example) or turn off any VPN.';
    el.micHint.hidden = false;
  }, SLOW_CONNECT_MS);
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

void loadFace();
el.callButton.addEventListener('click', () => void onCallButton());
el.muteButton.addEventListener('click', onMute);
for (const chip of el.chips) chip.addEventListener('click', () => void onAsk(chip.dataset.question));
// Hiding the thread keeps the bar; the log keeps filling, ready when it is shown again.
el.threadToggle.addEventListener('click', () => {
  const expanded = el.threadToggle.getAttribute('aria-expanded') === 'true';
  el.threadToggle.setAttribute('aria-expanded', String(!expanded));
  el.threadToggle.textContent = expanded ? 'Show' : 'Hide';
  el.chatLog.hidden = expanded;
  if (!expanded) el.chatLog.scrollTop = el.chatLog.scrollHeight;
});
el.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = el.chatInput.value.trim();
  if (!question || el.chatInput.disabled) return;
  el.chatInput.value = '';
  void onAsk(question);
});
void init();
