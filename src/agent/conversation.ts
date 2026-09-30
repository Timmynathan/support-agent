import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Channel } from '../shared/domain.js';
import { fromRoot } from '../shared/paths.js';
import { loadKnowledgeBase } from '../knowledge/knowledgeBase.js';
import { buildRetriever, type RetrievalHit } from '../knowledge/retrieve.js';
import * as log from './conversationLog.js';
import { normalizeSpokenReferences } from '../voice/transcript.js';
import { closingLine, withoutEndCallPhrase } from './closing.js';
import { composeTurnMessage, TurnOutput, type AnswerType } from './prompt.js';
import { AgentSession, type SdkTurn, type ToolEvent, type TurnHooks } from './session.js';
import { StructuredSpeechParser } from './speechStream.js';
import { detectTriggers, escalationCategory, type TriggerHit } from './triggers.js';

// A voice caller hears silence while this runs (minus the filler line). The first turn of a
// conversation that wasn't pre-started also pays the ~10 s Claude process start.
export const TURN_DEADLINE_MS = 20_000;

// Fixed lines used when code overrides the model. Written once, here, so what a caller hears
// in a failure or enforced handoff never depends on a model call succeeding.
export const LINES = {
  escalate:
    "This needs one of our support specialists, so I'd like to arrange for someone to contact you. " +
    'Could you tell me your name and a good time for a callback? Please type your email in the chat box below.',
  decline:
    "I'm not able to confirm that from RelayPay's approved information. I can connect you with a specialist who can help, if you'd like.",
  failure:
    "I'm sorry, I'm having trouble checking that right now. Please try again in a moment, or reach RelayPay support through your dashboard.",
  timeout:
    "I'm sorry, this is taking longer than it should. Please try again in a moment, or reach RelayPay support through your dashboard.",
  // Said when a voice turn has produced nothing after ACKNOWLEDGE_AFTER_MS. Neutral on purpose:
  // it comes before answers, lookups and goodbyes alike.
  acknowledge: 'One moment.',
  // Said the moment a lookup starts, if nothing has been said yet.
  checking: 'Let me check that for you.',
} as const;

