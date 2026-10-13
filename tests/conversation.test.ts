import { rm } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelReply, Turn } from "../src/models/types.js";

// Gemini is mocked: no API key, no network. Calls are answered in the order the test scripts them.
// Remember: when a ticket is pending, the customer's next message first goes to the small
// "CONFIRM / DECLINE / OTHER" check, which is also a (mocked) model call.
type GenerateArgs = { systemPrompt: string; turns: Turn[]; tools: unknown[] };
const generate = vi.fn<(args: GenerateArgs) => Promise<ModelReply>>();
// The "does this reply offer a ticket?" check is answered here (default NO), so tests that don't care about it stay simple.
const offer = vi.hoisted(() => ({ answer: "NO", calls: 0 }));
// structuredClone: record what the model saw AT THAT MOMENT (the agent keeps adding to its turns array later).
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

const DATA_FILE = "data/vitest-conv.runtime.json";
const alice = "cus_alice";
const ben = "cus_ben";

let chat: typeof import("../src/agent/agent.js").chat;
let ConversationNotFoundError: typeof import("../src/agent/memory.js").ConversationNotFoundError;
let store: typeof import("../src/data/store.js");

const callTools = (...calls: { name: string; args: unknown }[]): ModelReply => ({ kind: "tool_calls", calls });
const say = (text: string): ModelReply => ({ kind: "text", text });

const ticketArgs = {
  orderId: "ORD-1001",
  issueCategory: "refund_issue",
  summary: "Refund transfer failed for the returned headphones.",
  evidence: ["TXN-9001 refund transfer failed"],
};

const ticketCount = async (customerId = alice) => (await store.listTicketsForCustomer(customerId)).length;

// The investigation from the acceptance test: model looks things up, prepares a ticket, asks the customer.
function scriptInvestigation() {
  generate
    .mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1001" } }))
    .mockResolvedValueOnce(callTools({ name: "getRefundStatus", args: { orderId: "ORD-1001" } }))
    .mockResolvedValueOnce(callTools({ name: "getPaymentDetails", args: { orderId: "ORD-1001" } }))
    .mockResolvedValueOnce(callTools({ name: "createSupportTicket", args: ticketArgs }))
    .mockResolvedValueOnce(say("Your refund transfer failed. Would you like me to create a ticket?"));
}


beforeAll(async () => {
  vi.stubEnv("DATA_FILE", DATA_FILE);
  await rm(DATA_FILE, { force: true });
  store = await import("../src/data/store.js");
  await store.initStore();
  ({ chat } = await import("../src/agent/agent.js"));
  ({ ConversationNotFoundError } = await import("../src/agent/memory.js"));
});

beforeEach(() => {
  generate.mockReset();
  offer.answer = "NO";
  offer.calls = 0;
});

describe("acceptance: refund investigation, confirmation, no duplicates", () => {
  let conversationId: string;
  let ticketsBefore: number;

  it("step 1: investigates with real tools and asks before creating a ticket", async () => {
    ticketsBefore = await ticketCount();
    scriptInvestigation();
    const first = await chat({ customerId: alice, message: "I returned my headphones but have not received my refund." });
    conversationId = first.conversationId;

    expect(first.activities.map((a) => a.tool)).toEqual([
      "getOrderDetails",
      "getRefundStatus",
      "getPaymentDetails",
      "createSupportTicket",
    ]);
    expect(first.reply).toContain("Would you like me to create a ticket");
    expect(first.pendingAction).toMatchObject({ type: "CREATE_SUPPORT_TICKET", requiresConfirmation: true });
    expect(await ticketCount()).toBe(ticketsBefore); // nothing written yet

    // The model really saw the seeded failed transfer, not made-up data.
    const lastCallTurns = generate.mock.calls.at(-1)![0].turns;
    expect(JSON.stringify(lastCallTurns)).toContain("failed");
  });

  it("step 2: 'Yes, please' creates exactly one real ticket and returns its real ID", async () => {
    generate.mockResolvedValueOnce(say("CONFIRM"));
    const second = await chat({ customerId: alice, conversationId, message: "Yes, please." });

    expect(await ticketCount()).toBe(ticketsBefore + 1);
    const ticket = (await store.listTicketsForCustomer(alice)).at(-1)!;
    expect(second.reply).toContain(ticket.ticketId); // the ID in the reply is the stored one
    expect(ticket).toMatchObject({ customerId: alice, orderId: "ORD-1001", category: "refund_issue", status: "open" });
    expect(second.pendingAction).toBeUndefined();
    expect(second.activities[0]).toMatchObject({ tool: "createSupportTicket", status: "success" });
    expect(generate).toHaveBeenCalledTimes(1); // only the confirmation check, not the main model
  });

  it("step 3: repeating the confirmation does not create a duplicate", async () => {
    generate.mockResolvedValueOnce(say("Your ticket is already created."));
    await chat({ customerId: alice, conversationId, message: "Yes, please." });
    expect(await ticketCount()).toBe(ticketsBefore + 1);

    // The model is told the action is already DONE (with the real ticket ID), so it won't ask again.
    const ticket = (await store.listTicketsForCustomer(alice)).at(-1)!;
    expect(generate.mock.calls.at(-1)![0].systemPrompt).toContain(ticket.ticketId);
    expect(generate.mock.calls.at(-1)![0].systemPrompt).toContain("Do not ask them to confirm it again");
  });

  it("step 4: even if the model proposes the same ticket again, none is created", async () => {
    generate
      .mockResolvedValueOnce(callTools({ name: "createSupportTicket", args: ticketArgs }))
      .mockResolvedValueOnce(say("You already have a ticket."));
    const result = await chat({ customerId: alice, conversationId, message: "Please open another ticket." });

    expect(result.activities[0]).toMatchObject({ status: "error", outputSummary: "DUPLICATE_TICKET" });
    expect(result.pendingAction).toBeUndefined();
    expect(await ticketCount()).toBe(ticketsBefore + 1);
  });

  it("step 5: other customers cannot see or use this conversation or ticket", async () => {
    await expect(chat({ customerId: ben, conversationId, message: "Yes, please." })).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await ticketCount(ben)).toBe(0);
    expect(generate).not.toHaveBeenCalled(); // rejected before any model call
  });
});

