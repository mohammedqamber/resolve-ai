import { randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { listCustomers } from "../data/store.js";
import { HttpError } from "./http.js";

// Demo "login". There are no passwords: a visitor picks one of the fictional demo profiles,
// and the SERVER issues a random session token for it. After that, who you are comes ONLY from
// the token. The request body and the AI model can never choose or change the customer.
//
// Sessions live in memory (single demo process): restarting the server signs everyone out.

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

type Session = { customerId: string; expiresAt: number };
const sessions = new Map<string, Session>();

/** "cus_alice" -> "alice". These short names are the selectable demo profiles. */
const profileOf = (customerId: string) => customerId.replace(/^cus_/, "");

export async function listProfiles() {
  const customers = await listCustomers();
  return customers.map((c) => ({ profile: profileOf(c.customerId), name: c.name })); // no emails or ids
}

/** Creates a session for a known demo profile, or returns undefined if the profile does not exist. */
export async function createSession(profile: string) {
  const customer = (await listCustomers()).find((c) => profileOf(c.customerId) === profile);
  if (!customer) return undefined;

  dropExpiredSessions();
  if (sessions.size >= MAX_SESSIONS) throw new HttpError(503, "TOO_MANY_SESSIONS", "The demo is busy. Please try again later.");

  const token = randomBytes(24).toString("hex");
  sessions.set(token, { customerId: customer.customerId, expiresAt: Date.now() + SESSION_TTL_MS });
  return { token, profile: profileOf(customer.customerId), name: customer.name };
}

function dropExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
}

/** The token from the "Authorization: Bearer <token>" header, if there is one. */
export function tokenFrom(req: Request): string | undefined {
  const match = /^Bearer ([a-f0-9]{48})$/.exec(req.header("authorization") ?? "");
  return match?.[1];
}

/** Express middleware: only requests with a valid session continue. Sets res.locals.customerId. */
export const requireSession: RequestHandler = (req, res, next) => {
  const token = tokenFrom(req);
  const session = token ? sessions.get(token) : undefined;
  if (!token || !session || session.expiresAt <= Date.now()) {
    throw new HttpError(401, "UNAUTHENTICATED", "Missing or expired session. Create one with POST /api/session.");
  }
  res.locals.customerId = session.customerId;
  next();
};

/** For route handlers after requireSession. */
export const customerIdOf = (res: { locals: Record<string, unknown> }) => res.locals.customerId as string;
