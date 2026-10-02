import { resolve } from 'node:path';
import { query, type Query, type SDKMessage, type SDKPartialAssistantMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Channel } from '../shared/domain.js';
import { agentToolName, MCP_SERVER_NAME } from '../shared/domain.js';
import { RUNNING_COMPILED } from '../shared/paths.js';
import { SYSTEM_PROMPT, TURN_OUTPUT_SCHEMA } from './prompt.js';

export const AGENT_MODEL = process.env.AGENT_MODEL ?? 'claude-sonnet-5';
const RELAYPAY_TOOLS = [
  'lookup_customer',
  'lookup_transaction',
  'lookup_payout',
  'create_support_ticket',
  'create_escalation',
];
// log_conversation_event stays on the MCP server (it is part of the tool spec) but is not offered
// to the agent: this server already records every decision and trigger directly, and each extra
// tool call costs a caller several seconds of silence.
// Room for a lookup, a follow-up action and the structured answer; more means the agent is
// chaining lookups, which is exactly what a caller waiting on the line can't afford.
const MAX_TURNS = 6;
const MCP_TOOL_TIMEOUT_MS = 8000;
// Compiled (production): plain node on the built server. Development: the TypeScript source via tsx.
const MCP_SERVER_ARGS = RUNNING_COMPILED
  ? [resolve(import.meta.dirname, '../mcp/server.js')]
  : ['--import', 'tsx', resolve(import.meta.dirname, '../mcp/server.ts')];

export interface ToolEvent {
  name: string;
  input: unknown;
  result: Record<string, unknown> | null;
  isError: boolean;
  // The tool_result's own words when they aren't a JSON result — usually the SDK refusing the
  // call before it reached the MCP server. Kept so the decision log says why, not just "no result".
  rawError: string | null;
}

// Live signals from a turn in progress, used by the voice path to speak before the turn ends.
export interface TurnHooks {
  onToolStart?(name: string): void;
  onStructuredJson?(chunk: string): void;
}

export interface SdkTurn {
  ok: boolean;
  structuredOutput: unknown;
  errorSubtype: string | null;
  errors: string[];
  tools: ToolEvent[];
  cumulativeCostUsd: number;
  // Cumulative per-model token and cost totals for the session, as the SDK reports them.
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
  durationApiMs: number;
}

// One Claude Code process and one MCP server per conversation, fed by a stream of caller
// messages. Starting them costs ~10 s, so it happens once at conversation start, never per turn.
export class AgentSession {
  private readonly inbox = new MessageQueue();
  private readonly waiters: Array<{ resolve: (turn: SdkTurn) => void; reject: (error: Error) => void; hooks: TurnHooks }> = [];
  private readonly blockKinds = new Map<number, 'structured' | 'tool' | 'other'>();
  private readonly pendingTools = new Map<string, ToolEvent>();
  private turnTools: ToolEvent[] = [];
  private readonly query: Query;
  private failure: Error | null = null;

