import type { Tool } from '../tool.js';
import { createEscalation } from './createEscalation.js';
import { customerOverview } from './customerOverview.js';
import { createSupportTicket } from './createSupportTicket.js';
import { logConversationEvent } from './logConversationEvent.js';
import { lookupCustomer } from './lookupCustomer.js';
import { lookupPayout } from './lookupPayout.js';
import { lookupTransaction } from './lookupTransaction.js';

// Every RelayPay MCP tool, in one place: the MCP server serves these, and the fallback replay
// takes each tool's purpose from here rather than inventing one.
export const TOOLS: readonly Tool[] = [
  lookupCustomer,
  lookupTransaction,
  lookupPayout,
  createSupportTicket,
  createEscalation,
  logConversationEvent,
  customerOverview,
];
