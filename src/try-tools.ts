// Try the four tools by hand, no AI involved: `npm run try:tools`
// It uses its own throwaway data file so your real runtime data is untouched.

import { rm } from "node:fs/promises";

process.env.DATA_FILE = "data/try-tools.runtime.json";
await rm(process.env.DATA_FILE, { force: true }); // start from fresh seed data every run

// Dynamic imports so DATA_FILE is set before config.ts reads it.
const { initStore } = await import("./data/store.js");
const { getOrderDetails } = await import("./tools/order.tool.js");
const { getRefundStatus } = await import("./tools/refund.tool.js");
const { getPaymentDetails } = await import("./tools/payment.tool.js");
const { createSupportTicket } = await import("./tools/ticket.tool.js");

await initStore();
const alice = { customerId: "cus_alice" };

function show(title: string, result: unknown) {
  console.log(`\n=== ${title} ===\n${JSON.stringify(result, null, 2)}`);
}

show("Alice: order ORD-1001", await getOrderDetails(alice, { orderId: "ORD-1001" }));
show("Alice: refund for ORD-1001", await getRefundStatus(alice, { orderId: "ORD-1001" }));
show("Alice: payments for ORD-1001", await getPaymentDetails(alice, { orderId: "ORD-1001" }));
show("Alice tries Ben's order ORD-2001 (must be NOT_FOUND)", await getOrderDetails(alice, { orderId: "ORD-2001" }));
show("Alice: unknown order ORD-9999", await getOrderDetails(alice, { orderId: "ORD-9999" }));
show(
  "Ben: duplicate-charge check on ORD-2002",
  await getPaymentDetails({ customerId: "cus_ben" }, { orderId: "ORD-2002" }),
);
show(
  "Alice: create ticket",
  await createSupportTicket(alice, {
    orderId: "ORD-1001",
    issueCategory: "refund_issue",
    summary: "Refund transfer failed because the destination account was closed.",
    evidence: ["TXN-9001 status failed: Bank rejected the transfer: destination account closed"],
  }),
);
