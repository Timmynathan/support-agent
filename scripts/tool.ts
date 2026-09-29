// Call one MCP tool by hand, through a real MCP client over stdio — the same path the agent will
// use — then print the result and the tool-call log row it produced.
//
//   npm run tool -- --list
//   npm run tool -- lookup_customer company_name=LagosLedger contact_name=Amara --conversation demo-1
//   npm run tool -- log_conversation_event '{"event_type":"note","summary":"hi","metadata":{"a":1}}'
//   npm run tool -- lookup_transaction transaction_id=TXN-9001 --break-db
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { db, must } from '../src/shared/db.js';
import { FALLBACK_LOG_PATH } from '../src/mcp/toolLog.js';

const ROOT = resolve(import.meta.dirname, '..');
const UNREACHABLE_SUPABASE_URL = 'https://unreachable.invalid';

interface CliArgs {
  list: boolean;
  toolName: string | undefined;
  input: Record<string, unknown>;
  conversationId: string;
  channel: string;
  breakDb: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    list: false,
    toolName: undefined,
    input: {},
    conversationId: `cli-${Date.now()}`,
    channel: 'cli',
    breakDb: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--list') args.list = true;
    else if (arg === '--break-db') args.breakDb = true;
    else if (arg === '--conversation') args.conversationId = requireValue(argv[++i], arg);
    else if (arg === '--channel') args.channel = requireValue(argv[++i], arg);
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else if (!args.toolName) args.toolName = arg;
    else if (arg.trimStart().startsWith('{')) Object.assign(args.input, JSON.parse(arg));
    else {
      const eq = arg.indexOf('=');
      if (eq < 1) throw new Error(`expected key=value or a JSON object, got "${arg}"`);
      args.input[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }
  return args;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} needs a value`);
  return value;
}

function serverEnv(args: CliArgs): Record<string, string> {
  const url = args.breakDb ? UNREACHABLE_SUPABASE_URL : process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  return {
    ...getDefaultEnvironment(),
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: key,
    MCP_CONVERSATION_ID: args.conversationId,
    MCP_CHANNEL: args.channel,
  };
}

function print(label: string, value: unknown): void {
  process.stdout.write(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}\n${JSON.stringify(value, null, 2)}\n`);
}

async function latestLogRow(conversationId: string): Promise<unknown> {
  return must(
    await db()
      .from('tool_calls')
      .select('id, tool_name, purpose, input_summary, result_summary, status, error_message, started_at, finished_at, duration_ms')
      .eq('conversation_id', conversationId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
}

async function latestFallbackLine(): Promise<unknown> {
  const text = await readFile(FALLBACK_LOG_PATH, 'utf8').catch(() => '');
  const last = text.trimEnd().split('\n').pop();
  return last ? JSON.parse(last) : `(no entries in ${FALLBACK_LOG_PATH})`;
}

// When Supabase is down the tool's log went to the fallback file, and this CLI can't read
// tool_calls either — show the fallback entry instead of crashing on the read.
async function printLogEvidence(args: CliArgs): Promise<void> {
  if (!args.breakDb) {
    try {
      print('tool_calls row', await latestLogRow(args.conversationId));
      return;
    } catch (error) {
      print('tool_calls row unreadable', error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
  }
  print('fallback log line', await latestFallbackLine());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.list && !args.toolName) throw new Error('usage: npm run tool -- <tool_name> [key=value ...] [--conversation ID] [--break-db] | --list');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/server.ts'],
    cwd: ROOT,
    env: serverEnv(args),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'relaypay-cli', version: '1.0.0' });

  const connectStarted = performance.now();
  await client.connect(transport);
  const connectMs = Math.round(performance.now() - connectStarted);

  try {
    if (args.list) {
      const { tools } = await client.listTools();
      for (const tool of tools) print(tool.name, { description: tool.description, inputSchema: tool.inputSchema });
      return;
    }

    const callStarted = performance.now();
    const result = await client.callTool({ name: args.toolName!, arguments: args.input });
    const callMs = Math.round(performance.now() - callStarted);

    print('conversation', { conversation_id: args.conversationId, break_db: args.breakDb });
    print('input sent', args.input);
    print(`result${result.isError ? ' (isError)' : ''}`, result.structuredContent ?? result.content);
    await printLogEvidence(args);
    process.stdout.write(`\ntiming: server spawn+connect ${connectMs} ms, tool round trip ${callMs} ms\n`);
  } finally {
    await client.close();
  }
}

await main();