// A 'social' reply (thanks, goodbye) skips the grounding rule, so it is held to a shape that
// can't carry a claim: short, and with no digits or references in it.
const SOCIAL_MAX_WORDS = 30;
function isSafeSocialReply(text: string): boolean {
  return text.split(/\s+/).length <= SOCIAL_MAX_WORDS && !/\d/.test(text) && !/\b(TXN|PAY|CUS|TKT|ESC)\b/i.test(text);
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_RESPONSE_WORDS = 80;
const AGENT_FALLBACK_LOG = fromRoot('logs', 'agent-fallback.jsonl');

const retriever = buildRetriever(loadKnowledgeBase());

// Where a turn's words go as they become available. The text endpoint has none (it returns the
// whole reply); the voice path streams each sentence to Vapi.
export interface SpeechSink {
  say(text: string): void;
  readonly closed: boolean;
}

export interface TurnInput {
  // What the model and retrieval see (the voice path normalises spoken references into it).
  text: string;
  // What the caller actually said, when it differs; this is what the turn log records.
  rawTranscript?: string;
  sink?: SpeechSink;
}

export interface TurnReply {
  conversation_id: string;
  turn_index: number;
  reply: string;
  answer_type: AnswerType | 'error';
  cited_chunk_ids: string[];
  retrieved_chunk_ids: string[];
  triggers: string[];
  enforced: string[];
  tools: Array<{ name: string; outcome: string }>;
  timings_ms: { total: number; first_speech: number | null; model_api: number | null };
  cost_usd: number | null;
}

interface Verdict {
  answerType: AnswerType;
  citations: string[];
  enforced: string[];
  // Fixed line to say instead of the model's words, when a rule overrides the model.
  override: string | null;
  // The decision needs the full spoken text (reference check), so nothing may stream early.
  needsFullText: boolean;
}

export class Conversation {
  private session: AgentSession;
  private turnIndex = 0;
  private lastCumulativeCost = 0;
  private lastCumulativeApiMs = 0;
  private escalationRequired = false;
  private escalationCreated = false;
  private lastAnswerType: AnswerType | 'error' | null = null;
  private interruptedTurn: number | null = null;
  // The previous turn was cut off before the caller heard any of the actual reply.
  private previousReplyUnheard = false;
  // References returned by successful tools earlier in this conversation (TKT-…, ESC-…, TXN-…).
  private readonly knownReferences = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  lastActivity = Date.now();

  // The conversation row is written alongside the Claude process start, not before it: a slow
  // database must not stop the ~10 s warm-up. The first turn retries the write if it failed.
  private recorded: Promise<boolean>;

  private constructor(readonly id: string, readonly channel: Channel, private readonly callerIdentifier: string | null) {
    this.session = new AgentSession(id, channel);
    this.recorded = this.recordStart();
  }

  static start(id: string, channel: Channel, callerIdentifier: string | null): Promise<Conversation> {
    return Promise.resolve(new Conversation(id, channel, callerIdentifier));
  }

  private async recordStart(): Promise<boolean> {
    try {
      await log.startConversation(this.id, this.channel, this.callerIdentifier);
      return true;
    } catch (error) {
      await writeFallback({ stage: 'start_conversation', conversation_id: this.id, error: describe(error) });
      return false;
    }
  }

  // Turns in one conversation run strictly one after another, so SDK results pair with the
  // message that caused them.
  handle(input: TurnInput): Promise<TurnReply> {
    const run = this.queue.then(() => this.runTurn(input));
    this.queue = run.catch(() => undefined);
    return run;
  }

  // The caller spoke over the agent or hung up mid-answer: stop generating, so the next turn
  // (or the end of the call) isn't stuck behind a reply nobody will hear.
  async interruptCurrentTurn(): Promise<void> {
    this.interruptedTurn = this.turnIndex - 1;
    await this.session.interrupt();
  }

  // Returns false when the final status could not be saved (it goes to the fallback file instead).
  async end(reason: string): Promise<boolean> {
    // Let a turn already in flight finish logging first, but never wait on it for long.
    await Promise.race([this.queue, new Promise((resolve) => setTimeout(resolve, 5000))]);
    this.session.close();
    const status: log.FinalStatus = this.escalationCreated
      ? 'escalated'
      : this.turnIndex === 0
        ? 'abandoned'
        : this.lastAnswerType === 'error'
          ? 'failed'
          : this.lastAnswerType === 'decline'
            ? 'declined'
            : 'resolved';
    const summary = `${this.turnIndex} turn(s); ended: ${reason}; last answer type: ${this.lastAnswerType ?? 'none'}`;
    try {
      await log.endConversation(this.id, status, summary);
      return true;
    } catch (error) {
      await writeFallback({ stage: 'end_conversation', conversation_id: this.id, final_status: status, summary, error: describe(error) });
      return false;
    }
  }

  private async runTurn(input: TurnInput): Promise<TurnReply> {
    const startedAt = Date.now();
    this.lastActivity = startedAt;
    const turnIndex = this.turnIndex++;
    const speaker = new Speaker(input.sink, startedAt);
    const { text } = input;

    if (!(await this.recorded)) this.recorded = this.recordStart();
    await this.recorded;

    let turnId: number;
    try {
      turnId = await log.startTurn(this.id, turnIndex, input.rawTranscript ?? text);
    } catch (error) {
      // Fail closed, like the MCP tools: an answer that can't be logged isn't given.
      await writeFallback({ stage: 'start_turn', conversation_id: this.id, turn_index: turnIndex, error: describe(error) });
      speaker.say(LINES.failure);
      return this.errorReply(turnIndex, startedAt, speaker, LINES.failure, ['log_unavailable']);
    }

    // A dead Claude process (crash, API failure at start-up) would fail every later turn; start a
    // fresh one. Its model context is lost, which is logged — the conversation record is not.
    if (!this.session.alive) {
      this.session.close();
      this.session = new AgentSession(this.id, this.channel);
      await log.logEvent(this.id, 'note', 'Agent session restarted after the previous one failed', { turn_index: turnIndex }).catch(() => undefined);
    }

    const triggers = detectTriggers(text);
    const hits = retriever.search(text);
    if (triggers.length > 0) this.escalationRequired = true;

    // The turn row above is the before-the-model record. Retrieval and trigger rows are written
    // while the model runs, so a slow database doesn't add to the caller's silence; a failure
    // goes to the fallback file with everything needed to replay it.
    const sideLogs = this.logRetrievalAndTriggers(turnId, turnIndex, text, hits, triggers);

    const stream = new StreamingReply(speaker, (meta) => this.judge(meta, null, hits, triggers, this.session.liveTools));
    const hooks: TurnHooks = input.sink ? stream.hooks : {};

    let sdkTurn: SdkTurn | 'timeout';
    try {
      sdkTurn = await withDeadline(this.session.ask(composeTurnMessage(text, hits, triggers, this.previousReplyUnheard), hooks), TURN_DEADLINE_MS);
    } catch (error) {
      return this.failTurn(turnId, turnIndex, startedAt, speaker, LINES.failure, 'agent_unavailable', error);
    }
    if (sdkTurn === 'timeout') {
      await this.session.interrupt();
      return this.failTurn(turnId, turnIndex, startedAt, speaker, LINES.timeout, 'turn_deadline', new Error(`no result within ${TURN_DEADLINE_MS} ms`));
    }

    const turnCost = sdkTurn.cumulativeCostUsd - this.lastCumulativeCost;
    this.lastCumulativeCost = sdkTurn.cumulativeCostUsd;
    // The SDK reports API time cumulatively across a streaming session.
    const turnApiMs = sdkTurn.durationApiMs - this.lastCumulativeApiMs;
    this.lastCumulativeApiMs = sdkTurn.durationApiMs;
    if (!sdkTurn.ok) {
      const stage = this.interruptedTurn === turnIndex ? 'caller_interrupted' : `sdk_${sdkTurn.errorSubtype}`;
      return this.failTurn(turnId, turnIndex, startedAt, speaker, LINES.failure, stage, new Error(sdkTurn.errors.join('; ') || 'agent turn failed'));
    }
    const parsed = TurnOutput.safeParse(sdkTurn.structuredOutput);
    if (!parsed.success) {
      return this.failTurn(turnId, turnIndex, startedAt, speaker, LINES.failure, 'invalid_structured_output', new Error(parsed.error.message));
    }

    const verdict = this.judge(parsed.data, parsed.data.spoken_text, hits, triggers, sdkTurn.tools);
    const finalText = this.finalSpokenText(parsed.data, verdict, sdkTurn.tools);
    stream.finish(finalText.text, finalText.appended);
    speaker.stopAcknowledging();
    for (const tool of sdkTurn.tools) for (const reference of referencesIn(tool)) this.knownReferences.add(reference);
    if (sdkTurn.tools.some((tool) => tool.name === 'create_escalation' && tool.result?.ok === true)) this.escalationCreated = true;

    const enforced = [...verdict.enforced, ...finalText.enforced, ...(input.sink ? stream.notes : [])];
    if (this.interruptedTurn === turnIndex || input.sink?.closed) enforced.push('caller_interrupted');
    this.previousReplyUnheard = enforced.includes('caller_interrupted') && !speaker.heardBeyondFiller();
    this.lastAnswerType = verdict.answerType;

    const reply: TurnReply = {
      conversation_id: this.id,
      turn_index: turnIndex,
      reply: input.sink ? speaker.text : finalText.text,
      answer_type: verdict.answerType,
      cited_chunk_ids: verdict.citations,
      retrieved_chunk_ids: hits.map((hit) => hit.chunk.id),
      triggers: triggers.map((hit) => hit.kind),
      enforced,
      tools: sdkTurn.tools.map(toolSummary),
      timings_ms: { total: Date.now() - startedAt, first_speech: speaker.firstSpeechMs, model_api: turnApiMs },
      cost_usd: round(turnCost),
    };

    await sideLogs;
    const note = enforced.length > 0 ? `${parsed.data.confidence_note} [code: ${enforced.join(', ')}]` : parsed.data.confidence_note;
    await this.recordOutcome(turnId, reply, parsed.data, note, sdkTurn.modelUsage, input);
    return reply;
  }

  private async logRetrievalAndTriggers(turnId: number, turnIndex: number, text: string, hits: RetrievalHit[], triggers: TriggerHit[]): Promise<void> {
    try {
      await Promise.all([
        log.logRetrieval(this.id, turnId, text, hits),
        triggers.length === 0
          ? Promise.resolve()
          : log.logEvent(this.id, 'escalation_triggered', `Triggers: ${triggers.map((t) => t.kind).join(', ')}`, {
              turn_index: turnIndex,
              triggers,
              category: escalationCategory(triggers),
            }),
      ]);
    } catch (error) {
      await writeFallback({
        stage: 'log_retrieval',
        conversation_id: this.id,
        turn_index: turnIndex,
        query: text,
        chunk_ids: hits.map((hit) => hit.chunk.id),
        triggers: triggers.map((hit) => hit.kind),
        error: describe(error),
      });
    }
  }

  // The rules that decide what may be said. Called twice with the same logic: before speech on
  // the voice path (spokenText null — only answer type and citations are known yet), and on the
  // complete output. One definition, so the two paths can never disagree.
  private judge(
    output: { answer_type: string; cited_chunk_ids: string[] },
    spokenText: string | null,
    hits: RetrievalHit[],
    triggers: TriggerHit[],
    tools: readonly ToolEvent[],
  ): Verdict {
    const enforced: string[] = [];
    const modelType = (TurnOutput.shape.answer_type.options as readonly string[]).includes(output.answer_type) ? (output.answer_type as AnswerType) : 'decline';

    // Grounded or not at all: a citation only counts if that chunk was retrieved this turn.
    const retrievedIds = new Set(hits.map((hit) => hit.chunk.id));
    const citations = output.cited_chunk_ids.filter((id) => retrievedIds.has(id));
    if (citations.length < output.cited_chunk_ids.length) enforced.push('dropped_unretrieved_citations');

    // Escalation triggers — from the caller's words or from a record — are not optional.
    const recordNeedsHuman = tools.some((tool) => tool.result?.requires_escalation === true);
    if (recordNeedsHuman) this.escalationRequired = true;
    const mustEscalate = this.escalationRequired && !this.escalationCreated;
    if (mustEscalate && modelType !== 'escalate') {
      enforced.push(recordNeedsHuman ? 'escalation_enforced_by_record' : 'escalation_enforced_by_trigger');
      return { answerType: 'escalate', citations, enforced, override: LINES.escalate, needsFullText: false };
    }

    // Thanks and goodbyes need no grounding, but only in a shape that can't carry a claim. The
    // check needs the words, so a social reply is never streamed before it is complete.
    if (modelType === 'social') {
      if (spokenText === null) return { answerType: modelType, citations, enforced, override: null, needsFullText: true };
      if (!isSafeSocialReply(spokenText)) {
        enforced.push('unsafe_social_reply_replaced_with_decline');
        return { answerType: 'decline', citations, enforced, override: LINES.decline, needsFullText: false };
      }
      return { answerType: modelType, citations, enforced, override: null, needsFullText: false };
    }

    // A record the caller asked about, or an action taken, grounds an answer as well as a chunk
    // does: a tool succeeded this turn, or the answer names a reference an earlier tool returned.
    const toolGrounded = tools.some(
      (tool) => (tool.name.startsWith('lookup_') && tool.result?.found === true) || (tool.name.startsWith('create_') && tool.result?.ok === true),
    );
    if (modelType === 'answer' && citations.length === 0 && !toolGrounded) {
      if (spokenText === null && this.knownReferences.size > 0) {
        return { answerType: modelType, citations, enforced, override: null, needsFullText: true };
      }
      const namesKnownReference = spokenText !== null && [...this.knownReferences].some((reference) => mentionsReference(spokenText, reference));
      if (!namesKnownReference) {
        enforced.push('ungrounded_answer_replaced_with_decline');
        return { answerType: 'decline', citations, enforced, override: LINES.decline, needsFullText: false };
      }
    }
    return { answerType: modelType, citations, enforced, override: null, needsFullText: false };
  }

  // Checks that need the complete text: the escalation reference must be heard exactly, emails
  // are never spoken, and on the voice path the reply closes with the line code decides on.
  // `appended` is what to add when the model's words were already streamed.
  private finalSpokenText(output: TurnOutput, verdict: Verdict, tools: readonly ToolEvent[]) {
    const enforced: string[] = [];
    let text = verdict.override ?? output.spoken_text;
    const extra: string[] = [];

    const escalation = tools.find((tool) => tool.name === 'create_escalation' && tool.result?.ok === true)?.result;
    const escalationId = typeof escalation?.escalation_id === 'string' ? escalation.escalation_id : null;
    if (escalationId && !mentionsReference(text, escalationId) && typeof escalation?.follow_up_summary === 'string') {
      extra.push(escalation.follow_up_summary);
      if (verdict.override) text = '';
      enforced.push('escalation_reference_restored');
    }
    let safe = speechFromModel(text);
    if (maskEmails(text) !== text) enforced.push('email_removed_from_speech');
    if (withoutEndCallPhrase(text) !== text) enforced.push('end_call_phrase_removed');

    if (this.channel === 'voice') {
      const closing = closingLine({
        askToType: output.ask_to_type,
        endCall: output.end_call,
        answerType: verdict.answerType,
        text: [safe, ...extra].join(' '),
        escalationCreatedThisTurn: escalationId !== null,
      });
      if (closing) {
        extra.push(closing.line);
        enforced.push(closing.note);
        // The goodbye is the whole reply: the model's own farewell would only repeat it. A
        // social reply is held until complete, so none of it has been spoken yet.
        if (closing.note === 'call_ended_by_agent') safe = '';
      }
    }
    const full = [safe, ...extra].filter(Boolean).join(' ');
    if (full.split(/\s+/).length > LONG_RESPONSE_WORDS) enforced.push('long_response_flagged');
    return { text: full, appended: extra.length > 0 ? extra.join(' ') : null, enforced };
  }

  private async recordOutcome(
    turnId: number,
    reply: TurnReply,
    modelOutput: TurnOutput,
    confidenceNote: string,
    modelUsage: SdkTurn['modelUsage'],
    input: TurnInput,
  ): Promise<void> {
    try {
      await log.finishTurn(turnId, reply.reply, reply.answer_type, confidenceNote);
      await log.logEvent(this.id, 'decision', `Turn ${reply.turn_index}: ${reply.answer_type}`, {
        turn_index: reply.turn_index,
        answer_type: reply.answer_type,
        model_answer_type: modelOutput.answer_type,
        model_end_call: modelOutput.end_call,
        model_ask_to_type: modelOutput.ask_to_type,
        cited_chunk_ids: reply.cited_chunk_ids,
        model_cited_chunk_ids: modelOutput.cited_chunk_ids,
        enforced: reply.enforced,
        tools: reply.tools,
        timings_ms: reply.timings_ms,
        cost_usd: reply.cost_usd,
        model_usage_cumulative: modelUsage,
        ...(input.rawTranscript && input.rawTranscript !== input.text ? { raw_transcript: input.rawTranscript, normalized_text: input.text } : {}),
      });
    } catch (error) {
      await writeFallback({ stage: 'finish_turn', conversation_id: this.id, turn_index: reply.turn_index, reply, error: describe(error) });
    }
  }

  private async failTurn(
    turnId: number,
    turnIndex: number,
    startedAt: number,
    speaker: Speaker,
    line: string,
    stage: string,
    error: unknown,
  ): Promise<TurnReply> {
    speaker.stopAcknowledging();
    this.previousReplyUnheard = stage === 'caller_interrupted' && !speaker.heardBeyondFiller();
    // A caller who interrupted or hung up hears nothing more; the log says so instead.
    if (stage !== 'caller_interrupted') speaker.say(line);
    const heard = stage === 'caller_interrupted' ? `${speaker.text} [caller interrupted]`.trim() : speaker.text || line;
    try {
      await log.finishTurn(turnId, heard, 'error', `failed at ${stage}`);
      await log.logEvent(this.id, 'error', `Turn ${turnIndex} failed at ${stage}`, { turn_index: turnIndex, stage, error: describe(error) });
    } catch (logError) {
      await writeFallback({ stage, conversation_id: this.id, turn_index: turnIndex, error: describe(error), log_error: describe(logError) });
    }
    return this.errorReply(turnIndex, startedAt, speaker, line, [stage]);
  }

  private errorReply(turnIndex: number, startedAt: number, speaker: Speaker, line: string, enforced: string[]): TurnReply {
    this.lastAnswerType = 'error';
    return {
      conversation_id: this.id,
      turn_index: turnIndex,
      reply: speaker.text || line,
      answer_type: 'error',
      cited_chunk_ids: [],
      retrieved_chunk_ids: [],
      triggers: [],
      enforced,
      tools: [],
      timings_ms: { total: Date.now() - startedAt, first_speech: speaker.firstSpeechMs, model_api: null },
      cost_usd: null,
    };
  }
}

// On a voice turn, if nothing has been said by now the caller hears an acknowledgement, so the
// time to first sound never depends on the database or the model.
const ACKNOWLEDGE_AFTER_MS = 1200;

// Everything the caller actually received in one turn, in order — this is what the turn log
// records. Words that could not be delivered (the caller hung up or spoke over it) are not in it.
class Speaker {
  private readonly parts: string[] = [];
  private ackTimer: NodeJS.Timeout | null = null;
  firstSpeechMs: number | null = null;

  constructor(private readonly sink: SpeechSink | undefined, private readonly startedAt: number) {
    if (!sink) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.firstSpeechMs === null) this.say(LINES.acknowledge);
    }, ACKNOWLEDGE_AFTER_MS);
  }

  stopAcknowledging(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  say(text: string): void {
    this.stopAcknowledging();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.sink) {
      if (this.sink.closed) return;
      this.sink.say(`${trimmed} `);
    }
    this.parts.push(trimmed);
    this.firstSpeechMs ??= Date.now() - this.startedAt;
  }

  get text(): string {
    return this.parts.join(' ');
  }

  // True once the caller has heard any of the actual reply, not just "One moment."
  heardBeyondFiller(): boolean {
    return this.parts.some((part) => part !== LINES.acknowledge && part !== LINES.checking);
  }
}

