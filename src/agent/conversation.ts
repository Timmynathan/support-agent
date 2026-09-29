import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Channel } from '../shared/domain.js';
import { loadKnowledgeBase } from '../knowledge/knowledgeBase.js';
import { buildRetriever, type RetrievalHit } from '../knowledge/retrieve.js';
import * as log from './conversationLog.js';
import { composeTurnMessage, TurnOutput, type AnswerType } from './prompt.js';
import { AgentSession, type SdkTurn, type ToolEvent } from './session.js';
import { detectTriggers, escalationCategory, type TriggerHit } from './triggers.js';

// A voice caller hears silence while this runs. The first turn of a conversation that wasn't
// pre-started also pays the ~10 s Claude process start, hence the headroom; Phase 3 starts the
// session when the call connects so a caller never pays that.
export const TURN_DEADLINE_MS = 20_000;

// Fixed lines used when code overrides the model. Written once, here, so what a caller hears
// in a failure or enforced handoff never depends on a model call succeeding.
export const LINES = {
  escalate:
    "This needs one of our support specialists, so I'd like to arrange for someone to contact you. " +
    'Could you tell me your name, the best email to reach you, and a good time for a callback?',
  decline:
    "I'm not able to confirm that from RelayPay's approved information. I can connect you with a specialist who can help, if you'd like.",
  failure:
    "I'm sorry, I'm having trouble checking that right now. Please try again in a moment, or reach RelayPay support through your dashboard.",
  timeout:
    "I'm sorry, this is taking longer than it should. Please try again in a moment, or reach RelayPay support through your dashboard.",
} as const;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_RESPONSE_WORDS = 80;
const AGENT_FALLBACK_LOG = resolve(import.meta.dirname, '../../logs/agent-fallback.jsonl');

const retriever = buildRetriever(loadKnowledgeBase());

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
  timings_ms: { total: number; model_api: number | null };
  cost_usd: number | null;
}

export class Conversation {
  private session: AgentSession;
  private turnIndex = 0;
  private lastCumulativeCost = 0;
  private escalationRequired = false;
  private escalationCreated = false;
  private lastAnswerType: AnswerType | 'error' | null = null;
  // References returned by successful tools earlier in this conversation (TKT-…, ESC-…, TXN-…).
  private readonly knownReferences = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  lastActivity = Date.now();

  private constructor(readonly id: string, readonly channel: Channel) {
    this.session = new AgentSession(id, channel);
  }

  static async start(id: string, channel: Channel, callerIdentifier: string | null): Promise<Conversation> {
    await log.startConversation(id, channel, callerIdentifier);
    return new Conversation(id, channel);
  }

  // Turns in one conversation run strictly one after another, so SDK results pair with the
  // message that caused them.
  handle(text: string): Promise<TurnReply> {
    const run = this.queue.then(() => this.runTurn(text));
    this.queue = run.catch(() => undefined);
    return run;
  }