describe("confirmation rules", () => {
  it("two 'yes' requests sent at the same time create one ticket", async () => {
    const chloe = "cus_chloe";
    generate
      .mockResolvedValueOnce(
        callTools({
          name: "createSupportTicket",
          args: { orderId: "ORD-3001", issueCategory: "delivery_issue", summary: "Delivered but the package never arrived.", evidence: ["order shows delivered"] },
        }),
      )
      .mockResolvedValueOnce(say("Shall I create a ticket?"));
    const proposed = await chat({ customerId: chloe, message: "My backpack never arrived" });
    const before = await ticketCount(chloe);

    // Request 1 gets CONFIRM and writes. Request 2 waits its turn, finds nothing pending, and goes to the model.
    generate.mockResolvedValueOnce(say("CONFIRM")).mockResolvedValueOnce(say("Your ticket already exists."));
    const [one, two] = await Promise.all([
      chat({ customerId: chloe, conversationId: proposed.conversationId, message: "yes" }),
      chat({ customerId: chloe, conversationId: proposed.conversationId, message: "yes" }),
    ]);

    expect(await ticketCount(chloe)).toBe(before + 1);
    expect(one.reply).toContain("TCK-");
    expect(two.reply).toBe("Your ticket already exists.");
  });

  it("decline cancels the pending action and writes nothing", async () => {
    generate.mockResolvedValueOnce(callTools({ name: "createSupportTicket", args: { ...ticketArgs, orderId: "ORD-1002" } }));
    generate.mockResolvedValueOnce(say("Shall I create it?"));
    const proposed = await chat({ customerId: alice, message: "ticket for my keyboard refund" });
    expect(proposed.pendingAction).toBeDefined();
    const before = await ticketCount();

    generate.mockResolvedValueOnce(say("DECLINE"));
    const declined = await chat({ customerId: alice, conversationId: proposed.conversationId, message: "No thanks" });

    expect(declined.pendingAction).toBeUndefined();
    expect(declined.reply).toContain("not created anything");
    expect(await ticketCount()).toBe(before);
  });

  it("an unrelated message keeps the action pending and tells the model about it", async () => {
    generate.mockResolvedValueOnce(callTools({ name: "createSupportTicket", args: { ...ticketArgs, orderId: "ORD-1002" } }));
    generate.mockResolvedValueOnce(say("Shall I create it?"));
    const proposed = await chat({ customerId: alice, message: "ticket for my keyboard refund" });

    generate.mockResolvedValueOnce(say("OTHER")).mockResolvedValueOnce(say("It takes 5 days."));
    const result = await chat({ customerId: alice, conversationId: proposed.conversationId, message: "How long does a refund take?" });

    expect(result.reply).toBe("It takes 5 days.");
    expect(result.pendingAction).toMatchObject({ type: "CREATE_SUPPORT_TICKET" });
    expect(generate.mock.calls.at(-1)![0].systemPrompt).toContain("waiting for the customer's confirmation");
  });

  it("anything but exactly CONFIRM from the check means no write", async () => {
    generate.mockResolvedValueOnce(callTools({ name: "createSupportTicket", args: { ...ticketArgs, orderId: "ORD-1002", issueCategory: "other" } }));
    generate.mockResolvedValueOnce(say("Shall I create it?"));
    const proposed = await chat({ customerId: alice, message: "ticket please" });
    const before = await ticketCount();

    generate.mockResolvedValueOnce(say("Sure! I think they would CONFIRM it.")).mockResolvedValueOnce(say("ok"));
    const result = await chat({ customerId: alice, conversationId: proposed.conversationId, message: "hmm maybe" });

    expect(await ticketCount()).toBe(before);
    expect(result.pendingAction).toBeDefined();
  });

  it("an expired proposal can no longer be confirmed", async () => {
    generate.mockResolvedValueOnce(callTools({ name: "createSupportTicket", args: { ...ticketArgs, orderId: "ORD-1002", issueCategory: "delivery_issue" } }));
    generate.mockResolvedValueOnce(say("Shall I create it?"));
    const proposed = await chat({ customerId: alice, message: "ticket please" });
    const before = await ticketCount();

    const saved = (await store.findConversation(proposed.conversationId))!;
    saved.pendingAction!.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    await store.saveConversation(saved);

    generate.mockResolvedValueOnce(say("Do you still want a ticket?"));
    const result = await chat({ customerId: alice, conversationId: proposed.conversationId, message: "yes" });

    expect(result.pendingAction).toBeUndefined();
    expect(await ticketCount()).toBe(before);
    expect(generate).toHaveBeenCalledTimes(3); // 2 earlier + 1 now: no confirmation check ran
  });
});

