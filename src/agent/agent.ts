import { z } from "zod";
import { generate } from "../models/gemini.js";
import type { ToolDeclaration, Turn } from "../models/types.js";
import { completedActionNote, pendingActionNote, prepareTicketNudge, systemPrompt } from "../prompts/system.js";
import { tools } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import {
  awaitingAction,
  classifyReply,
  declineAction,
  executeConfirmedAction,
  expireStaleAction,
  proposeAction,
  publicPendingAction,
  replyOffersTicket,
  type PublicPendingAction,
} from "./actions.js";
import { runTool, type Activity, type WriteMode } from "./dispatch.js";
import { historyFor, saveExchange, withConversation } from "./memory.js";

export type { Activity };

const MAX_TOOL_ROUNDS = 5;
export const LIMIT_MESSAGE =
  "I wasn't able to finish investigating this in a safe number of steps. Please try rephrasing, or ask for a support ticket.";

// What the model sees about each tool, built from the registry. The Zod schema becomes JSON Schema.
const toolDeclarations: ToolDeclaration[] = tools.map((tool) => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
});

// ---------- the public entry point ----------

export type ChatResult = {
  conversationId: string;
  reply: string;
  activities: Activity[]; // only what happened during THIS request
  pendingAction?: PublicPendingAction;
};

/**
 * Handles one chat message for one customer.
 * `customerId` must come from the server-side demo session, never from the request body or the model.
 * Throws ConversationNotFoundError (unknown / not yours), or ModelError (Gemini failed).
 * On any error nothing from this message is saved, so the customer can simply resend it.
 */
export async function chat(args: { customerId: string; message: string; conversationId?: string }): Promise<ChatResult> {
  return withConversation(args.customerId, args.conversationId, async (conversation) => {
    const ctx: ToolContext = { customerId: conversation.customerId };
    const activities: Activity[] = [];
    let newTurns: Turn[] = [{ kind: "user", text: args.message }];
    let reply: string | undefined;

    // Is the customer answering a ticket proposal? Decide that BEFORE the model runs.
    expireStaleAction(conversation);
    const pending = awaitingAction(conversation);
    if (pending) {
      const decision = await classifyReply(pending, args.message);
      if (decision === "confirm") reply = await executeConfirmedAction(ctx, conversation, activities);
      else if (decision === "decline") reply = declineAction(conversation);
    }

    if (reply !== undefined) {
      newTurns.push({ kind: "assistant", text: reply });
    } else {
      const stillPending = awaitingAction(conversation);
      const done = conversation.pendingAction?.status === "completed" ? conversation.pendingAction.result : undefined;
      const run = await runAgent({
        ctx,
        message: args.message,
        history: historyFor(conversation),
        instructions: stillPending
          ? systemPrompt + pendingActionNote(stillPending.summary)
          : done
            ? systemPrompt + completedActionNote(done)
            : systemPrompt,
        alreadyPending: stillPending !== undefined,
        writeMode: { kind: "propose", propose: (tool, toolArgs) => proposeAction(ctx, conversation, tool, toolArgs) },
      });
      reply = run.reply;
      newTurns = run.turns;
      activities.push(...run.activities);
    }

    await saveExchange(conversation, newTurns, activities);
    const pendingAction = publicPendingAction(conversation);
    return { conversationId: conversation.conversationId, reply, activities, ...(pendingAction ? { pendingAction } : {}) };
  });
}

// ---------- the agent loop ----------

/**
 * The agent loop:
 *   ask model -> if it wants tools, run them and show it the results -> ask again -> ... -> final text.
 * The model chooses the tools. This code only validates, authorizes (via ctx), runs, and records.
 * Returns the turns of this request (user message ... final answer) so the caller can save them.
 */
export async function runAgent(args: {
  ctx: ToolContext; // who the customer is - comes from the server session, never from the model
  message: string;
  history: Turn[];
  instructions: string;
  alreadyPending: boolean; // a ticket is already waiting for confirmation, so no new one is needed
  writeMode: WriteMode;
}): Promise<{ reply: string; activities: Activity[]; turns: Turn[] }> {
  const turns: Turn[] = [...args.history, { kind: "user", text: args.message }];
  const activities: Activity[] = [];
  const finish = (reply: string) => {
    turns.push({ kind: "assistant", text: reply });
    return { reply, activities, turns: turns.slice(args.history.length) };
  };

  // Safety net: if the model OFFERS a ticket in words without preparing one, we ask it ONCE to prepare it,
  // so the customer only has to say "yes" one time. `nudge` is sent to the model but never saved or shown.
  let nudge: Turn[] = [];
  let nudged = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const reply = await generate({ systemPrompt: args.instructions, turns: [...turns, ...nudge], tools: toolDeclarations });
    nudge = [];

    if (reply.kind === "text") {
      const usedTools = activities.length > 0;
      const triedTicket = activities.some((a) => a.tool === "createSupportTicket");
      if (!nudged && !args.alreadyPending && usedTools && !triedTicket && (await replyOffersTicket(reply.text))) {
        nudged = true;
        nudge = [
          { kind: "assistant", text: reply.text },
          { kind: "user", text: prepareTicketNudge },
        ];
        round--; // the nudge does not use up one of the 5 tool rounds
        continue;
      }
      return finish(reply.text);
    }

    // Model wants tools, but we've already used all allowed rounds.
    if (round === MAX_TOOL_ROUNDS) return finish(LIMIT_MESSAGE);

    turns.push({ kind: "tool_calls", calls: reply.calls, raw: reply.raw });
    const results = [];
    for (const call of reply.calls) {
      const result = await runTool({ ctx: args.ctx, name: call.name, rawArgs: call.args, activities, writeMode: args.writeMode });
      results.push({ name: call.name, result });
    }
    turns.push({ kind: "tool_results", results });
  }

  return finish(LIMIT_MESSAGE); // not reachable, keeps TypeScript happy
}