  constructor(readonly conversationId: string, channel: Channel) {
    this.query = query({
      prompt: this.inbox,
      options: {
        model: AGENT_MODEL,
        effort: 'low',
        systemPrompt: SYSTEM_PROMPT,
        outputFormat: { type: 'json_schema', schema: TURN_OUTPUT_SCHEMA },
        // No built-in Claude Code tools (Bash, Read, …): the six RelayPay tools are the whole surface.
        tools: [],
        allowedTools: RELAYPAY_TOOLS.map(agentToolName),
        // Hidden, not just refused: a tool the model can see but not use gets tried anyway.
        // customer_overview serves the caller's own screen and refuses the agent anyway.
        disallowedTools: [agentToolName('log_conversation_event'), agentToolName('customer_overview')],
        permissionMode: 'dontAsk',
        settingSources: [],
        // Only the RelayPay server. Without this, a Claude process running under a developer's
        // login also loads their personal claude.ai connectors (seen: ~110 tools on this machine).
        strictMcpConfig: true,
        persistSession: false,
        maxTurns: MAX_TURNS,
        includePartialMessages: true,
        env: agentProcessEnv(),
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'stdio',
            command: process.execPath,
            args: MCP_SERVER_ARGS,
            env: mcpServerEnv(conversationId, channel),
            timeout: MCP_TOOL_TIMEOUT_MS,
          },
        },
      },
    });
    void this.consume();
  }

  ask(text: string, hooks: TurnHooks = {}): Promise<SdkTurn> {
    if (this.failure) return Promise.reject(this.failure);
    const turn = new Promise<SdkTurn>((resolve, reject) => this.waiters.push({ resolve, reject, hooks }));
    this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    return turn;
  }

  async interrupt(): Promise<void> {
    await this.query.interrupt().catch(() => undefined);
  }

  close(): void {
    this.inbox.close();
    this.query.close();
  }

  // Tool calls of the turn in progress, with results as they arrive. The structured answer is
  // generated after every tool has returned, so by the time it streams these are complete.
  get liveTools(): readonly ToolEvent[] {
    return this.turnTools;
  }

  get alive(): boolean {
    return this.failure === null;
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) this.handle(message);
      this.fail(new Error('agent session ended'));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handle(message: SDKMessage): void {
    if (message.type === 'stream_event') {
      this.handleStreamEvent(message.event);
      return;
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        // StructuredOutput is the SDK's internal carrier for outputFormat, not a RelayPay tool.
        if (block.type !== 'tool_use' || block.name === 'StructuredOutput') continue;
        const event: ToolEvent = { name: block.name.replace(agentToolName(''), ''), input: block.input, result: null, isError: false, rawError: null };
        this.pendingTools.set(block.id, event);
        this.turnTools.push(event);
      }
      return;
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block !== 'object' || block.type !== 'tool_result') continue;
        const event = this.pendingTools.get(block.tool_use_id);
        if (!event) continue;
        event.isError = block.is_error === true;
        event.result = parseToolResult(block.content);
        if (!event.result) event.rawError = toolResultText(block.content).slice(0, RAW_ERROR_MAX_CHARS) || null;
        this.pendingTools.delete(block.tool_use_id);
      }
      return;
    }
    if (message.type !== 'result') return;

    const tools = this.turnTools;
    this.turnTools = [];
    const waiter = this.waiters.shift();
    if (!waiter) return;
    waiter.resolve({
      ok: message.subtype === 'success' && !message.is_error,
      structuredOutput: message.subtype === 'success' ? message.structured_output : undefined,
      errorSubtype: message.subtype === 'success' ? (message.is_error ? 'api_error' : null) : message.subtype,
      errors: message.subtype === 'success' ? [] : message.errors,
      tools,
      cumulativeCostUsd: message.total_cost_usd,
      modelUsage: message.modelUsage,
      durationApiMs: message.duration_api_ms,
    });
  }

  private handleStreamEvent(event: SDKPartialAssistantMessage['event']): void {
    const hooks = this.waiters[0]?.hooks;
    if (event.type === 'message_start') this.blockKinds.clear();
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block.type !== 'tool_use') {
        this.blockKinds.set(event.index, 'other');
        return;
      }
      const structured = block.name === 'StructuredOutput';
      this.blockKinds.set(event.index, structured ? 'structured' : 'tool');
      if (!structured) callHook(() => hooks?.onToolStart?.(block.name.replace(agentToolName(''), '')));
      return;
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta' && this.blockKinds.get(event.index) === 'structured') {
      const chunk = event.delta.partial_json;
      callHook(() => hooks?.onStructuredJson?.(chunk));
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

// A failing hook (e.g. writing to a caller who hung up) must never kill the session's read loop.
function callHook(invoke: () => void): void {
  try {
    invoke();
  } catch (error) {
    process.stderr.write(`turn hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const RAW_ERROR_MAX_CHARS = 400;

function toolResultText(content: unknown): string {
  return Array.isArray(content)
    ? content.map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : '')).join('')
    : typeof content === 'string'
      ? content
      : '';
}

function parseToolResult(content: unknown): Record<string, unknown> | null {
  const text = toolResultText(content);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// The Claude Code process needs the Anthropic key, but has no reason to hold the Supabase
// service-role key — only the MCP server does.
function agentProcessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'relaypay-support/1.0' };
  for (const key of Object.keys(env)) if (key.startsWith('SUPABASE_')) delete env[key];
  return env;
}

function mcpServerEnv(conversationId: string, channel: Channel): Record<string, string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  return { ...getDefaultEnvironment(), SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key, MCP_CONVERSATION_ID: conversationId, MCP_CHANNEL: channel };
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.waiting) {
      const deliver = this.waiting;
      this.waiting = null;
      deliver({ value: message, done: false });
      return;
    }
    this.items.push(message);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.items.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}
