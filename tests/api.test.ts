import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelError, type ModelReply, type Turn } from "../src/models/types.js";

// Gemini is mocked: no API key, no network. We still test the REAL Express app over real HTTP.
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

const DATA_FILE = "data/vitest-api.runtime.json";
let server: Server;
let baseUrl: string;
const tokens: Record<string, string> = {};

const callTools = (...calls: { name: string; args: unknown }[]): ModelReply => ({ kind: "tool_calls", calls });
const say = (text: string): ModelReply => ({ kind: "text", text });

type Json = Record<string, any>;

async function api(method: string, path: string, options: { token?: string; body?: unknown; rawBody?: string } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(options.body !== undefined || options.rawBody !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.rawBody !== undefined ? { body: options.rawBody } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Json };
}

const chat = (token: string, message: string, conversationId?: string) =>
  api("POST", "/api/chat", { token, body: { message, ...(conversationId ? { conversationId } : {}) } });

beforeAll(async () => {
  vi.stubEnv("DATA_FILE", DATA_FILE);
  await rm(DATA_FILE, { force: true });
  const { initStore } = await import("../src/data/store.js");
  await initStore();
  const { createApp } = await import("../src/app.js");
  server = createApp().listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const profile of ["alice", "ben"]) {
    const session = await api("POST", "/api/session", { body: { profile } });
    tokens[profile] = session.json.sessionToken;
  }
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  generate.mockReset();
  offer.answer = "NO";
  offer.calls = 0;
});

