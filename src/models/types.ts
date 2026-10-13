// Provider-neutral conversation types. The agent loop speaks ONLY these types;
// models/gemini.ts is the one place that translates them to Gemini's format.

/** A tool the model asked us to run. */
export type ToolCall = { name: string; args: unknown };

/** One entry of the transcript we send to the model each time we call it. */
export type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  // Compact notes about tool lookups from EARLIER requests, saved in memory so "why is it still pending?" has context.
  | { kind: "tool_context"; text: string }
  // The model asked for tools. `raw` is the provider's original message, replayed untouched
  // on the next call (Gemini 3 needs its "thought signatures" sent back exactly as received).
  | { kind: "tool_calls"; calls: ToolCall[]; raw?: unknown }
  // Our answer: one result per call, in the same order as the calls.
  | { kind: "tool_results"; results: { name: string; result: unknown }[] };

/** What the model gave back: either the final text, or a request to run tools. */
export type ModelReply =
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; calls: ToolCall[]; raw?: unknown };

/** What the model is allowed to know about a tool. */
export type ToolDeclaration = {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
};

export type ModelErrorKind = "quota" | "timeout" | "auth" | "api" | "empty";

export class ModelError extends Error {
  constructor(
    public kind: ModelErrorKind,
    message: string,
  ) {
    super(message);
  }
}
