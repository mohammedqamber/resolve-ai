import { randomUUID } from "node:crypto";
import type { Activity, Conversation, PendingAction } from "../data/store.js";
import { generate } from "../models/gemini.js";
import { confirmationCheckPrompt, offerCheckPrompt } from "../prompts/system.js";
import type { Tool } from "../tools/registry.js";
import { findTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { runTool } from "./dispatch.js";

// Pending actions: how a write (like creating a ticket) is made safe.
//   1. PROPOSE  - the model asks for the write; we only save a pending action on the conversation.
//   2. CONFIRM  - the customer's NEXT message must say yes, and it is checked against THAT action.
//   3. EXECUTE  - the backend (not the model) re-validates and runs the write, once.

const PENDING_TTL_MS = 30 * 60 * 1000; // a forgotten proposal expires

export type PublicPendingAction = { type: string; actionId: string; requiresConfirmation: true; summary: string };

export function awaitingAction(conversation: Conversation): PendingAction | undefined {
  const pending = conversation.pendingAction;
  return pending?.status === "awaiting_confirmation" ? pending : undefined;
}

/** Only safe metadata leaves the backend: never the saved arguments. */
export function publicPendingAction(conversation: Conversation): PublicPendingAction | undefined {
  const pending = awaitingAction(conversation);
  return pending && { type: pending.type, actionId: pending.actionId, requiresConfirmation: true, summary: pending.summary };
}

export function expireStaleAction(conversation: Conversation): void {
  const pending = awaitingAction(conversation);
  if (pending && Date.now() - Date.parse(pending.createdAt) > PENDING_TTL_MS) pending.status = "cancelled";
}

// ---------- 1. propose ----------

/** Called when the model uses a write tool. Nothing is written; the tool result tells the model so. */
export async function proposeAction(ctx: ToolContext, conversation: Conversation, tool: Tool, args: unknown): Promise<unknown> {
  if (!tool.action) throw new Error(`${tool.name} is not an action tool`);

  const check = await tool.action.precheck(ctx, args as never);
  if (!check.ok) return check;

  conversation.pendingAction = {
    actionId: `act_${randomUUID().slice(0, 8)}`,
    type: tool.action.type,
    tool: tool.name,
    args,
    summary: check.data.summary,
    status: "awaiting_confirmation",
    createdAt: new Date().toISOString(),
  };
  return {
    ok: true,
    data: {
      status: "AWAITING_CONFIRMATION",
      message: `NOT created yet. Ask the customer to confirm: ${check.data.summary}`,
    },
  };
}

// ---------- 2. confirm ----------

export type Decision = "confirm" | "decline" | "other";

/**
 * Decides whether the customer's message confirms the pending action.
 * This small model call sees ONLY the pending summary and the message (no tool results, no history),
 * can only answer one word, and anything unexpected counts as "other" - which means no write.
 */
export async function classifyReply(pending: PendingAction, message: string): Promise<Decision> {
  const reply = await generate({
    systemPrompt: confirmationCheckPrompt,
    turns: [{ kind: "user", text: `Pending action: ${pending.summary}\n\nCustomer message: ${JSON.stringify(message)}` }],
    tools: [],
  });
  const word = reply.kind === "text" ? reply.text.trim().toUpperCase().replace(/[^A-Z]/g, "") : "";
  return word === "CONFIRM" ? "confirm" : word === "DECLINE" ? "decline" : "other";
}

/**
 * Does this reply offer a ticket in words? Used once, after an investigation, to catch the case where
 * the model offered a ticket but never prepared one (the customer's "yes" would then have nothing to confirm).
 * Same safety style as classifyReply: tiny prompt, one word back, anything unexpected means NO.
 */
export async function replyOffersTicket(replyText: string): Promise<boolean> {
  const reply = await generate({
    systemPrompt: offerCheckPrompt,
    turns: [{ kind: "user", text: JSON.stringify(replyText) }],
    tools: [],
  });
  return reply.kind === "text" && reply.text.trim().toUpperCase().replace(/[^A-Z]/g, "") === "YES";
}

export function declineAction(conversation: Conversation): string {
  if (conversation.pendingAction) conversation.pendingAction.status = "cancelled";
  return "No problem. I have not created anything. Let me know if you need anything else.";
}

// ---------- 3. execute ----------

/**
 * Runs the confirmed action. The reply comes from the backend result, so it can only claim
 * success (and quote a real ticket ID) when the write really succeeded.
 */
export async function executeConfirmedAction(ctx: ToolContext, conversation: Conversation, activities: Activity[]): Promise<string> {
  const pending = awaitingAction(conversation);
  const tool = pending && findTool(pending.tool);
  if (!pending || !tool?.action) return "I could not find anything waiting for confirmation.";

  // runTool re-validates the saved arguments; the tool re-checks ownership; the idempotency key stops duplicates.
  const result = (await runTool({
    ctx: { ...ctx, idempotencyKey: pending.actionId },
    name: pending.tool,
    rawArgs: pending.args,
    activities,
    writeMode: { kind: "confirmed" },
  })) as { ok: boolean; code?: string; message?: string; data?: unknown };

  if (result.ok) {
    pending.status = "completed";
    pending.result = tool.action.successMessage(result.data as never);
    return pending.result;
  }
  if (result.code === "WRITE_FAILED") {
    // Not retried automatically. The action stays pending so the customer can choose to try again.
    return `Sorry, I could not save that. Nothing was created. Say yes if you would like me to try again.`;
  }
  pending.status = "cancelled";
  return `Sorry, I could not complete that: ${result.message ?? "the request is no longer valid."} Nothing was created.`;
}
