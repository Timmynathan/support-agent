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
  doneButton: document.getElementById('done-button'),
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
// "Done speaking": Vapi's web SDK has no end-of-turn command, so the button mutes the mic and
// Vapi's endpointing hears the silence at once. The mic comes back when Relay starts to reply
// (so the caller can still interrupt), or after this long if no reply starts.
const DONE_UNMUTE_FALLBACK_MS = 10000;
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
let doneHold = null;
let doneMutedMic = false;
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
  refreshDoneButton();
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
// One caller bubble per turn: speech-to-text sends a sentence as several final pieces when the
// caller pauses (spelling a reference, say), and they belong together until Relay replies.
// `awaitingReply` is true from the caller's words until Relay's first reply to them.
const chat = { callerBubble: null, callerText: '', relayBubble: null, awaitingReply: false };
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
  chat.callerText = '';
  chat.relayBubble = null;
  chat.awaitingReply = false;
}

function onTranscript(message) {
  if (message.role === 'user') {
    const final = message.transcriptType === 'final';
    const text = [chat.callerText, message.transcript].filter(Boolean).join(' ');
    if (chat.callerBubble) setBubbleText(chat.callerBubble, text, { partial: !final });
    else chat.callerBubble = addBubble('caller', text, { partial: !final });
    refreshDoneButton();
    if (!final) return;
    chat.callerText = text;
    chat.relayBubble = null;
    chat.awaitingReply = true;
    // The caller has finished a sentence: Relay is working on the answer until it speaks.
    if (state === 'listening') setState('thinking');
    return;
  }
  if (message.role === 'assistant' && message.transcriptType === 'final') {
    chat.callerBubble = null;
    chat.callerText = '';
    chat.awaitingReply = false;
    refreshDoneButton();
    if (!chat.relayBubble) chat.relayBubble = addBubble('relay', '');
    const said = [chat.relayBubble.dataset.said, message.transcript].filter(Boolean).join(' ');
    chat.relayBubble.dataset.said = said;
    renderRelayText(chat.relayBubble, said);
    const wanted = TYPE_REQUEST.exec(said);
    if (wanted) requestTyping(wanted[1].toLowerCase() === 'email' ? 'email' : 'customer_id');
  }
}

// ── References in Relay's words ────────────────────────────────────