// Voice path: streams the model's spoken_text sentence by sentence once the pre-speech verdict
// allows it, speaks a fixed line instead when it doesn't, and holds everything back when the
// verdict can't be made until the text is complete.
class StreamingReply {
  private mode: 'waiting' | 'stream' | 'overridden' | 'buffer' = 'waiting';
  private pending = '';
  private checkingSaid = false;
  readonly notes: string[] = [];
  readonly hooks: TurnHooks;

  constructor(private readonly speaker: Speaker, judgeMeta: (meta: { answer_type: string; cited_chunk_ids: string[] }) => Verdict) {
    const parser = new StructuredSpeechParser(
      (meta) => {
        if (!meta) {
          this.mode = 'buffer';
          return;
        }
        const verdict = judgeMeta(meta);
        if (verdict.override) {
          this.mode = 'overridden';
          this.speaker.say(verdict.override);
        } else {
          this.mode = verdict.needsFullText ? 'buffer' : 'stream';
        }
      },
      (text) => {
        if (this.mode !== 'stream') return;
        this.pending += text;
        this.flushSentences(false);
      },
    );
    this.hooks = {
      onToolStart: () => {
        if (this.checkingSaid || this.speaker.firstSpeechMs !== null) return;
        this.checkingSaid = true;
        this.speaker.say(LINES.checking);
      },
      onStructuredJson: (chunk) => parser.feed(chunk),
    };
  }

