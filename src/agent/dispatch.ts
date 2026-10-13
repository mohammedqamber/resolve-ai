import type { Activity } from "../data/store.js";
import { findTool, type Tool } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

export type { Activity };

// A write tool called by the MODEL is only proposed. Only the confirmation step runs it for real.
export type WriteMode =
  | { kind: "propose"; propose: (tool: Tool, args: unknown) => Promise<unknown> }
  | { kind: "confirmed" };

/** Run one tool call safely. Always returns something the model can read, never throws. */
export async function runTool(args: {
  ctx: ToolContext;
  name: string;
  rawArgs: unknown;
  activities: Activity[];
  writeMode: WriteMode;
}): Promise<unknown> {
  const { ctx, name, rawArgs, activities, writeMode } = args;

  const activity: Activity = {
    tool: name,
    status: "started",
    startedAt: new Date().toISOString(),
    inputSummary: summarizeInput(rawArgs),
  };
  activities.push(activity);

  const finish = (status: Activity["status"], outputSummary: string, result: unknown) => {
    activity.status = status;
    activity.completedAt = new Date().toISOString();
    activity.outputSummary = outputSummary;
    return result;
  };
  const finishFromResult = (result: unknown, successSummary = "ok") => {
    const r = result as { ok?: boolean; code?: string };
    return r.ok === false ? finish("error", r.code ?? "failed", result) : finish("success", successSummary, result);
  };

  // 1. Whitelist: only registered tools can run.
  const tool = findTool(name);
  if (!tool) return finish("error", "unknown tool", { ok: false, code: "UNKNOWN_TOOL", message: `There is no tool named ${name}.` });

  // 2. Validate the arguments (the model's, or the saved ones when re-checking a confirmed action).
  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    return finish("error", "invalid arguments", {
      ok: false,
      code: "INVALID_ARGUMENTS",
      message: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    });
  }

  try {
    // 3. Writes requested by the model are turned into a pending action instead of being run.
    if (tool.action && writeMode.kind === "propose") {
      const proposal = await writeMode.propose(tool, parsed.data);
      return (proposal as { ok?: boolean }).ok === false
        ? finishFromResult(proposal)
        : finish("awaiting_confirmation", "waiting for customer confirmation", proposal);
    }

    // 4. Run it. Ownership checks happen inside the tool, using ctx (not model input).
    return finishFromResult(await tool.execute(ctx, parsed.data as never));
  } catch {
    return finish("error", "tool crashed", { ok: false, code: "TOOL_ERROR", message: "The tool failed unexpectedly." });
  }
}

// Short and safe for logs/UI: only the first few argument values, truncated.
function summarizeInput(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  return Object.entries(args)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
    .join(", ");
}
