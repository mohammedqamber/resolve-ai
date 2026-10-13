// Shared by all tools.

/**
 * Who is asking. This comes from the SERVER-SIDE demo session, never from the model.
 * The model can only choose tool arguments (like an orderId); it can never choose the customer.
 */
export type ToolContext = {
  customerId: string;
  // Set only when the customer confirmed a pending action. Writes use it so a repeat can never create a duplicate.
  idempotencyKey?: string;
};

export type ToolErrorCode = "NOT_FOUND" | "WRITE_FAILED" | "DUPLICATE_TICKET";

/** Tools return a result object instead of throwing, so the model can read the outcome. */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ToolErrorCode; message: string };

export function success<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function failure(code: ToolErrorCode, message: string): ToolResult<never> {
  return { ok: false, code, message };
}