  // Called with the final, checked text. Whatever wasn't streamed is said now.
  finish(finalText: string, appended: string | null): void {
    if (this.mode === 'stream') {
      this.flushSentences(true);
      if (appended) this.speaker.say(appended);
      return;
    }
    if (this.mode === 'overridden') {
      if (appended) this.speaker.say(appended);
      return;
    }
    if (this.mode === 'waiting') this.notes.push('no_streamed_output');
    this.speaker.say(finalText);
  }

  private flushSentences(all: boolean): void {
    const pattern = /[^.!?]*[.!?]+(\s+|$)/g;
    let consumed = 0;
    for (const match of this.pending.matchAll(pattern)) {
      if (match.index !== consumed) break;
      if (!all && match[1] === '' ) break;
      this.speaker.say(speechFromModel(match[0]));
      consumed += match[0].length;
    }
    this.pending = this.pending.slice(consumed);
    if (all && this.pending.trim()) {
      this.speaker.say(speechFromModel(this.pending));
      this.pending = '';
    }
  }
}

function maskEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, 'the email on file');
}

// Everything the model writes passes through this before anyone hears or reads it: no emails,
// references in their one written form (the model sometimes spells them out, "T K T dash zero…";
// the voice layer spells them its own way), and never the phrase that makes Vapi hang up.
function speechFromModel(text: string): string {
  return withoutEndCallPhrase(normalizeSpokenReferences(maskEmails(text)).text);
}

