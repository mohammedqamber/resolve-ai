import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { ConversationNotFoundError } from "../agent/memory.js";
import { ModelError } from "../models/types.js";

// Small HTTP helpers: one JSON error shape for every failure, and a tiny rate limiter.
// Every error looks like: { "error": { "code": "SOME_CODE", "message": "Readable text" } }

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

/** Parse request data with a Zod schema, or throw a 400 that lists what was wrong. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
  throw new HttpError(400, "INVALID_REQUEST", problems.join("; "));
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  sendError(res, 404, "NOT_FOUND", "Route not found.");
};

/** The one place errors become HTTP responses. Messages are safe: no stack traces, no secrets. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
  if (err instanceof ConversationNotFoundError) return sendError(res, 404, "CONVERSATION_NOT_FOUND", err.message);

  if (err instanceof ModelError) {
    switch (err.kind) {
      case "quota":
        return sendError(res, 429, "AI_RATE_LIMITED", err.message);
      case "timeout":
        return sendError(res, 504, "AI_TIMEOUT", err.message);
      case "auth":
        // Do not tell the public whether the key is missing or wrong. Details stay in the server log.
        console.error("Gemini auth/config problem:", err.message);
        return sendError(res, 503, "AI_UNAVAILABLE", "The AI service is not available right now.");
      default:
        return sendError(res, 502, "AI_ERROR", "The AI service could not answer. Please try again.");
    }
  }

  // Errors raised by express.json(): bad JSON and too-large bodies.
  const bodyError = err as { type?: string };
  if (bodyError.type === "entity.parse.failed") return sendError(res, 400, "INVALID_JSON", "Request body is not valid JSON.");
  if (bodyError.type === "entity.too.large") return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  console.error("Unexpected error:", err);
  sendError(res, 500, "INTERNAL_ERROR", "Something went wrong. Nothing was saved from this request; you can try again.");
};

// ---------- rate limiting ----------

/**
 * Allows `max` requests per `windowMs` for each key (a session token or an IP address).
 * Kept in memory: fine for one demo process, not for several servers.
 */
export function rateLimit(options: { max: number; windowMs: number; key: (req: Request) => string }): RequestHandler {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (windows.size > 5000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k); // keep memory bounded

    const key = options.key(req);
    let entry = windows.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, entry);
    }
    entry.count++;

    if (entry.count > options.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return sendError(res, 429, "RATE_LIMITED", "Too many requests. Please slow down.");
    }
    next();
  };
}