  // Returns false when the final status could not be saved (it goes to the fallback file instead).
  async end(reason: 'caller_ended' | 'idle' | 'server_shutdown'): Promise<boolean> {
    this.session.close();
    const status: log.FinalStatus = this.escalationCreated
      ? 'escalated'
      : reason === 'idle' && this.turnIndex === 0
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

  private async runTurn(text: string): Promise<TurnReply> {
    const startedAt = Date.now();
    this.lastActivity = startedAt;
    const turnIndex = this.turnIndex++;

    let turnId: number;
    try {
      turnId = await log.startTurn(this.id, turnIndex, text);
    } catch (error) {
      // Fail closed, like the MCP tools: an answer that can't be logged isn't given.
      await writeFallback({ stage: 'start_turn', conversation_id: this.id, turn_index: turnIndex, error: describe(error) });
      return this.errorReply(turnIndex, startedAt, LINES.failure, ['log_unavailable']);
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

    try {
      await log.logRetrieval(this.id, turnId, text, hits);
      if (triggers.length > 0) {
        await log.logEvent(this.id, 'escalation_triggered', `Triggers: ${triggers.map((t) => t.kind).join(', ')}`, {
          turn_index: turnIndex,
          triggers,
          category: escalationCategory(triggers),
        });
      }
    } catch (error) {
      await writeFallback({ stage: 'log_retrieval', conversation_id: this.id, turn_index: turnIndex, error: describe(error) });
      return this.failTurn(turnId, turnIndex, startedAt, LINES.failure, 'log_unavailable', error);
    }

    let sdkTurn: SdkTurn | 'timeout';
    try {
      sdkTurn = await withDeadline(this.session.ask(composeTurnMessage(text, hits, triggers)), TURN_DEADLINE_MS);
    } catch (error) {
      return this.failTurn(turnId, turnIndex, startedAt, LINES.failure, 'agent_unavailable', error);
    }
    if (sdkTurn === 'timeout') {
      await this.session.interrupt();
      return this.failTurn(turnId, turnIndex, startedAt, LINES.timeout, 'turn_deadline', new Error(`no result within ${TURN_DEADLINE_MS} ms`));
    }

    const turnCost = sdkTurn.cumulativeCostUsd - this.lastCumulativeCost;
    this.lastCumulativeCost = sdkTurn.cumulativeCostUsd;
    if (!sdkTurn.ok) {
      return this.failTurn(turnId, turnIndex, startedAt, LINES.failure, `sdk_${sdkTurn.errorSubtype}`, new Error(sdkTurn.errors.join('; ') || 'agent turn failed'));
    }
    const parsed = TurnOutput.safeParse(sdkTurn.structuredOutput);
    if (!parsed.success) {
      return this.failTurn(turnId, turnIndex, startedAt, LINES.failure, 'invalid_structured_output', new Error(parsed.error.message));
    }

    const checked = this.enforce(parsed.data, hits, triggers, sdkTurn.tools);
    this.lastAnswerType = checked.answerType;
    if (sdkTurn.tools.some((tool) => tool.name === 'create_escalation' && tool.result?.ok === true)) this.escalationCreated = true;

    const reply: TurnReply = {
      conversation_id: this.id,
      turn_index: turnIndex,
      reply: checked.spokenText,
      answer_type: checked.answerType,
      cited_chunk_ids: checked.citations,
      retrieved_chunk_ids: hits.map((hit) => hit.chunk.id),
      triggers: triggers.map((hit) => hit.kind),
      enforced: checked.enforced,
      tools: sdkTurn.tools.map(toolSummary),
      timings_ms: { total: Date.now() - startedAt, model_api: sdkTurn.durationApiMs },
      cost_usd: round(turnCost),
    };

    await this.recordOutcome(turnId, reply, parsed.data, checked.confidenceNote, sdkTurn.modelUsage);
    return reply;
  }

  // Code-side checks on what the model produced. Each override is recorded in `enforced`.
  private enforce(output: TurnOutput, hits: RetrievalHit[], triggers: TriggerHit[], tools: ToolEvent[]) {
    const enforced: string[] = [];
    let answerType: AnswerType = output.answer_type;
    let spokenText = output.spoken_text;

    // Grounded or not at all: a citation only counts if that chunk was retrieved this turn.
    const retrievedIds = new Set(hits.map((hit) => hit.chunk.id));
    const citations = output.cited_chunk_ids.filter((id) => retrievedIds.has(id));
    if (citations.length < output.cited_chunk_ids.length) enforced.push('dropped_unretrieved_citations');
    // A record the caller asked about, or an action taken, grounds an answer as well as a chunk does:
    // either a tool succeeded this turn, or the answer names a reference an earlier tool returned.
    const toolGrounded = tools.some(
      (tool) => (tool.name.startsWith('lookup_') && tool.result?.found === true) || (tool.name.startsWith('create_') && tool.result?.ok === true),
    );
    const namesKnownReference = [...this.knownReferences].some((reference) => mentionsReference(output.spoken_text, reference));
    for (const tool of tools) for (const reference of referencesIn(tool)) this.knownReferences.add(reference);
    if (answerType === 'answer' && citations.length === 0 && !toolGrounded && !namesKnownReference) {
      answerType = 'decline';
      spokenText = LINES.decline;
      enforced.push('ungrounded_answer_replaced_with_decline');
    }

    // Escalation triggers — from the caller's words or from a record — are not optional.
    const recordNeedsHuman = tools.some((tool) => tool.result?.requires_escalation === true);
    if (recordNeedsHuman) this.escalationRequired = true;
    const mustEscalate = (triggers.length > 0 || recordNeedsHuman || this.escalationRequired) && !this.escalationCreated;
    if (mustEscalate && answerType !== 'escalate') {
      answerType = 'escalate';
      spokenText = LINES.escalate;
      enforced.push(recordNeedsHuman ? 'escalation_enforced_by_record' : 'escalation_enforced_by_trigger');
    }

    // The caller must hear the escalation reference exactly as recorded; the tool's own summary
    // is the fallback when the model paraphrased it away.
    const escalation = tools.find((tool) => tool.name === 'create_escalation' && tool.result?.ok === true)?.result;
    const escalationId = typeof escalation?.escalation_id === 'string' ? escalation.escalation_id : null;
    if (escalationId && !mentionsReference(spokenText, escalationId) && typeof escalation?.follow_up_summary === 'string') {
      spokenText = escalation.follow_up_summary;
      enforced.push('escalation_reference_restored');
    }

    if (EMAIL_PATTERN.test(spokenText)) {
      spokenText = spokenText.replace(EMAIL_PATTERN, 'the email on file');
      enforced.push('email_removed_from_speech');
    }
    EMAIL_PATTERN.lastIndex = 0;
    if (spokenText.split(/\s+/).length > LONG_RESPONSE_WORDS) enforced.push('long_response_flagged');

    const confidenceNote = enforced.length > 0 ? `${output.confidence_note} [code: ${enforced.join(', ')}]` : output.confidence_note;
    return { answerType, spokenText, citations, enforced, confidenceNote };
  }

  private async recordOutcome(
    turnId: number,
    reply: TurnReply,
    modelOutput: TurnOutput,
    confidenceNote: string,
    modelUsage: SdkTurn['modelUsage'],
  ): Promise<void> {
    try {
      await log.finishTurn(turnId, reply.reply, reply.answer_type, confidenceNote);
      await log.logEvent(this.id, 'decision', `Turn ${reply.turn_index}: ${reply.answer_type}`, {
        turn_index: reply.turn_index,
        answer_type: reply.answer_type,
        model_answer_type: modelOutput.answer_type,
        cited_chunk_ids: reply.cited_chunk_ids,
        model_cited_chunk_ids: modelOutput.cited_chunk_ids,
        enforced: reply.enforced,
        tools: reply.tools,
        timings_ms: reply.timings_ms,
        cost_usd: reply.cost_usd,
        model_usage_cumulative: modelUsage,
      });
    } catch (error) {
      await writeFallback({ stage: 'finish_turn', conversation_id: this.id, turn_index: reply.turn_index, reply, error: describe(error) });
    }
  }

  private async failTurn(turnId: number, turnIndex: number, startedAt: number, line: string, stage: string, error: unknown): Promise<TurnReply> {
    this.lastAnswerType = 'error';
    try {
      await log.finishTurn(turnId, line, 'error', `failed at ${stage}`);
      await log.logEvent(this.id, 'error', `Turn ${turnIndex} failed at ${stage}`, { turn_index: turnIndex, stage, error: describe(error) });
    } catch (logError) {
      await writeFallback({ stage, conversation_id: this.id, turn_index: turnIndex, error: describe(error), log_error: describe(logError) });
    }
    return this.errorReply(turnIndex, startedAt, line, [stage]);
  }

  private errorReply(turnIndex: number, startedAt: number, line: string, enforced: string[]): TurnReply {
    this.lastAnswerType = 'error';
    return {
      conversation_id: this.id,
      turn_index: turnIndex,
      reply: line,
      answer_type: 'error',
      cited_chunk_ids: [],
      retrieved_chunk_ids: [],
      triggers: [],
      enforced,
      tools: [],
      timings_ms: { total: Date.now() - startedAt, model_api: null },
      cost_usd: null,
    };
  }
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
