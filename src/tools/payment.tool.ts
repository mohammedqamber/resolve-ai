import { z } from "zod";
import { findTransaction, findTransactionsByOrder, type Transaction } from "../data/store.js";
import { getOwnedOrder } from "./order.tool.js";
import { failure, success, type ToolContext, type ToolResult } from "./types.js";

// Look up ONE transaction by its ID, or ALL transactions of an order (useful for duplicate-charge checks).
export const getPaymentDetailsSchema = z
  .object({
    transactionId: z.string().trim().min(1).max(40).optional().describe("A transaction ID, for example TXN-8001"),
    orderId: z.string().trim().min(1).max(40).optional().describe("List every transaction for this order"),
  })
  .refine((args) => args.transactionId || args.orderId, {
    message: "Provide transactionId or orderId",
  });

export type PaymentDetails = {
  transactions: Pick<Transaction, "transactionId" | "orderId" | "type" | "amount" | "status" | "failureReason" | "createdAt">[];
  // Groups of transaction IDs that look like the same charge made twice. Computed from the records.
  possibleDuplicateGroups: string[][];
};

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000; // same amount, same order, within 10 minutes

export async function getPaymentDetails(
  ctx: ToolContext,
  args: z.infer<typeof getPaymentDetailsSchema>,
): Promise<ToolResult<PaymentDetails>> {
  let transactions: Transaction[];

  if (args.transactionId) {
    const found = await findTransaction(args.transactionId.toUpperCase());
    // Authorization goes through the order: the transaction must belong to one of this customer's orders.
    const order = found && (await getOwnedOrder(ctx, found.orderId));
    if (!found || !order) return failure("NOT_FOUND", `No transaction ${args.transactionId} was found for this customer.`);
    transactions = [found];
  } else {
    const order = await getOwnedOrder(ctx, args.orderId ?? "");
    if (!order) return failure("NOT_FOUND", `No order ${args.orderId} was found for this customer.`);
    transactions = await findTransactionsByOrder(order.orderId);
    if (transactions.length === 0) return failure("NOT_FOUND", `No transactions on record for order ${order.orderId}.`);
  }

  return success({
    transactions: transactions.map((t) => ({
      transactionId: t.transactionId,
      orderId: t.orderId,
      type: t.type,
      amount: t.amount,
      status: t.status,
      failureReason: t.failureReason,
      createdAt: t.createdAt,
    })),
    possibleDuplicateGroups: findDuplicateGroups(transactions),
  });
}

function findDuplicateGroups(transactions: Transaction[]): string[][] {
  const charges = transactions.filter((t) => t.type === "charge" && t.status === "success");
  const groups: string[][] = [];
  const used = new Set<string>();

  for (const first of charges) {
    if (used.has(first.transactionId)) continue;
    const twins = charges.filter(
      (other) =>
        other.amount === first.amount &&
        Math.abs(Date.parse(other.createdAt) - Date.parse(first.createdAt)) <= DUPLICATE_WINDOW_MS,
    );
    if (twins.length > 1) {
      twins.forEach((t) => used.add(t.transactionId));
      groups.push(twins.map((t) => t.transactionId));
    }
  }
  return groups;
}
