import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { contextFromEnv } from './context.js';
import { failure, type Tool } from './tool.js';
import { runLogged } from './toolLog.js';
import { createEscalation } from './tools/createEscalation.js';
import { createSupportTicket } from './tools/createSupportTicket.js';
import { logConversationEvent } from './tools/logConversationEvent.js';
import { lookupCustomer } from './tools/lookupCustomer.js';
import { lookupPayout } from './tools/lookupPayout.js';
import { lookupTransaction } from './tools/lookupTransaction.js';

const TOOLS: readonly Tool[] = [
  lookupCustomer,
  lookupTransaction,
  lookupPayout,
  createSupportTicket,
  createEscalation,
  logConversationEvent,
];

const ctx = contextFromEnv();
const toolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

// The low-level Server is used instead of McpServer so input validation runs inside the logged
// call (see defineTool); McpServer would reject bad input before any log row is written.
const server = new Server({ name: 'relaypay-support', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputJsonSchema as never })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: rawInput } = request.params;
  const tool = toolsByName.get(name);
  const outcome = tool
    ? await runLogged(ctx, tool, rawInput, () => tool.run(ctx, rawInput))
    : await runLogged(ctx, { name, purpose: 'unknown tool requested' }, rawInput, async () =>
        failure('unknown_tool', `no tool named ${name}`),
      );
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
    structuredContent: outcome.result,
    isError: outcome.status === 'failed',
  };
});

await server.connect(new StdioServerTransport());
