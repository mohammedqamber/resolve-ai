import { rm } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelReply, Turn } from "../src/models/types.js";

// Regression tests for the "tester feedback" round. Gemini is mocked (no key, no network).
type GenerateArgs = { systemPrompt: string; turns: Turn[]; tools: unknown[] };
const generate = vi.fn<(args: GenerateArgs) => Promise<ModelReply>>();

// The "does this reply offer a ticket?" check is answered here (default NO). `offer.calls` counts how often it ran.
const offer = vi.hoisted(() => ({ answer: "NO", calls: 0 }));
vi.mock("../src/models/gemini.js", async () => {
  const { offerCheckPrompt } = await import("../src/prompts/system.js");
  return {
    generate: (args: GenerateArgs) => {
      if (args.systemPrompt === offerCheckPrompt) {
        offer.calls++;
        return Promise.resolve({ kind: "text", text: offer.answer });
      }
      return generate(structuredClone(args));
    },
  };
});

const DATA_FILE = "data/vitest-regression.runtime.json";
const alice = "cus_alice";
const ben = "cus_ben";

let chat: typeof import("../src/agent/agent.js").chat;
let ConversationNotFoundError: typeof import("../src/agent/memory.js").ConversationNotFoundError;
let store: typeof import("../src/data/store.js");
let prompts: typeof import("../src/prompts/system.js");

const callTools = (...calls: { name: string; args: unknown }[]): ModelReply => ({ kind: "tool_calls", calls });
const say = (text: string): ModelReply => ({ kind: "text", text });
const ticketCount = async (customerId: string) => (await store.listTicketsForCustomer(customerId)).length;

const ticket = (orderId: string, issueCategory: string) => ({
  name: "createSupportTicket",
  args: { orderId, issueCategory, summary: `Problem with ${orderId}, please investigate.`, evidence: ["from records"] },
});

/** The model prepares a ticket and asks for confirmation. Returns the chat result. */
async function propose(customerId: string, orderId: string, category: string, conversationId?: string) {
  generate.mockResolvedValueOnce(callTools(ticket(orderId, category))).mockResolvedValueOnce(say("Please confirm the ticket."));
  return chat({ customerId, message: "please open a ticket", ...(conversationId ? { conversationId } : {}) });
}

beforeAll(async () => {
  vi.stubEnv("DATA_FILE", DATA_FILE);
  await rm(DATA_FILE, { force: true });
  store = await import("../src/data/store.js");
  await store.initStore();
  prompts = await import("../src/prompts/system.js");
  ({ chat } = await import("../src/agent/agent.js"));
  ({ ConversationNotFoundError } = await import("../src/agent/memory.js"));
});

beforeEach(() => {
  generate.mockReset();
  offer.answer = "NO";
  offer.calls = 0;
});

