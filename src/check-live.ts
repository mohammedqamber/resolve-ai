// Checks the REAL Gemini model on the two things mocked tests cannot prove (needs GEMINI_API_KEY):
//   npm run check:live
// 1. A completed refund is described as "our records", not as money that reached the bank.
// 2. The ticket flow needs only ONE "yes".
// It uses a throwaway data file. It makes about 10 model calls, so mind your free-tier rate limit.
// The checks look at tool calls and a few risky phrases; they are a smoke test, not a guarantee.

import { rm } from "node:fs/promises";

process.env.DATA_FILE = "data/check-live.runtime.json";
await rm(process.env.DATA_FILE, { force: true });

const { initStore, listTicketsForCustomer } = await import("./data/store.js");
const { chat } = await import("./agent/agent.js");
const { ModelError } = await import("./models/types.js");
await initStore();

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}
const tools = (activities: { tool: string }[]) => activities.map((a) => a.tool);

try {
  console.log("\n--- 1. Completed refund (Alice, ORD-1002) ---");
  const refund = await chat({ customerId: "cus_alice", message: "Has my keyboard refund (ORD-1002) arrived in my bank?" });
  console.log(`Agent: ${refund.reply}\n`);
  check("checked the refund", tools(refund.activities).includes("getRefundStatus"));
  check("checked the payment transaction too", tools(refund.activities).includes("getPaymentDetails"));
  check("does not claim the money reached the bank", !/(has|have) (been )?(deposited|received|arrived)|\d+\s*(-\s*\d+\s*)?(business )?days/i.test(refund.reply));
  check("says it cannot see the bank side", /can(no|')t see|cannot verify|don't have|do not have|unable to (see|verify)/i.test(refund.reply));

  console.log("\n--- 2. Ticket flow with ONE yes (Alice, ORD-1001) ---");
  const first = await chat({ customerId: "cus_alice", message: "I returned my headphones but have not received my refund." });
  console.log(`Agent: ${first.reply}\n`);
  check("prepared a ticket (pendingAction present)", first.pendingAction?.type === "CREATE_SUPPORT_TICKET");
  check("activity shows awaiting_confirmation, not success", first.activities.some((a) => a.tool === "createSupportTicket" && a.status === "awaiting_confirmation"));
  check("no ticket exists yet", (await listTicketsForCustomer("cus_alice")).length === 0);

  const yes = await chat({ customerId: "cus_alice", conversationId: first.conversationId, message: "Yes, please." });
  console.log(`Agent: ${yes.reply}\n`);
  const tickets = await listTicketsForCustomer("cus_alice");
  check("ONE 'yes' created exactly one ticket", tickets.length === 1);
  check("reply quotes the real ticket id", tickets[0] !== undefined && yes.reply.includes(tickets[0].ticketId));
} catch (err) {
  if (err instanceof ModelError) console.error(`\nModel error (${err.kind}): ${err.message}. If this is a rate limit, wait a minute and retry.`);
  else throw err;
  failures++;
}

console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed. Read the replies above.`);
process.exitCode = failures === 0 ? 0 : 1;
