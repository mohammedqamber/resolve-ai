import { Router } from "express";
import { z } from "zod";
import { publicPendingAction } from "../agent/actions.js";
import { chat } from "../agent/agent.js";
import { getConversationForCustomer } from "../agent/memory.js";
import { listTicketsForCustomer } from "../data/store.js";
import { parseOrThrow, rateLimit, HttpError } from "./http.js";
import { createSession, customerIdOf, listProfiles, requireSession, tokenFrom } from "./session.js";

export const MAX_MESSAGE_CHARS = 1000;

const sessionBody = z.object({ profile: z.string().trim().min(1).max(30) });

const chatBody = z.object({
  conversationId: z.string().regex(/^conv_[a-z0-9-]{1,40}$/, "must look like conv_xxxxxxxx").optional(),
  message: z.string().trim().min(1, "message is required").max(MAX_MESSAGE_CHARS, `message must be at most ${MAX_MESSAGE_CHARS} characters`),
});

const conversationParams = z.object({ id: z.string().regex(/^conv_[a-z0-9-]{1,40}$/, "invalid conversation id") });

export const apiRouter = Router();

// Limits (per demo process, in memory):
const sessionLimit = rateLimit({ max: 10, windowMs: 60_000, key: (req) => `ip:${req.ip}` });
const chatLimit = rateLimit({ max: 20, windowMs: 60_000, key: (req) => `session:${tokenFrom(req) ?? req.ip}` });

// ---------- demo identity ----------

// Which fictional customers can I pretend to be?
apiRouter.get("/profiles", async (_req, res) => {
  res.json({ profiles: await listProfiles() });
});

// Start a demo session. Returns a token to send as "Authorization: Bearer <token>".
apiRouter.post("/session", sessionLimit, async (req, res) => {
  const { profile } = parseOrThrow(sessionBody, req.body);
  const session = await createSession(profile);
  if (!session) throw new HttpError(400, "UNKNOWN_PROFILE", "Unknown demo profile. See GET /api/profiles.");
  res.status(201).json({ sessionToken: session.token, profile: session.profile, name: session.name });
});

// ---------- chat ----------

apiRouter.post("/chat", requireSession, chatLimit, async (req, res) => {
  const { message, conversationId } = parseOrThrow(chatBody, req.body);
  // customerId comes from the session, never from the body.
  const result = await chat({ customerId: customerIdOf(res), message, ...(conversationId ? { conversationId } : {}) });
  res.json(result);
});

// ---------- read-only views for the frontend ----------

apiRouter.get("/conversations/:id", requireSession, async (req, res) => {
  const { id } = parseOrThrow(conversationParams, req.params);
  const conversation = await getConversationForCustomer(customerIdOf(res), id);
  res.json({
    conversationId: conversation.conversationId,
    // Only what the customer said and what the assistant answered. Internal tool notes stay private.
    messages: conversation.turns.flatMap((t) => (t.kind === "user" || t.kind === "assistant" ? [{ role: t.kind, text: t.text }] : [])),
    activities: conversation.activities,
    ...optional("pendingAction", publicPendingAction(conversation)),
  });
});

apiRouter.get("/tickets", requireSession, async (_req, res) => {
  const tickets = await listTicketsForCustomer(customerIdOf(res));
  // Only this session's customer; internal fields (like the action id) are left out.
  res.json({
    tickets: tickets.map(({ ticketId, orderId, category, summary, evidence, status, createdAt }) => ({
      ticketId,
      orderId,
      category,
      summary,
      evidence,
      status,
      createdAt,
    })),
  });
});

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
