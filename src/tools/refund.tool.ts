import { z } from "zod";
import { findRefundByOrder, type Refund } from "../data/store.js";
import { getOwnedOrder } from "./order.tool.js";
import { failure, success, type ToolContext, type ToolResult } from "./types.js";

export const getRefundStatusSchema = z.object({
  orderId: z.string().trim().min(1).max(40).describe("The order ID the refund belongs to"),
});

export type RefundStatus = Refund;

export async function getRefundStatus(
  ctx: ToolContext,
  args: z.infer<typeof getRefundStatusSchema>,
): Promise<ToolResult<RefundStatus>> {
  const order = await getOwnedOrder(ctx, args.orderId);
  if (!order) return failure("NOT_FOUND", `No order ${args.orderId} was found for this customer.`);

  const refund = await findRefundByOrder(order.orderId);
  if (!refund) return failure("NOT_FOUND", `There is no refund on record for order ${order.orderId}.`);

  return success({
    refundId: refund.refundId,
    orderId: refund.orderId,
    amount: refund.amount,
    refundStatus: refund.refundStatus,
    initiatedAt: refund.initiatedAt,
    relatedTransactionId: refund.relatedTransactionId,
  });
}