describe("idempotent ticket write", () => {
  it("the same action key never creates two tickets", async () => {
    const { createSupportTicket } = await import("../src/tools/ticket.tool.js");
    const ctx = { customerId: "cus_ben", idempotencyKey: "act_test1" };
    const args = {
      orderId: "ORD-2001",
      issueCategory: "refund_issue" as const,
      summary: "Refund has not arrived after return.",
      evidence: ["no refund record seen"],
    };
    const first = await createSupportTicket(ctx, args);
    const second = await createSupportTicket(ctx, args);

    expect(first).toMatchObject({ ok: true, data: { alreadyExisted: false } });
    expect(second).toMatchObject({ ok: true, data: { alreadyExisted: true } });
    expect(first.ok && second.ok && first.data.ticketId === second.data.ticketId).toBe(true);
  });
});

describe("memory", () => {
  it("remembers earlier lookups so a follow-up like 'why is it still pending?' has context", async () => {
    generate
      .mockResolvedValueOnce(callTools({ name: "getRefundStatus", args: { orderId: "ORD-1002" } }))
      .mockResolvedValueOnce(say("Your keyboard refund is being processed."));
    const first = await chat({ customerId: alice, message: "Where is my keyboard refund?" });

    generate.mockResolvedValueOnce(say("Because the bank is still processing it."));
    await chat({ customerId: alice, conversationId: first.conversationId, message: "Why is it still pending?" });

    const sentToModel = JSON.stringify(generate.mock.calls.at(-1)![0].turns);
    expect(sentToModel).toContain("Where is my keyboard refund?");
    expect(sentToModel).toContain("[Records looked up earlier] getRefundStatus");
    expect(sentToModel).toContain("ORD-1002");
  });

  it("survives a server restart (reloaded from the JSON file)", async () => {
    generate.mockResolvedValueOnce(say("Hi Alice, how can I help?"));
    const first = await chat({ customerId: alice, message: "Hello there" });

    await store.initStore(); // re-reads the file from disk, like a restart

    generate.mockResolvedValueOnce(say("Sure."));
    await chat({ customerId: alice, conversationId: first.conversationId, message: "Are you still there?" });
    const turns = generate.mock.calls.at(-1)![0].turns;
    expect(turns.map((t) => t.kind === "user" || t.kind === "assistant" ? t.text : "")).toEqual([
      "Hello there",
      "Hi Alice, how can I help?",
      "Are you still there?",
    ]);
  });

  it("only replays a bounded number of recent turns, starting at a user message", async () => {
    generate.mockResolvedValue(say("ok"));
    const first = await chat({ customerId: alice, message: "message 0" });
    for (let i = 1; i <= 20; i++) await chat({ customerId: alice, conversationId: first.conversationId, message: `message ${i}` });

    const turns = generate.mock.calls.at(-1)![0].turns;
    expect(turns.length).toBeLessThanOrEqual(25);
    expect(turns[0]?.kind).toBe("user");
    expect(JSON.stringify(turns)).not.toContain('"message 0"');
    expect(JSON.stringify(turns)).toContain("message 20");
  });

  it("saves nothing when the model fails, so the message can simply be resent", async () => {
    generate.mockResolvedValueOnce(say("first answer"));
    const first = await chat({ customerId: alice, message: "first question" });

    generate.mockRejectedValueOnce(new Error("quota"));
    await expect(chat({ customerId: alice, conversationId: first.conversationId, message: "second question" })).rejects.toThrow("quota");

    const saved = await store.findConversation(first.conversationId);
    expect(saved?.turns.map((t) => (t.kind === "user" || t.kind === "assistant" ? t.text : ""))).toEqual(["first question", "first answer"]);
  });

  it("returns 'not found' for unknown conversation ids", async () => {
    await expect(chat({ customerId: alice, conversationId: "conv_nope", message: "hi" })).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
