// A tiny JSON-file "database".
//
// LEARNING/DEMO ONLY: it assumes ONE server process. Two processes writing the same file
// would overwrite each other. Real apps use a database (see README: PostgreSQL migration).
//
// Everything outside this file talks to the data through the small async functions below.
// To move to PostgreSQL later, you rewrite these functions and the tools stay the same.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Turn } from "../models/types.js";
import { config } from "../utils/config.js";

export type Customer = { customerId: string; name: string; email: string };

export type Order = {
  orderId: string;
  customerId: string;
  product: string;
  purchaseDate: string;
  deliveryStatus: string;
  returnStatus: string;
};

export type Refund = {
  refundId: string;
  orderId: string;
  amount: number;
  refundStatus: string;
  initiatedAt: string;
  relatedTransactionId: string;
};

export type Transaction = {
  transactionId: string;
  orderId: string;
  type: "charge" | "refund_transfer";
  amount: number;
  status: string;
  failureReason: string | null;
  createdAt: string;
};

export const ISSUE_CATEGORIES = ["refund_issue", "payment_issue", "delivery_issue", "other"] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export type Ticket = {
  ticketId: string;
  customerId: string;
  orderId: string;
  category: IssueCategory;
  summary: string;
  evidence: string[];
  status: "open";
  createdAt: string;
  sourceActionId?: string; // the confirmed pending action that created it (used for idempotency)
};

/**
 * One real tool execution, saved with the conversation. Frontend-ready.
 * "awaiting_confirmation" = the model PROPOSED a write and nothing was changed yet.
 * "success" = the tool really ran (for a write, only after the customer confirmed).
 */
export type Activity = {
  tool: string;
  status: "started" | "success" | "awaiting_confirmation" | "error";
  startedAt: string;
  completedAt?: string;
  inputSummary: string;
  outputSummary?: string;
};

/** A write the model proposed that is waiting for the customer's "yes". Kept separate from model text. */
export type PendingAction = {
  actionId: string;
  type: string; // e.g. "CREATE_SUPPORT_TICKET"
  tool: string;
  args: unknown;
  summary: string;
  status: "awaiting_confirmation" | "completed" | "cancelled";
  createdAt: string;
  result?: string; // set when completed: the backend's confirmation text (contains the real ticket ID)
};

export type Conversation = {
  conversationId: string;
  customerId: string; // the owner: only this demo customer may read or continue it
  turns: Turn[];
  activities: Activity[];
  pendingAction?: PendingAction;
  createdAt: string;
  updatedAt: string;
};

type Database = {
  customers: Customer[];
  orders: Order[];
  refunds: Refund[];
  transactions: Transaction[];
  tickets: Ticket[];
  conversations: Conversation[];
};

let db: Database | undefined;

function getDb(): Database {
  if (!db) throw new Error("Store not initialised: call initStore() first.");
  return db;
}

// ---------- loading and saving ----------

/** Load the runtime file. On first run it does not exist yet, so we copy the seed data. */
export async function initStore(): Promise<void> {
  try {
    db = JSON.parse(await fs.readFile(config.dataFile, "utf8")) as Database;
    db.conversations ??= []; // older runtime files were created before conversations existed
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    db = JSON.parse(await fs.readFile(config.seedFile, "utf8")) as Database;
    db.conversations ??= [];
    await saveToDisk();
  }
}

// Writes are chained one after another so two requests can never write the file at once.
let writeQueue: Promise<void> = Promise.resolve();

function saveToDisk(): Promise<void> {
  const job = writeQueue.then(writeFileAtomically);
  writeQueue = job.catch(() => {}); // a failed write must not block later writes
  return job; // callers still see the failure
}

// Write to a temp file, then rename: a crash mid-write cannot leave a half-written db file.
async function writeFileAtomically(): Promise<void> {
  const tmpFile = `${config.dataFile}.tmp`;
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  await fs.writeFile(tmpFile, JSON.stringify(getDb(), null, 2), "utf8");
  await fs.rename(tmpFile, config.dataFile);
}

