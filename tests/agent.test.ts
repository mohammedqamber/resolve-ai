import { rm } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelReply, Turn } from "../src/models/types.js";

// Gemini is mocked: no API key, no network. Each test scripts what the "model" says.
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

const DATA_FILE = "data/vitest-agent.runtime.json";
const alice = "cus_alice";
const ben = "cus_ben";

let chat: typeof import("../src/agent/agent.js").chat;
let LIMIT_MESSAGE: string;
let listTicketsForCustomer: typeof import("../src/data/store.js").listTicketsForCustomer;

const callTools = (...calls: { name: string; args: unknown }[]): ModelReply => ({ kind: "tool_calls", calls });
const say = (text: string): ModelReply => ({ kind: "text", text });

beforeAll(async () => {
  vi.stubEnv("DATA_FILE", DATA_FILE);
  await rm(DATA_FILE, { force: true });
  const store = await import("../src/data/store.js");
  await store.initStore();
  listTicketsForCustomer = store.listTicketsForCustomer;
  ({ chat, LIMIT_MESSAGE } = await import("../src/agent/agent.js"));
});

beforeEach(() => {
  generate.mockReset();
  offer.answer = "NO";
  offer.calls = 0;
});

describe("agent loop", () => {
  it("returns plain text when the model asks for no tools", async () => {
    generate.mockResolvedValueOnce(say("Hello!"));
    const result = await chat({ customerId: alice, message: "hi" });
    expect(result).toMatchObject({ reply: "Hello!", activities: [] });
    expect(result.conversationId).toMatch(/^conv_/);
    expect(result.pendingAction).toBeUndefined();
  });

  it("sends all four tool declarations built from the registry", async () => {
    generate.mockResolvedValueOnce(say("hi"));
    await chat({ customerId: alice, message: "hi" });
    const declared = generate.mock.calls[0]![0].tools as { name: string }[];
    expect(declared.map((t) => t.name)).toEqual(["getOrderDetails", "getRefundStatus", "getPaymentDetails", "createSupportTicket"]);
  });

  it("runs the tool the model asks for and feeds the real result back", async () => {
    generate
      .mockResolvedValueOnce(callTools({ name: "getRefundStatus", args: { orderId: "ORD-1001" } }))
      .mockResolvedValueOnce(say("Your refund failed."));

    const result = await chat({ customerId: alice, message: "where is my refund?" });

    expect(result.reply).toBe("Your refund failed.");
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({ tool: "getRefundStatus", status: "success", inputSummary: "orderId=ORD-1001" });
    expect(result.activities[0]?.completedAt).toBeDefined();

    const secondCallTurns = generate.mock.calls[1]![0].turns;
    const results = secondCallTurns.find((t) => t.kind === "tool_results");
    expect(results).toMatchObject({ results: [{ name: "getRefundStatus", result: { ok: true, data: { orderId: "ORD-1001" } } }] });
  });

  it("supports sequential tool calls chosen by the model", async () => {
    generate
      .mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1001" } }))
      .mockResolvedValueOnce(callTools({ name: "getPaymentDetails", args: { orderId: "ORD-1001" } }))
      .mockResolvedValueOnce(say("done"));
    const result = await chat({ customerId: alice, message: "check my order" });
    expect(result.activities.map((a) => a.tool)).toEqual(["getOrderDetails", "getPaymentDetails"]);
  });

  it("hides another customer's order (ownership uses the session, not the model)", async () => {
    generate
      .mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1001" } }))
      .mockResolvedValueOnce(say("not found"));
    const result = await chat({ customerId: ben, message: "show ORD-1001" });

    expect(result.activities[0]).toMatchObject({ status: "error", outputSummary: "NOT_FOUND" });
    const toolResult = generate.mock.calls[1]![0].turns.find((t) => t.kind === "tool_results");
    expect(JSON.stringify(toolResult)).not.toContain("cus_alice");
  });

  it("rejects unknown tools without running anything", async () => {
    generate.mockResolvedValueOnce(callTools({ name: "deleteEverything", args: {} })).mockResolvedValueOnce(say("ok"));
    const result = await chat({ customerId: alice, message: "x" });
    expect(result.activities[0]).toMatchObject({ tool: "deleteEverything", status: "error", outputSummary: "unknown tool" });
  });

  it("rejects malformed arguments", async () => {
    generate.mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: 42 } })).mockResolvedValueOnce(say("ok"));
    const result = await chat({ customerId: alice, message: "x" });
    expect(result.activities[0]).toMatchObject({ status: "error", outputSummary: "invalid arguments" });
  });

  it("stops after 5 tool rounds with a safe message", async () => {
    generate.mockResolvedValue(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1001" } }));
    const result = await chat({ customerId: alice, message: "loop forever" });
    expect(result.reply).toBe(LIMIT_MESSAGE);
    expect(result.activities).toHaveLength(5);
    expect(generate).toHaveBeenCalledTimes(6);
  });

  it("lets model errors (quota, timeout...) reach the caller", async () => {
    generate.mockRejectedValueOnce(new Error("quota"));
    await expect(chat({ customerId: alice, message: "x" })).rejects.toThrow("quota");
  });

  it("only PROPOSES a ticket when the model calls createSupportTicket", async () => {
    const before = (await listTicketsForCustomer(alice)).length;
    generate
      .mockResolvedValueOnce(
        callTools({
          name: "createSupportTicket",
          args: { orderId: "ORD-1002", issueCategory: "refund_issue", summary: "Refund is taking too long", evidence: ["pending"] },
        }),
      )
      .mockResolvedValueOnce(say("Shall I create a ticket?"));
    const result = await chat({ customerId: alice, message: "open a ticket" });

    expect(result.activities[0]).toMatchObject({ status: "awaiting_confirmation", outputSummary: "waiting for customer confirmation" });
    expect(result.pendingAction).toMatchObject({ type: "CREATE_SUPPORT_TICKET", requiresConfirmation: true });
    expect(result.pendingAction).not.toHaveProperty("args");
    expect(await listTicketsForCustomer(alice)).toHaveLength(before);
  });
});