describe("basics", () => {
  it("GET /health", async () => {
    expect(await api("GET", "/health")).toMatchObject({ status: 200, json: { status: "ok" } });
  });

  it("lists demo profiles without emails or customer ids", async () => {
    const res = await api("GET", "/api/profiles");
    expect(res.status).toBe(200);
    expect(res.json.profiles).toEqual([
      { profile: "alice", name: "Alice Demo" },
      { profile: "ben", name: "Ben Demo" },
      { profile: "chloe", name: "Chloe Demo" },
    ]);
    expect(JSON.stringify(res.json)).not.toContain("example.test");
  });

  it("returns JSON 404 for unknown routes", async () => {
    expect(await api("GET", "/nope")).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
});

describe("demo sessions", () => {
  it("rejects an unknown profile and an invalid body", async () => {
    expect(await api("POST", "/api/session", { body: { profile: "admin" } })).toMatchObject({
      status: 400,
      json: { error: { code: "UNKNOWN_PROFILE" } },
    });
    expect(await api("POST", "/api/session", { body: {} })).toMatchObject({ status: 400, json: { error: { code: "INVALID_REQUEST" } } });
  });

  it("does not accept a customer id as a profile (no ownership by guessing ids)", async () => {
    expect(await api("POST", "/api/session", { body: { profile: "cus_alice" } })).toMatchObject({ status: 400 });
  });

  it("requires a valid session on protected routes", async () => {
    const noToken = await chat("", "hi");
    expect(noToken).toMatchObject({ status: 401, json: { error: { code: "UNAUTHENTICATED" } } });
    expect((await chat("a".repeat(48), "hi")).status).toBe(401);
    expect((await api("GET", "/api/tickets")).status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  it("ignores a customerId sent in the body", async () => {
    generate.mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1001" } })).mockResolvedValueOnce(say("not found"));
    const res = await api("POST", "/api/chat", { token: tokens.ben!, body: { message: "show ORD-1001", customerId: "cus_alice" } });
    expect(res.status).toBe(200);
    expect(res.json.activities[0]).toMatchObject({ status: "error", outputSummary: "NOT_FOUND" }); // still Ben
  });
});

describe("request validation and limits", () => {
  it("rejects empty, missing and too-long messages", async () => {
    const alice = tokens.alice!;
    expect((await chat(alice, "   ")).json.error.code).toBe("INVALID_REQUEST");
    expect((await api("POST", "/api/chat", { token: alice, body: {} })).status).toBe(400);
    expect((await chat(alice, "x".repeat(1001))).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, oversized bodies and bad conversation ids", async () => {
    const alice = tokens.alice!;
    expect(await api("POST", "/api/chat", { token: alice, rawBody: "{not json" })).toMatchObject({ status: 400, json: { error: { code: "INVALID_JSON" } } });
    expect(await api("POST", "/api/chat", { token: alice, body: { message: "x".repeat(20_000) } })).toMatchObject({ status: 413 });
    expect((await chat(alice, "hi", "../../etc/passwd")).status).toBe(400);
  });

  it("rate limits one session without affecting another", async () => {
    // A separate session (Chloe) so the other tests keep their request budget.
    const chloe = (await api("POST", "/api/session", { body: { profile: "chloe" } })).json.sessionToken as string;
    generate.mockResolvedValue(say("ok"));
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await chat(chloe, "hello")).status);

    expect(statuses.filter((s) => s === 200)).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    const limited = await chat(chloe, "hello");
    expect(limited).toMatchObject({ status: 429, json: { error: { code: "RATE_LIMITED" } } });
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await chat(tokens.alice!, "hello")).status).toBe(200);
  });
});

describe("end-to-end acceptance over HTTP (Alice)", () => {
  let conversationId: string;

  it("investigates, shows real activity events, and asks for confirmation", async () => {
    const args = {
      orderId: "ORD-1001",
      issueCategory: "refund_issue",
      summary: "Refund transfer failed for the returned headphones.",
      evidence: ["TXN-9001 refund transfer failed: destination account closed"],
    };
    generate
      .mockResolvedValueOnce(callTools({ name: "getOrderDetails", args: { orderId: "ORD-1001" } }))
      .mockResolvedValueOnce(callTools({ name: "getRefundStatus", args: { orderId: "ORD-1001" } }))
      .mockResolvedValueOnce(callTools({ name: "getPaymentDetails", args: { orderId: "ORD-1001" } }))
      .mockResolvedValueOnce(callTools({ name: "createSupportTicket", args }))
      .mockResolvedValueOnce(say("Your refund transfer failed. Create a ticket?"));

    const res = await chat(tokens.alice!, "I returned my headphones but have not received my refund.");
    conversationId = res.json.conversationId;

    expect(res.status).toBe(200);
    expect(res.json.reply).toBe("Your refund transfer failed. Create a ticket?");
    expect(res.json.pendingAction).toMatchObject({ type: "CREATE_SUPPORT_TICKET", requiresConfirmation: true });
    expect(res.json.pendingAction.args).toBeUndefined();
    expect(res.json.activities.map((a: Json) => [a.tool, a.status])).toEqual([
      ["getOrderDetails", "success"],
      ["getRefundStatus", "success"],
      ["getPaymentDetails", "success"],
      ["createSupportTicket", "awaiting_confirmation"],
    ]);
    for (const a of res.json.activities) {
      expect(Date.parse(a.startedAt)).not.toBeNaN();
      expect(Date.parse(a.completedAt)).toBeGreaterThanOrEqual(Date.parse(a.startedAt));
      expect(a.inputSummary).toBeTypeOf("string");
      expect(a.outputSummary).toBeTypeOf("string");
    }
    expect((await api("GET", "/api/tickets", { token: tokens.alice! })).json.tickets).toHaveLength(0);
  });

  it("'Yes, please.' creates one ticket with a real ID; repeating it creates no second one", async () => {
    generate.mockResolvedValueOnce(say("CONFIRM"));
    const yes = await chat(tokens.alice!, "Yes, please.", conversationId);
    expect(yes.status).toBe(200);
    expect(yes.json.pendingAction).toBeUndefined();

    const { tickets } = (await api("GET", "/api/tickets", { token: tokens.alice! })).json;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ orderId: "ORD-1001", category: "refund_issue", status: "open" });
    expect(tickets[0]).not.toHaveProperty("customerId");
    expect(yes.json.reply).toContain(tickets[0].ticketId);

    generate.mockResolvedValueOnce(say("Your ticket already exists."));
    await chat(tokens.alice!, "Yes, please.", conversationId);
    expect((await api("GET", "/api/tickets", { token: tokens.alice! })).json.tickets).toHaveLength(1);
  });

  it("GET /api/conversations/:id shows messages and activity history to the owner only", async () => {
    const mine = await api("GET", `/api/conversations/${conversationId}`, { token: tokens.alice! });
    expect(mine.status).toBe(200);
    expect(mine.json.messages[0]).toEqual({ role: "user", text: "I returned my headphones but have not received my refund." });
    expect(mine.json.messages.every((m: Json) => m.role === "user" || m.role === "assistant")).toBe(true);
    expect(mine.json.activities.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(mine.json)).not.toContain("Records looked up earlier");

    const theirs = await api("GET", `/api/conversations/${conversationId}`, { token: tokens.ben! });
    expect(theirs).toMatchObject({ status: 404, json: { error: { code: "CONVERSATION_NOT_FOUND" } } });
    const missing = await api("GET", "/api/conversations/conv_doesnotexist", { token: tokens.alice! });
    expect(missing.json).toEqual(theirs.json); // same answer: ids cannot be probed
  });

  it("other customers cannot continue the conversation or see the ticket", async () => {
    const hijack = await chat(tokens.ben!, "Yes, please.", conversationId);
    expect(hijack.status).toBe(404);
    expect((await api("GET", "/api/tickets", { token: tokens.ben! })).json.tickets).toHaveLength(0);
  });
});

describe("AI failures become clear HTTP errors", () => {
  it.each([
    ["quota", 429, "AI_RATE_LIMITED"],
    ["timeout", 504, "AI_TIMEOUT"],
    ["api", 502, "AI_ERROR"],
    ["auth", 503, "AI_UNAVAILABLE"],
  ] as const)("model error '%s' -> %i", async (kind, status, code) => {
    generate.mockRejectedValueOnce(new ModelError(kind, "details that must not leak: key=abc"));
    const res = await api("POST", "/api/chat", { token: tokens.alice!, body: { message: "hello" } });
    expect(res).toMatchObject({ status, json: { error: { code } } });
    if (kind === "auth") expect(JSON.stringify(res.json)).not.toContain("key=abc");
  });

  it("unexpected errors return a generic 500 without internals", async () => {
    generate.mockRejectedValueOnce(new Error("secret stack detail"));
    const res = await api("POST", "/api/chat", { token: tokens.alice!, body: { message: "hello" } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toContain("secret stack detail");
  });
});
