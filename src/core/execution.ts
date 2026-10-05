import type { ActionDefinition, ActionExecutor, ExecutionContext, ExecutionResult } from "./types.ts";

import { describeActionInputErrors, validateActionInput } from "./validation.ts";

/**
 * Validate input and run a local executor for an action.
 *
 * When `executor` is undefined, the action is treated as catalog-only and a
 * stable `executor_unavailable` error is returned.
 */
export async function executeAction(
  action: ActionDefinition,
  executor: ActionExecutor | undefined,
  input: unknown,
  context: ExecutionContext,
): Promise<ExecutionResult> {
  if (!executor) {
    return {
      ok: false,
      error: {
        code: "executor_unavailable",
        message: "Execution for this action is not available in the local runtime yet.",
      },
    };
  }

  const validation = validateActionInput(action, input);
  if (!validation.valid) {
    const named = describeActionInputErrors(action.inputSchema, validation.errors);
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: named
          ? `Action input does not match the action schema: ${named}`
          : "Action input does not match the action schema.",
        details: validation.errors,
      },
    };
  }

  return executor(input, context);
}