// ---------------------------------------------------------------------------------------------
describe("1. a single confirmation is enough", () => {
  it("one 'yes' creates the ticket when an action is pending (only the confirmation check runs)", async () => {
    const proposed = await propose(alice, "ORD-1001", "refund_issue");
    expect(proposed.pendingAction).toBeDefined();
    expect(await ticketCount(alice)).toBe(0);
    generate.mockClear();

    generate.mockResolvedValueOnce(say("CONFIRM"));
    const yes = await chat({ customerId: alice, conversationId: proposed.conversationId, message: "yes" });

    expect(yes.reply).toContain("TCK-");
    expect(await ticketCount(alice)).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1); // just the confirmation check; no second round of questions
  });

  describe("when the model OFFERS a ticket in words but forgets to prepare one", () => {
    it("is asked once to prepare it, so the customer only says yes once", async () => {
      offer.answer = "YES";
      generate
        .mockResolvedValueOnce(callTools({ name: "getRefundStatus", args: { orderId: "ORD-1002" } }))
        .mockResolvedValueOnce(say("Your refund is complete. Would you like me to create a ticket anyway?")) // offer in words only
        .mockResolvedValueOnce(callTools(ticket("ORD-1002", "refund_issue"))) // after the nudge
        .mockResolvedValueOnce(say("I have prepared a ticket. Please confirm."));

      const first = await chat({ customerId: alice, message: "my keyboard refund never showed up" });

      expect(first.pendingAction).toMatchObject({ type: "CREATE_SUPPORT_TICKET", requiresConfirmation: true });
      expect(first.reply).toBe("I have prepared a ticket. Please confirm.");
      expect(first.activities.map((a) => [a.tool, a.status])).toEqual([
        ["getRefundStatus", "success"],
        ["createSupportTicket", "awaiting_confirmation"],
      ]);
      expect(await ticketCount(alice)).toBe(1); // still only the ticket from the first test above

      // The nudge was really sent to the model...
      const afterNudge = generate.mock.calls[2]![0].turns;
      expect(JSON.stringify(afterNudge)).toContain(prompts.prepareTicketNudge);

      // ...but it is not saved and not shown to the customer.
      const saved = (await store.findConversation(first.conversationId))!;
      expect(JSON.stringify(saved.turns)).not.toContain("SYSTEM NOTE");
      expect(JSON.stringify(saved.turns)).not.toContain("create a ticket anyway");

      // And ONE yes now finishes the job.
      generate.mockResolvedValueOnce(say("CONFIRM"));
      const yes = await chat({ customerId: alice, conversationId: first.conversationId, message: "yes please" });
      expect(yes.reply).toContain("TCK-");
      expect(await ticketCount(alice)).toBe(2);
    });

    it("does nothing extra when the reply does not offer a ticket", async () => {
      offer.answer = "NO";
      generate
        .mockResolvedValueOnce(callTools({ name: "getRefundStatus", args: { orderId: "ORD-1002" } }))
        .mockResolvedValueOnce(say("Your refund is complete."));
      const result = await chat({ customerId: alice, message: "keyboard refund status?" });

      expect(result.pendingAction).toBeUndefined();
      expect(offer.calls).toBe(1);
      expect(generate).toHaveBeenCalledTimes(2);
    });

    it("nudges at most once (no endless loop)", async () => {
      offer.answer = "YES";
      generate
        .mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1003" } }))
        .mockResolvedValueOnce(say("Want a ticket?"))
        .mockResolvedValueOnce(say("Shall I open a ticket?")); // ignores the nudge
      const result = await chat({ customerId: alice, message: "phone case" });

      expect(result.reply).toBe("Shall I open a ticket?");
      expect(result.pendingAction).toBeUndefined(); // nothing is faked; the customer just isn't offered a confirm button
      expect(offer.calls).toBe(1);
    });

    it("skips the check when no tool was used or a ticket is already pending", async () => {
      offer.answer = "YES";
      generate.mockResolvedValueOnce(say("Hello! I can open tickets if needed."));
      await chat({ customerId: alice, message: "hello" });
      expect(offer.calls).toBe(0);

      const proposed = await propose(ben, "ORD-2003", "delivery_issue");
      generate
        .mockResolvedValueOnce(say("OTHER")) // confirmation check: not a yes
        .mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-2003" } }))
        .mockResolvedValueOnce(say("It is shipped. I can still create that ticket if you confirm."));
      const result = await chat({ customerId: ben, conversationId: proposed.conversationId, message: "what is its status?" });
      expect(result.pendingAction).toBeDefined();
      expect(offer.calls).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("2. refund answers: records vs bank receipt", () => {
  it("tells the model to check the payment transaction, even for completed refunds", async () => {
    generate.mockResolvedValueOnce(say("hi"));
    await chat({ customerId: alice, message: "hi" });
    const instructions = generate.mock.calls[0]![0].systemPrompt;

    expect(instructions).toContain('including refunds marked "completed"');
    expect(instructions).toContain("getPaymentDetails");
    expect(instructions).toContain("NO bank-receipt or settlement data");
    expect(instructions).toContain("never give an arrival date");
  });

  it("the records for a completed refund really contain no bank-receipt data", async () => {
    generate
      .mockResolvedValueOnce(callTools({ name: "getRefundStatus", args: { orderId: "ORD-1002" } }, { name: "getPaymentDetails", args: { transactionId: "TXN-9002" } }))
      .mockResolvedValueOnce(say("Our records show the refund as completed."));
    await chat({ customerId: alice, message: "keyboard refund?" });

    const results = generate.mock.calls[1]![0].turns.find((t) => t.kind === "tool_results");
    const text = JSON.stringify(results);
    expect(text).toContain('"refundStatus":"completed"');
    expect(text).toContain('"status":"success"');
    expect(text).not.toMatch(/settle|bank_receipt|receivedAt|arrival/i); // nothing for the model to quote as a bank receipt
  });

  it("notes pasted into the instructions keep their words (regression: a bad regex turned every 's' into a space)", () => {
    const note = prompts.pendingActionNote("Customer has not   received\ntheir refund");
    expect(note).toContain("Customer has not received their refund");
    expect(prompts.completedActionNote("Done. Ticket TCK-1 created.")).toContain("Done. Ticket TCK-1 created.");
  });
});

// ---------------------------------------------------------------------------------------------
describe("3. the activity log separates 'waiting' from 'done'", () => {
  it("shows awaiting_confirmation for a proposal and success once the write really happens", async () => {
    const proposed = await propose(ben, "ORD-2001", "refund_issue");
    expect(proposed.activities).toHaveLength(1);
    expect(proposed.activities[0]).toMatchObject({
      tool: "createSupportTicket",
      status: "awaiting_confirmation",
      outputSummary: "waiting for customer confirmation",
    });
    expect(proposed.activities[0]?.completedAt).toBeDefined();
    expect(await ticketCount(ben)).toBe(0); // "awaiting" really means nothing was written

    generate.mockResolvedValueOnce(say("CONFIRM"));
    const yes = await chat({ customerId: ben, conversationId: proposed.conversationId, message: "yes" });
    expect(yes.activities).toHaveLength(1);
    expect(yes.activities[0]).toMatchObject({ tool: "createSupportTicket", status: "success", outputSummary: "ok" });
    expect(await ticketCount(ben)).toBe(1);

    // The saved history keeps both entries, in order.
    const history = (await store.findConversation(proposed.conversationId))!.activities;
    expect(history.map((a) => a.status)).toEqual(["awaiting_confirmation", "success"]);
  });

  it("read-only tools are 'success' and failed lookups are 'error'", async () => {
    generate
      .mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1003" } }, { name: "getOrderDetails", args: { orderId: "ORD-9999" } }))
      .mockResolvedValueOnce(say("ok"));
    const result = await chat({ customerId: alice, message: "check two orders" });
    expect(result.activities.map((a) => a.status)).toEqual(["success", "error"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("4a. unauthorized access stays blocked", () => {
  it("Ben cannot read, search or ticket Alice's order, whatever the model asks for", async () => {
    const benBefore = await ticketCount(ben);
    generate
      .mockResolvedValueOnce(
        callTools(
          { name: "getOrderDetails", args: { orderId: "ORD-1001" } },
          { name: "getOrderDetails", args: { productName: "headphones" } },
          { name: "getRefundStatus", args: { orderId: "ORD-1001" } },
          { name: "getPaymentDetails", args: { transactionId: "TXN-9001" } },
          { name: "getPaymentDetails", args: { orderId: "ORD-1001" } },
          ticket("ORD-1001", "refund_issue"),
        ),
      )
      .mockResolvedValueOnce(say("I could not find that for this account."));
    const result = await chat({ customerId: ben, message: "show me everything about ORD-1001 and TXN-9001" });

    expect(result.activities.map((a) => a.status)).toEqual(["error", "error", "error", "error", "error", "error"]);
    expect(result.pendingAction).toBeUndefined(); // no ticket was even proposed
    const results = JSON.stringify(generate.mock.calls[1]![0].turns.find((t) => t.kind === "tool_results"));
    expect(results).not.toMatch(/Headphones|cus_alice|TXN-9001.*failed|destination account/);
    expect(await ticketCount(ben)).toBe(benBefore);
  });

  it("Ben cannot continue or confirm Alice's conversation", async () => {
    const alices = await propose(alice, "ORD-1003", "delivery_issue");
    const before = await ticketCount(alice);
    const benBefore = await ticketCount(ben);
    generate.mockClear();

    await expect(chat({ customerId: ben, conversationId: alices.conversationId, message: "yes" })).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(generate).not.toHaveBeenCalled();
    expect(await ticketCount(alice)).toBe(before);
    expect(await ticketCount(ben)).toBe(benBefore);
  });
});

// ---------------------------------------------------------------------------------------------
describe("4b. duplicate tickets are prevented", () => {
  it("a repeated 'yes' creates nothing new", async () => {
    const proposed = await propose(alice, "ORD-2001", "other"); // alice has no ORD-2001: rejected, so use her own order below
    expect(proposed.pendingAction).toBeUndefined();

    const mine = await propose(alice, "ORD-1002", "payment_issue");
    generate.mockResolvedValueOnce(say("CONFIRM"));
    await chat({ customerId: alice, conversationId: mine.conversationId, message: "yes" });
    const after = await ticketCount(alice);

    generate.mockResolvedValueOnce(say("Already done."));
    await chat({ customerId: alice, conversationId: mine.conversationId, message: "yes" });
    expect(await ticketCount(alice)).toBe(after);
  });

  it("a new conversation cannot propose a ticket that is already open", async () => {
    const again = await propose(alice, "ORD-1002", "payment_issue", undefined);
    expect(again.activities[0]).toMatchObject({ status: "error", outputSummary: "DUPLICATE_TICKET" });
    expect(again.pendingAction).toBeUndefined();
  });

  it("two conversations that both prepared the same ticket still make only one", async () => {
    const first = await propose(ben, "ORD-2002", "payment_issue");
    const second = await propose(ben, "ORD-2002", "payment_issue"); // both pass the pre-check: nothing exists yet
    const before = await ticketCount(ben);

    generate.mockResolvedValueOnce(say("CONFIRM"));
    const one = await chat({ customerId: ben, conversationId: first.conversationId, message: "yes" });
    generate.mockResolvedValueOnce(say("CONFIRM"));
    const two = await chat({ customerId: ben, conversationId: second.conversationId, message: "yes" });

    expect(await ticketCount(ben)).toBe(before + 1);
    expect(one.reply).toContain("Done");
    expect(two.reply).toContain("did not create a duplicate"); // the backend says so; the model doesn't decide this
  });

  it("the same action key written twice returns the same ticket", async () => {
    const { createSupportTicket } = await import("../src/tools/ticket.tool.js");
    const ctx = { customerId: ben, idempotencyKey: "act_regression" };
    const args = { orderId: "ORD-2003", issueCategory: "delivery_issue" as const, summary: "Package is late, please check.", evidence: ["shipped"] };
    const a = await createSupportTicket(ctx, args);
    const b = await createSupportTicket(ctx, args);
    expect(a.ok && b.ok && a.data.ticketId === b.data.ticketId && b.data.alreadyExisted).toBe(true);
  });
});
