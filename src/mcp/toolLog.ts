import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, must, mustRow } from '../shared/db.js';
import type { ToolContext } from './context.js';
import { redactForLog } from './redact.js';
import { failure, type ToolOutcome } from './tool.js';
import { ensureConversation } from './verification.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FALLBACK_LOG_PATH = resolve(PROJECT_ROOT, 'logs/tool-calls-fallback.jsonl');

interface ToolIdentity {
  name: string;
  purpose: string;
}

// Every tool call goes through here: a 'started' row is written BEFORE the tool touches any
// data, then finalised with the outcome. If the start row cannot be written the tool does not
// run at all — an access that can't be logged doesn't happen.
export async function runLogged(
  ctx: ToolContext,
  tool: ToolIdentity,
  rawInput: unknown,
  run: () => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const inputSummary = redactForLog(rawInput ?? {});

  let logId: string;
  try {
    logId = await writeStartRow(ctx, tool, inputSummary);
  } catch (error) {
    const outcome = failure('log_unavailable', `could not write tool-call start row: ${describe(error)}`);
    await writeFallback({ phase: 'start', ctx, tool, inputSummary, outcome, durationMs: Date.now() - startedAt });
    return outcome;
  }

  let outcome: ToolOutcome;
  try {
    outcome = await run();
  } catch (error) {
    outcome = failure('tool_error', describe(error));
  }

  const durationMs = Date.now() - startedAt;
  try {
    await writeFinishRow(logId, outcome, durationMs);
  } catch (error) {
    await writeFallback({ phase: 'finish', ctx, tool, logId, inputSummary, outcome, durationMs, finishError: describe(error) });
  }
  return outcome;
}

async function writeStartRow(ctx: ToolContext, tool: ToolIdentity, inputSummary: unknown): Promise<string> {
  await ensureConversation(ctx);
  const row = mustRow(
    await db()
      .from('tool_calls')
      .insert({
        conversation_id: ctx.conversationId,
        tool_name: tool.name,
        purpose: tool.purpose,
        input_summary: inputSummary,
        // Same clock as finished_at, so a row's two timestamps can never contradict each other.
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single(),
  );
  return row.id as string;
}

async function writeFinishRow(logId: string, outcome: ToolOutcome, durationMs: number): Promise<void> {
  must(
    await db()
      .from('tool_calls')
      .update({
        status: outcome.status,
        result_summary: redactForLog(outcome.logSummary ?? outcome.result),
        error_message: outcome.errorMessage ?? null,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
      })
      .eq('id', logId),
  );
}

interface FallbackEntry {
  phase: 'start' | 'finish';
  ctx: ToolContext;
  tool: ToolIdentity;
  logId?: string;
  inputSummary: unknown;
  outcome: ToolOutcome;
  durationMs: number;
  finishError?: string;
}

// Last resort when Supabase itself is the thing that failed. The same redaction applies.
async function writeFallback(entry: FallbackEntry): Promise<void> {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    phase: entry.phase,
    conversation_id: entry.ctx.conversationId,
    tool_name: entry.tool.name,
    tool_call_id: entry.logId ?? null,
    input_summary: entry.inputSummary,
    status: entry.outcome.status,
    result_summary: redactForLog(entry.outcome.logSummary ?? entry.outcome.result),
    error_message: entry.outcome.errorMessage ?? null,
    finish_error: entry.finishError ?? null,
    duration_ms: entry.durationMs,
  });
  try {
    await mkdir(dirname(FALLBACK_LOG_PATH), { recursive: true });
    await appendFile(FALLBACK_LOG_PATH, `${line}\n`, 'utf8');
  } catch (error) {
    // stdout carries the MCP protocol, so stderr is the only remaining place to say this.
    process.stderr.write(`tool-call log lost (${describe(error)}): ${line}\n`);
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` <- ${error.cause.message}` : '';
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}
