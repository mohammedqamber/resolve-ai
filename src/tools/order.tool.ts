import { z } from "zod";
import { findOrder, listOrdersForCustomer, type Order } from "../data/store.js";
import { failure, success, type ToolContext, type ToolResult } from "./types.js";

// The Zod schema describes the arguments the model is allowed to send. (Stage 2 reuses it.)
export const getOrderDetailsSchema = z
  .object({
    orderId: z.string().trim().min(1).max(40).optional().describe("The order ID, for example ORD-1001"),
    productName: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .optional()
      .describe("Use when the customer gave no order ID: a product word like 'headphones'. Searches ONLY this customer's own orders."),
  })
  .refine((args) => args.orderId || args.productName, { message: "Provide orderId or productName" });

export type OrderDetails = Pick<
  Order,
  "orderId" | "customerId" | "product" | "purchaseDate" | "deliveryStatus" | "returnStatus"
>;

/**
 * Returns the order only if it belongs to the current customer.
 * Other customers' orders and unknown orders look identical ("not found"),
 * so the tools never confirm that someone else's order exists.
 * Every tool that touches an order goes through this check.
 */
export async function getOwnedOrder(ctx: ToolContext, orderId: string): Promise<Order | undefined> {
  const order = await findOrder(orderId.trim().toUpperCase());
  return order && order.customerId === ctx.customerId ? order : undefined;
}

export async function getOrderDetails(
  ctx: ToolContext,
  args: z.infer<typeof getOrderDetailsSchema>,
): Promise<ToolResult<OrderDetails | { orders: OrderDetails[] }>> {
  if (args.orderId) {
    const order = await getOwnedOrder(ctx, args.orderId);
    if (!order) return failure("NOT_FOUND", `No order ${args.orderId} was found for this customer.`);
    return success(toDetails(order));
  }

  // Search by product name, but only inside the session customer's own orders.
  const words = (args.productName ?? "").toLowerCase().split(/s+/).filter(Boolean);
  const matches = (await listOrdersForCustomer(ctx.customerId)).filter((o) =>
    words.every((w) => o.product.toLowerCase().includes(w)),
  );
  if (matches.length === 0) return failure("NOT_FOUND", `No order matching "${args.productName}" was found for this customer.`);
  return success({ orders: matches.map(toDetails) });
}

function toDetails(order: Order): OrderDetails {
  return {
    orderId: order.orderId,
    customerId: order.customerId,
    product: order.product,
    purchaseDate: order.purchaseDate,
    deliveryStatus: order.deliveryStatus,
    returnStatus: order.returnStatus,
  };
}