// ---------- reads (async on purpose, so a real database can replace them) ----------

export async function findCustomer(customerId: string): Promise<Customer | undefined> {
  return getDb().customers.find((c) => c.customerId === customerId);
}

export async function listCustomers(): Promise<Customer[]> {
  return [...getDb().customers];
}

export async function findOrder(orderId: string): Promise<Order | undefined> {
  return getDb().orders.find((o) => o.orderId === orderId);
}

export async function listOrdersForCustomer(customerId: string): Promise<Order[]> {
  return getDb().orders.filter((o) => o.customerId === customerId);
}

export async function findRefundByOrder(orderId: string): Promise<Refund | undefined> {
  return getDb().refunds.find((r) => r.orderId === orderId);
}

export async function findTransaction(transactionId: string): Promise<Transaction | undefined> {
  return getDb().transactions.find((t) => t.transactionId === transactionId);
}

export async function findTransactionsByOrder(orderId: string): Promise<Transaction[]> {
  return getDb().transactions.filter((t) => t.orderId === orderId);
}

export async function listTicketsForCustomer(customerId: string): Promise<Ticket[]> {
  return getDb().tickets.filter((t) => t.customerId === customerId);
}

export async function findOpenTicket(
  customerId: string,
  orderId: string,
  category: IssueCategory,
): Promise<Ticket | undefined> {
  return getDb().tickets.find(
    (t) => t.status === "open" && t.customerId === customerId && t.orderId === orderId && t.category === category,
  );
}

/** Returns a COPY, like a real database would. Changes only count after saveConversation(). */
export async function findConversation(conversationId: string): Promise<Conversation | undefined> {
  const found = getDb().conversations.find((c) => c.conversationId === conversationId);
  return found && structuredClone(found);
}

// ---------- writes ----------

/** Insert or replace a conversation. Throws if the file could not be written (and undoes the change). */
export async function saveConversation(conversation: Conversation): Promise<void> {
  const database = getDb();
  const index = database.conversations.findIndex((c) => c.conversationId === conversation.conversationId);
  const previous = database.conversations[index];
  const copy = structuredClone(conversation);

  if (index >= 0) database.conversations[index] = copy;
  else database.conversations.push(copy);

  try {
    await saveToDisk();
  } catch (err) {
    if (index >= 0 && previous) database.conversations[index] = previous;
    else database.conversations = database.conversations.filter((c) => c.conversationId !== copy.conversationId);
    throw err;
  }
}

type NewTicket = Omit<Ticket, "ticketId" | "status" | "createdAt" | "sourceActionId">;

/**
 * Saves a ticket exactly once (idempotent).
 * If this action already made a ticket, or the customer already has an open ticket for the same
 * order + category, that ticket is returned instead and nothing new is written.
 * The check and the insert happen with no `await` in between, so two requests cannot both pass the check.
 * Throws if the file could not be written, so callers never report false success.
 */
export async function createTicketOnce(
  input: NewTicket,
  actionId?: string,
): Promise<{ ticket: Ticket; alreadyExisted: boolean }> {
  const database = getDb();

  const existing = database.tickets.find(
    (t) =>
      t.status === "open" &&
      ((actionId !== undefined && t.sourceActionId === actionId) ||
        (t.customerId === input.customerId && t.orderId === input.orderId && t.category === input.category)),
  );
  if (existing) return { ticket: existing, alreadyExisted: true };

  const lastNumber = Math.max(0, ...database.tickets.map((t) => Number(t.ticketId.replace("TCK-", "")) || 0));
  const ticket: Ticket = {
    ...input,
    ticketId: `TCK-${lastNumber + 1}`,
    status: "open",
    createdAt: new Date().toISOString(),
    ...(actionId ? { sourceActionId: actionId } : {}),
  };
  database.tickets.push(ticket);
  try {
    await saveToDisk();
  } catch (err) {
    database.tickets = database.tickets.filter((t) => t.ticketId !== ticket.ticketId); // undo
    throw err;
  }
  return { ticket, alreadyExisted: false };
}
