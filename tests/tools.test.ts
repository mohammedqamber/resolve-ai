import { rm } from "node:fs/promises";
import { beforeAll, describe, expect, it, vi } from "vitest";

const DATA_FILE = "data/vitest.runtime.json";
const alice = { customerId: "cus_alice" };
const ben = { customerId: "cus_ben" };

let tools: {
  getOrderDetails: typeof import("../src/tools/order.tool.js").getOrderDetails;
  getRefundStatus: typeof import("../src/tools/refund.tool.js").getRefundStatus;
  getPaymentDetails: typeof import("../src/tools/payment.tool.js").getPaymentDetails;
  createSupportTicket: typeof import("../src/tools/ticket.tool.js").createSupportTicket;
};

beforeAll(async () => {
  vi.stubEnv("DATA_FILE", DATA_FILE);
  await rm(DATA_FILE, { force: true });
  const { initStore } = await import("../src/data/store.js");
  await initStore();
  tools = {
    ...(await import("../src/tools/order.tool.js")),
    ...(await import("../src/tools/refund.tool.js")),
    ...(await import("../src/tools/payment.tool.js")),
    ...(await import("../src/tools/ticket.tool.js")),
  };
});

describe("order ownership", () => {
  it("returns an order the customer owns", async () => {
    const result = await tools.getOrderDetails(alice, { orderId: "ORD-1001" });
    expect(result).toMatchObject({ ok: true, data: { product: "Wireless Headphones" } });
  });

  it("treats another customer's order exactly like an unknown order", async () => {
    const others = await tools.getOrderDetails(alice, { orderId: "ORD-2001" });
    const unknown = await tools.getOrderDetails(alice, { orderId: "ORD-9999" });
    expect(others).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(unknown).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("blocks refunds and payments of other customers' orders", async () => {
    expect(await tools.getRefundStatus(alice, { orderId: "ORD-2001" })).toMatchObject({ ok: false });
    expect(await tools.getPaymentDetails(alice, { orderId: "ORD-2001" })).toMatchObject({ ok: false });
    expect(await tools.getPaymentDetails(alice, { transactionId: "TXN-8004" })).toMatchObject({ ok: false });
  });
});

describe("refund and payment lookups", () => {
  it("finds the failed refund transfer for the headphones order", async () => {
    const refund = await tools.getRefundStatus(alice, { orderId: "ORD-1001" });
    expect(refund).toMatchObject({ ok: true, data: { refundStatus: "initiated", relatedTransactionId: "TXN-9001" } });

    const payment = await tools.getPaymentDetails(alice, { transactionId: "TXN-9001" });
    expect(payment).toMatchObject({ ok: true, data: { transactions: [{ status: "failed" }] } });
  });

  it("reports no refund when none exists", async () => {
    expect(await tools.getRefundStatus(alice, { orderId: "ORD-1003" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("flags the possible duplicate charge", async () => {
    const result = await tools.getPaymentDetails(ben, { orderId: "ORD-2002" });
    expect(result).toMatchObject({ ok: true, data: { possibleDuplicateGroups: [["TXN-8005", "TXN-8006"]] } });
  });
});

describe("order search by product name", () => {
  it("finds the customer's own order from a product word", async () => {
    const result = await tools.getOrderDetails(alice, { productName: "headphones" });
    expect(result).toMatchObject({ ok: true, data: { orders: [{ orderId: "ORD-1001" }] } });
  });

  it("never returns another customer's orders", async () => {
    expect(await tools.getOrderDetails(ben, { productName: "headphones" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("is rejected when neither orderId nor productName is given", async () => {
    const { getOrderDetailsSchema } = await import("../src/tools/order.tool.js");
    expect(getOrderDetailsSchema.safeParse({}).success).toBe(false);
  });
});

describe("createSupportTicket", () => {
  const args = {
    orderId: "ORD-1001",
    issueCategory: "refund_issue" as const,
    summary: "Refund transfer failed for the returned headphones.",
    evidence: ["TXN-9001 failed"],
  };

  it("saves a ticket using the session's customerId", async () => {
    const result = await tools.createSupportTicket(alice, args);
    expect(result).toMatchObject({ ok: true, data: { customerId: "cus_alice", status: "open" } });
  });

  it("refuses to create a ticket on someone else's order", async () => {
    expect(await tools.createSupportTicket(ben, args)).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
