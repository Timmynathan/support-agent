import { z } from 'zod';
import type { ToolContext } from './context.js';

export type ToolStatus = 'ok' | 'not_found' | 'refused' | 'failed';

export interface ToolOutcome {
  status: ToolStatus;
  // What the model receives.
  result: Record<string, unknown>;
  // What the log row records, when it should differ from the result (e.g. why a match failed,
  // which must not be told to the caller). Redacted before it is written.
  logSummary?: Record<string, unknown>;
  errorMessage?: string;
}

export interface Tool {
  name: string;
  purpose: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
  run(ctx: ToolContext, rawInput: unknown): Promise<ToolOutcome>;
}

interface ToolDefinition<S extends z.ZodObject> {
  name: string;
  purpose: string;
  description: string;
  input: S;
  handler(ctx: ToolContext, input: z.infer<S>): Promise<ToolOutcome>;
}

// Validation happens here, inside the logged call, rather than in the MCP SDK — an input the
// SDK rejected would never reach the tool-call log.
export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): Tool {
  const strictInput = def.input.strict();
  return {
    name: def.name,
    purpose: def.purpose,
    description: def.description,
    // draft-7 for the widest MCP client compatibility (Claude Code rejects 2020-12).
    inputJsonSchema: z.toJSONSchema(strictInput, { target: 'draft-7' }) as Record<string, unknown>,
    async run(ctx, rawInput) {
      const parsed = strictInput.safeParse(rawInput ?? {});
      if (!parsed.success) {
        return refused('invalid_input', 'The tool input was invalid. Do not retry with guessed values; ask the caller for the missing or unclear detail.', {
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        });
      }
      return def.handler(ctx, parsed.data as z.infer<S>);
    },
  };
}

export function refused(reason: string, messageForAgent: string, logSummary?: Record<string, unknown>): ToolOutcome {
  const result = { ok: false, refused: true, reason, message_for_agent: messageForAgent };
  return { status: 'refused', result, logSummary: logSummary ? { ...result, ...logSummary } : undefined };
}

export function failure(code: string, errorMessage: string): ToolOutcome {
  return {
    status: 'failed',
    errorMessage,
    result: {
      ok: false,
      error: code,
      message_for_agent:
        "RelayPay's records can't be reached right now. Tell the caller you can't check that at the moment, " +
        'without technical detail, and suggest trying again shortly or contacting support through the RelayPay dashboard.',
    },
  };
}
