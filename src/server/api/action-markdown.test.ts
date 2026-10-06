import type { ActionDefinition } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { renderActionMarkdown } from "./action-markdown.ts";

const action: ActionDefinition = {
  id: "github.delete_repository",
  service: "github",
  name: "delete_repository",
  description: "Delete a repository.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

describe("renderActionMarkdown", () => {
  it("renders the current execution policy decision and decisive rule", () => {
    const markdown = renderActionMarkdown(action, {
      policy: {
        allowed: false,
        code: "action_blocked",
        message: "Action is blocked.",
        checks: [{ source: "runtime", outcome: "block_match", rule: "github.delete_repository" }],
      },
    });

    expect(markdown).toContain("## Execution Policy");
    expect(markdown).toContain("Denied: Action is blocked.");
    expect(markdown).toContain("`runtime`: `block_match` via `github.delete_repository`");
  });

  it("shows nested shapes of object and array-of-object parameters", () => {
    const markdown = renderActionMarkdown({
      ...action,
      id: "example.create_quote",
      inputSchema: {
        type: "object",
        properties: {
          lineItems: {
            type: "array",
            description: "Line items.",
            items: {
              type: "object",
              properties: {
                description: { type: "string", description: "Line item description." },
                quantity: { type: "number" },
                accountCode: { type: "string", description: "Account code." },
              },
              required: ["description", "quantity"],
            },
          },
          address: {
            type: "object",
            description: "Postal address.",
            properties: { street: { type: "string" }, city: { type: "string" } },
          },
        },
        required: ["lineItems"],
      },
    });

    expect(markdown).toContain(
      "| `lineItems` | Yes      | `array<{ description*: string; quantity*: number; accountCode?: string }>` |",
    );
    expect(markdown).toContain("| `address`   | No       | `{ street?: string; city?: string }`");
    expect(markdown).toContain("- `lineItems[].description` (required): Line item description.");
    expect(markdown).toContain("- `lineItems[].quantity` (required)\n");
    expect(markdown).toContain("- `lineItems[].accountCode` (optional): Account code.");
    expect(markdown).toContain("- `address.street` (optional)");
  });
});