// Vapi shows what the voice said, formatted for reading: a reference spoken as "T K T zero zero
// zero one three" arrives as "T K T 0 0 0 1 3" (or with "dash"). This turns it back into the
// one written form, TKT-00013. It looks like the server's reader (src/voice/transcript.ts) but
// reads different input — Vapi's display text, not a caller's speech — so it stays separate.
const REFERENCE_DIGITS = { TXN: 4, PAY: 4, CUS: 4, TKT: 5, ESC: 5 };
const DIGIT_WORDS = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
const SPACED_PREFIX = Object.keys(REFERENCE_DIGITS).map((prefix) => prefix.split('').join('[\\s.]+')).join('|');
const REFERENCE_START = new RegExp(`\\b(${SPACED_PREFIX}|TXN|CUS|TKT|ESC|PAY(?=\\s*-))\\b(?:[\\s.]*(?:-|dash|hyphen|minus|negative)[\\s.]*|[\\s.]+)`, 'gi');
const DISPLAY_DIGIT = /^[\s,-]*(\d+|zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/i;
const TYPE_REQUEST = /\btype your (email|customer id)\b/i;

// Splits text into plain runs and references: [{ text }, { reference, text }, …].
function findReferences(text) {
  const parts = [];
  let plainFrom = 0;
  for (const match of text.matchAll(REFERENCE_START)) {
    if (match.index < plainFrom) continue;
    const prefix = match[1].replace(/[\s.]/g, '').toUpperCase();
    let cursor = match.index + match[0].length;
    let digits = '';
    while (digits.length < REFERENCE_DIGITS[prefix]) {
      const digit = DISPLAY_DIGIT.exec(text.slice(cursor));
      if (!digit) break;
      const value = /\d/.test(digit[1]) ? digit[1] : DIGIT_WORDS[digit[1].toLowerCase()];
      if (digits.length + value.length > REFERENCE_DIGITS[prefix]) break;
      digits += value;
      cursor += digit[0].length;
    }
    if (digits.length !== REFERENCE_DIGITS[prefix]) continue;
    parts.push({ text: text.slice(plainFrom, match.index) });
    parts.push({ reference: `${prefix}-${digits}` });
    plainFrom = cursor;
  }
  parts.push({ text: text.slice(plainFrom) });
  return parts.filter((part) => part.reference || part.text);
}

function renderRelayText(item, text) {
  const follow = nearBottom();
  const body = item.querySelector('.chat-text');
  body.replaceChildren(...findReferences(text).map((part) => (part.reference ? referenceChip(part.reference) : document.createTextNode(part.text))));
  if (follow) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

const COPIED_FOR_MS = 1600;

// A reference the caller may need later (a ticket number, say): shown highlighted, copied on click.
function referenceChip(reference) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ref-chip';
  chip.setAttribute('aria-label', `Copy ${reference}`);
  const value = document.createElement('span');
  value.className = 'ref-chip-value';
  value.textContent = reference;
  const hint = document.createElement('span');
  hint.className = 'ref-chip-hint';
  hint.textContent = 'Copy';
  chip.append(value, hint);
  chip.addEventListener('click', () => void copyReference(chip, hint, reference));
  return chip;
}

async function copyReference(chip, hint, reference) {
  try {
    await navigator.clipboard.writeText(reference);
    hint.textContent = 'Copied';
    chip.dataset.copied = 'true';
  } catch {
    // No clipboard access (an insecure page or a denied permission): say so, and select the
    // text so it can still be copied by hand.
    hint.textContent = 'Press Ctrl+C';
    getSelection()?.selectAllChildren(chip.querySelector('.ref-chip-value'));
  }
  setTimeout(() => {
    hint.textContent = 'Copy';
    delete chip.dataset.copied;
  }, COPIED_FOR_MS);
}

// ── Typing what shouldn't be spoken ────────────────────────────────

const DEFAULT_PLACEHOLDER = 'Type a question for Relay…';
const TYPE_PROMPTS = {
  email: { placeholder: 'Type your email here…', inputMode: 'email', autocomplete: 'email' },
  customer_id: { placeholder: 'Type your customer ID here…', inputMode: 'text', autocomplete: 'off' },
};

// Relay asked for an email or customer ID to be typed: point the caller at the chat box.
function requestTyping(kind) {
  if (el.chatForm.dataset.requested === kind) return;
  const prompt = TYPE_PROMPTS[kind];
  el.chatForm.dataset.requested = kind;
  el.chatInput.placeholder = prompt.placeholder;
  el.chatInput.inputMode = prompt.inputMode;
  el.chatInput.autocomplete = prompt.autocomplete;
  if (!el.chatInput.disabled) el.chatInput.focus();
}

function clearTypingRequest() {
  delete el.chatForm.dataset.requested;
  el.chatInput.placeholder = DEFAULT_PLACEHOLDER;
  el.chatInput.inputMode = 'text';
  el.chatInput.autocomplete = 'off';
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
  releaseDoneHold();
  clearTypingRequest();
}

// ── Done speaking ──────────────────────────────────────────────────

// Shown while it is the caller's turn and they have said something Relay hasn't answered yet.
function refreshDoneButton() {
  const callersTurn = state === 'listening' || state === 'thinking';
  el.doneButton.hidden = !callersTurn || !chat.callerBubble || doneHold !== null;
  el.doneButton.disabled = el.doneButton.hidden;
}

function onDone() {
  if (!vapi || doneHold) return;
  // Only unmute later what this button muted: a caller who muted themselves stays muted.
  doneMutedMic = !vapi.isMuted();
  if (doneMutedMic) vapi.setMuted(true);
  doneHold = setTimeout(releaseDoneHold, DONE_UNMUTE_FALLBACK_MS);
  if (state === 'listening') setState('thinking');
  refreshDoneButton();
}

function releaseDoneHold() {
  if (doneHold) clearTimeout(doneHold);
  doneHold = null;
  if (doneMutedMic && vapi?.isMuted()) vapi.setMuted(false);
  doneMutedMic = false;
  refreshDoneButton();
}

// ── Typed questions ────────────────────────────────────────────────

// Adds a question to the live call as if the caller had said it. Before the call, it waits for
// the greeting to finish so the question isn't talked over.
function askTyped(question) {
  addBubble('caller', question, { tag: 'typed' });
  chat.callerBubble = null;
  chat.relayBubble = null;
  chat.awaitingReply = true;
  clearTypingRequest();
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
    // Vapi's reason often arrives after the call has ended, or not at all, so a caller left
    // without a reply also counts as a call that went wrong — never a quiet "ended".
    const unanswered = chat.awaitingReply;
    const endedNormally = /customer-ended-call|assistant-ended-call|assistant-said-end-call-phrase/.test(endedReason ?? '');
    const failed = endedReason ? !endedNormally : unanswered;
    addDivider(failed ? 'Call dropped before Relay could answer' : 'Conversation ended');
    if (!failed) {
      setState('ended');
      return;
    }
    setState('error');
    showError(
      ENDED_REASONS[endedReason] ?? 'The call ended before Relay could answer. Please try again.',
      `Vapi ended reason: ${endedReason ?? 'not reported to the browser'}`,
    );
  });
  vapi.on('speech-start', () => {
    releaseDoneHold();
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
  // Pressing Mute while "Done speaking" holds the mic: the caller now wants it muted for good.
  if (doneHold) {
    clearTimeout(doneHold);
    doneHold = null;
    doneMutedMic = false;
    el.muteLabel.textContent = 'Unmute';
    el.muteButton.setAttribute('aria-pressed', 'true');
    refreshDoneButton();
    return;
  }
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
el.doneButton.addEventListener('click', onDone);
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
// The dock grows during a call (status row, conversation thread); the page keeps exactly that
// much room below its content, so nothing ends up permanently underneath it.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--dock-clearance', `${Math.ceil(entry.borderBoxSize[0].blockSize)}px`);
}).observe(document.querySelector('.dock'));
void init();
