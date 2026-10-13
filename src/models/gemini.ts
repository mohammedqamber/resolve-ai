import { ApiError, GoogleGenAI, type Content } from "@google/genai";
import { config } from "../utils/config.js";
import { ModelError, type ModelReply, type ToolDeclaration, type Turn } from "./types.js";

// Everything Gemini-specific lives in this file: client, message format, tool declarations, parsing, errors.
// To support another provider later, write a file with the same `generate` function.

const REQUEST_TIMEOUT_MS = 60_000; // Gemini latency is spiky (5s to 30s+ seen), so be generous

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (!config.geminiApiKey) {
    throw new ModelError("auth", "GEMINI_API_KEY is not set. Add it to your .env file.");
  }
  client ??= new GoogleGenAI({
    apiKey: config.geminiApiKey,
    httpOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  return client;
}

/** Translate our neutral transcript into Gemini "contents". Roles are "user" and "model". */
function toContents(turns: Turn[]): Content[] {
  return mergeSameRole(turns.map(toContent));
}

// Gemini expects roles to alternate, so neighbours with the same role become one message.
function mergeSameRole(contents: Content[]): Content[] {
  const merged: Content[] = [];
  for (const content of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === content.role) last.parts = [...(last.parts ?? []), ...(content.parts ?? [])];
    else merged.push({ ...content });
  }
  return merged;
}

function toContent(turn: Turn): Content {
  switch (turn.kind) {
    case "user":
      return { role: "user", parts: [{ text: turn.text }] };
    case "assistant":
      return { role: "model", parts: [{ text: turn.text }] };
    case "tool_context":
      return { role: "user", parts: [{ text: turn.text }] };
    case "tool_calls":
      // Replay Gemini's own message when we have it (keeps thought signatures intact).
      return (
        (turn.raw as Content | undefined) ?? {
          role: "model",
          parts: turn.calls.map((c) => ({ functionCall: { name: c.name, args: c.args as Record<string, unknown> } })),
        }
      );
    case "tool_results":
      // Tool results go back as a "user" message made of functionResponse parts.
      return {
        role: "user",
        parts: turn.results.map((r) => ({ functionResponse: { name: r.name, response: { output: r.result } } })),
      };
  }
}

/** One model call. Returns either the final text or the tools the model wants us to run. */
export async function generate(args: {
  systemPrompt: string;
  turns: Turn[];
  tools: ToolDeclaration[];
}): Promise<ModelReply> {
  const ai = getClient();

  let response;
  try {
    response = await ai.models.generateContent({
      model: config.geminiModel,
      contents: toContents(args.turns),
      config: {
        systemInstruction: args.systemPrompt,
        // No tools = a plain text answer (used for the small "did the customer confirm?" check).
        ...(args.tools.length > 0 ? { tools: [{ functionDeclarations: args.tools }] } : {}),
        // We run the tool loop ourselves (so we can validate, authorize and log each call).
        automaticFunctionCalling: { disable: true },
      },
    });
  } catch (err) {
    throw toModelError(err);
  }

  const calls = response.functionCalls;
  if (calls && calls.length > 0) {
    return {
      kind: "tool_calls",
      calls: calls.map((c) => ({ name: c.name ?? "", args: c.args ?? {} })),
      raw: response.candidates?.[0]?.content,
    };
  }

  const text = response.text?.trim();
  if (!text) throw new ModelError("empty", "The model returned an empty answer.");
  return { kind: "text", text };
}

/** Turn SDK/network errors into a few explicit kinds. Messages never contain the API key. */
function toModelError(err: unknown): ModelError {
  if (err instanceof ApiError) {
    if (err.status === 429) return new ModelError("quota", "The AI service is rate limited or out of quota. Try again later.");
    if (err.status === 401 || err.status === 403) return new ModelError("auth", "The AI service rejected the API key.");
    if (err.status === 408 || err.status === 504) return new ModelError("timeout", "The AI service took too long to answer.");
    return new ModelError("api", `The AI service returned an error (HTTP ${err.status}).`);
  }
  if (err instanceof Error && /abort|timeout|timed out/i.test(`${err.name} ${err.message}`)) {
    return new ModelError("timeout", "The AI service took too long to answer.");
  }
  return new ModelError("api", "Could not reach the AI service.");
}
