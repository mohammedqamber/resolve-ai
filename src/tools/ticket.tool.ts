import { z } from "zod";
import { createTicketOnce, findOpenTicket, ISSUE_CATEGORIES, type Ticket } from "../data/store.js";
import { getOwnedOrder } from "./order.tool.js";
import { failure, success, type ToolContext, type ToolResult } from "./types.js";

export const createSupportTicketSchema = z.object({
  orderId: z.string().trim().min(1).max(40),
  issueCategory: z.enum(ISSUE_CATEGORIES),
  summary: z.string().trim().min(10).max(500).describe("One or two sentences describing the problem"),
  evidence: z.array(z.string().trim().min(1).max(300)).max(10).describe("Facts taken from tool results"),
});

type TicketArgs = z.infer<typeof createSupportTicketSchema>;

export type TicketOutcome = Pick<
  Ticket,
  "ticketId" | "customerId" | "orderId" | "category" | "summary" | "evidence" | "status" | "createdAt"
> & { alreadyExisted: boolean };

/**
 * Step 1 - when the model PROPOSES a ticket. Nothing is written.
 * Checks the order belongs to the customer and that this ticket would not be a duplicate.
 * The `summary` it returns is what the customer is asked to confirm.
 */
export async function checkTicketProposal(ctx: ToolContext, args: TicketArgs): Promise<ToolResult<{ summary: string }>> {
  const order = await getOwnedOrder(ctx, args.orderId);
  if (!order) return failure("NOT_FOUND", `No order ${args.orderId} was found for this customer.`);

  const existing = await findOpenTicket(ctx.customerId, order.orderId, args.issueCategory);
  if (existing) {
    return failure(
      "DUPLICATE_TICKET",
      `An open ticket (${existing.ticketId}) already exists for order ${order.orderId} in category ${args.issueCategory}. Tell the customer instead of creating another.`,
    );
  }
  return success({ summary: `Create a ${args.issueCategory} support ticket for order ${order.orderId}: ${args.summary}` });
}

/**
 * Step 2 - the actual WRITE. The agent only calls this after the customer confirmed a pending action.
 * It checks ownership again (revalidation) and is idempotent: calling it twice with the same
 * ctx.idempotencyKey, or for an already-open identical ticket, returns the existing ticket.
 */
export async function createSupportTicket(ctx: ToolContext, args: TicketArgs): Promise<ToolResult<TicketOutcome>> {
  const order = await getOwnedOrder(ctx, args.orderId);
  if (!order) return failure("NOT_FOUND", `No order ${args.orderId} was found for this customer.`);

  try {
    // customerId comes from the server session (ctx), never from the model's arguments.
    // We never retry: a retry after a half-failed write could create two tickets.
    const { ticket, alreadyExisted } = await createTicketOnce(
      {
        customerId: ctx.customerId,
        orderId: order.orderId,
        category: args.issueCategory,
        summary: args.summary,
        evidence: args.evidence,
      },
      ctx.idempotencyKey,
    );
    return success({
      ticketId: ticket.ticketId,
      customerId: ticket.customerId,
      orderId: ticket.orderId,
      category: ticket.category,
      summary: ticket.summary,
      evidence: ticket.evidence,
      status: ticket.status,
      createdAt: ticket.createdAt,
      alreadyExisted,
    });
  } catch {
    return failure("WRITE_FAILED", "The ticket could not be saved. No ticket was created.");
  }
}

/** The reply shown to the customer. Written by the backend (not the model) so it can never be wrong about the ticket ID. */
export function ticketResultMessage(ticket: TicketOutcome): string {
  if (ticket.alreadyExisted) {
    return `You already have an open ticket (${ticket.ticketId}) for this issue, so I did not create a duplicate. Our team will follow up there.`;
  }
  return `Done. I created support ticket ${ticket.ticketId} for order ${ticket.orderId}. Our team will follow up.`;
}
