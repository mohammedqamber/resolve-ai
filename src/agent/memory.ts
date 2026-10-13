import { randomUUID } from "node:crypto";
import { findConversation, saveConversation, type Activity, type Conversation } from "../data/store.js";
import type { Turn } from "../models/types.js";

// Conversation memory = the saved list of turns (plus activities and pending action) in our own JSON store.
// Gemini never remembers anything between calls; every request we send the recent history again.
// The strategy is deliberately simple: keep the last N turns. No summaries, no vector memory.

const MAX_REPLAY_TURNS = 24; // how much history the model sees
const MAX_STORED_TURNS = 60;
const MAX_STORED_ACTIVITIES = 100;
const MAX_TOOL_NOTE_CHARS = 1500;

/** Same error for "does not exist" and "belongs to someone else", so ids can't be probed. */
export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found.");
  }
}

// ---------- one request at a time per conversation ----------

const queues = new Map<string, Promise<unknown>>();

async function withLock<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(conversationId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const tail = run.catch(() => {});
  queues.set(conversationId, tail);
  try {
    return await run;
  } finally {
    if (queues.get(conversationId) === tail) queues.delete(conversationId); // nobody queued behind us
  }
}

/**
 * Loads (or starts) a conversation for this customer and runs `work` on it, one request at a time.
 * Running requests one after another is what makes a double-submitted "yes" safe.
 */
export async function withConversation<T>(
  customerId: string,
  conversationId: string | undefined,
  work: (conversation: Conversation) => Promise<T>,
): Promise<T> {
  const id = conversationId ?? `conv_${randomUUID().slice(0, 8)}`;
  return withLock(id, async () => {
    const existing = await findConversation(id);
    if (conversationId && (!existing || existing.customerId !== customerId)) throw new ConversationNotFoundError();

    const now = new Date().toISOString();
    const conversation = existing ?? {
      conversationId: id,
      customerId,
      turns: [],
      activities: [],
      createdAt: now,
      updatedAt: now,
    };
    return work(conversation);
  });
}

/** Read-only lookup for the API: only the owner gets it. */
export async function getConversationForCustomer(customerId: string, conversationId: string): Promise<Conversation> {
  const conversation = await findConversation(conversationId);
  if (!conversation || conversation.customerId !== customerId) throw new ConversationNotFoundError();
  return conversation;
}

// ---------- bounded history ----------

/** Keep the last `max` turns, but always start on a "user" turn so the transcript stays well-formed. */
function trimTurns(turns: Turn[], max: number): Turn[] {
  const recent = turns.slice(-max);
  while (recent.length > 0 && recent[0]?.kind !== "user") recent.shift();
  return recent;
}

export function historyFor(conversation: Conversation): Turn[] {
  return trimTurns(conversation.turns, MAX_REPLAY_TURNS);
}

/**
 * Turns the raw transcript of one request into what we store.
 * Tool calls + results become one short text note: provider-owned details (like Gemini's hidden
 * thought signatures) are NOT saved, and the note is enough for "why is it still pending?".
 */
export function compactForStorage(turns: Turn[]): Turn[] {
  const stored: Turn[] = [];
  let pendingCalls: Extract<Turn, { kind: "tool_calls" }> | undefined;

  for (const turn of turns) {
    if (turn.kind === "tool_calls") {
      pendingCalls = turn;
    } else if (turn.kind === "tool_results" && pendingCalls) {
      const notes = turn.results.map((r, i) => {
        const args = JSON.stringify(pendingCalls?.calls[i]?.args ?? {});
        return `${r.name}(${args}) -> ${JSON.stringify(r.result).slice(0, MAX_TOOL_NOTE_CHARS)}`;
      });
      stored.push({ kind: "tool_context", text: `[Records looked up earlier] ${notes.join(" | ")}` });
      pendingCalls = undefined;
    } else if (turn.kind === "user" || turn.kind === "assistant" || turn.kind === "tool_context") {
      stored.push(turn);
    }
  }
  return stored;
}

/** Saves this request's new turns and activities. Throws if the write fails. */
export async function saveExchange(conversation: Conversation, newTurns: Turn[], activities: Activity[]): Promise<void> {
  conversation.turns = trimTurns([...conversation.turns, ...compactForStorage(newTurns)], MAX_STORED_TURNS);
  conversation.activities = [...conversation.activities, ...activities].slice(-MAX_STORED_ACTIVITIES);
  conversation.updatedAt = new Date().toISOString();
  await saveConversation(conversation);
}