const REFERENCE_FIELDS = ['ticket_id', 'escalation_id', 'transaction_id', 'payout_id'];

function referencesIn(tool: ToolEvent): string[] {
  const result = tool.result;
  if (!result || result.ok !== true) return [];
  return REFERENCE_FIELDS.map((field) => result[field]).filter((value): value is string => typeof value === 'string');
}

const SPOKEN_DIGITS: Record<string, string> = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

// Voice replies spell references out ("T K T dash zero zero zero one two"); compare on letters and digits only.
function mentionsReference(text: string, reference: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[a-z]+/g, (word) => SPOKEN_DIGITS[word] ?? (word === 'dash' || word === 'hyphen' ? '' : word))
      .replace(/[^a-z0-9]/g, '');
  return normalize(text).includes(normalize(reference));
}

function toolSummary(tool: ToolEvent): { name: string; outcome: string } {
  const result = tool.result;
  const outcome = !result
    ? 'no_result'
    : result.refused
      ? `refused:${String(result.reason)}`
      : result.error
        ? `error:${String(result.error)}`
        : result.found === false
          ? 'not_found'
          : 'ok';
  return { name: tool.name, outcome };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), ms)));
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function writeFallback(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(AGENT_FALLBACK_LOG), { recursive: true });
    await appendFile(AGENT_FALLBACK_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`agent log lost (${describe(error)}): ${JSON.stringify(entry)}\n`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
