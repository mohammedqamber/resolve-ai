import { z } from "zod";
import { getOrderDetails, getOrderDetailsSchema } from "./order.tool.js";
import { getPaymentDetails, getPaymentDetailsSchema } from "./payment.tool.js";
import { getRefundStatus, getRefundStatusSchema } from "./refund.tool.js";
import { checkTicketProposal, createSupportTicket, createSupportTicketSchema, ticketResultMessage } from "./ticket.tool.js";
import type { ToolContext, ToolResult } from "./types.js";

// The registry is the ONLY list of tools the agent knows about.
// To add a tool later: write its file, then add one line to `tools` below. The agent loop never changes.
export type Tool = {
  name: string;
  description: string; // the model reads this to decide WHEN to call the tool
  schema: z.ZodType; // validates (and documents) the arguments the model sends
  // Only tools that CHANGE data have this. The model can only propose them: the agent saves a pending
  // action, asks the customer, and runs `execute` only after the customer confirms.
  action?: {
    type: string; // shown to the frontend, e.g. "CREATE_SUPPORT_TICKET"
    precheck: (ctx: ToolContext, args: never) => Promise<ToolResult<{ summary: string }>>; // runs at proposal time, writes nothing
    successMessage: (data: never) => string; // reply shown after a successful confirmed write
  };
  execute: (ctx: ToolContext, args: never) => Promise<unknown>;
};

// Keeps each entry type-checked: `execute` must accept exactly what `schema` produces.
function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  schema: S;
  action?: {
    type: string;
    precheck: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolResult<{ summary: string }>>;
    // `any`: the result type differs per tool and the registry stores them all together
    successMessage: (data: any) => string;
  };
  execute: (ctx: ToolContext, args: z.infer<S>) => Promise<unknown>;
}): Tool {
  return tool as unknown as Tool;
}

export const tools: Tool[] = [
  defineTool({
    name: "getOrderDetails",
    description:
      "Look up the customer's order(s): product, purchase date, delivery status and return status. Give an orderId if you have one. If the customer only describes the item (for example 'my headphones'), give productName instead and you get their matching orders, so do not ask for an order ID first.",
    schema: getOrderDetailsSchema,
    execute: getOrderDetails,
  }),
  defineTool({
    name: "getRefundStatus",
    description:
      "Get the refund for an order: amount, refund status, when it was initiated and the related transaction ID.",
    schema: getRefundStatusSchema,
    execute: getRefundStatus,
  }),
  defineTool({
    name: "getPaymentDetails",
    description:
      "Get payment transactions, either one by transactionId or all for an orderId. Shows status and failure reasons, and flags possible duplicate charges.",
    schema: getPaymentDetailsSchema,
    execute: getPaymentDetails,
  }),
  defineTool({
    name: "createSupportTicket",
    description:
      "Prepare a support ticket for a problem the records cannot resolve. This does NOT create the ticket: the customer is asked to confirm first, and only then does the system create it. Call it when you are ready to offer a ticket, then ask the customer to confirm.",
    schema: createSupportTicketSchema,
    action: { type: "CREATE_SUPPORT_TICKET", precheck: checkTicketProposal, successMessage: ticketResultMessage },
    execute: createSupportTicket,
  }),
];

export function findTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
