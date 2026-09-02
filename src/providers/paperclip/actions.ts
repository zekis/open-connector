import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { paperclipOperations } from "./operations.ts";

const service = "paperclip";

export const paperclipActions: ProviderActionDefinition[] = [
  ...paperclipOperations.map((operation) =>
    defineProviderAction(service, {
      name: operation.name,
      description: operation.description,
      inputSchema: operation.inputSchema,
      outputSchema: operation.outputSchema,
    }),
  ),
  defineProviderAction(service, {
    name: "api_request",
    description:
      "Call another endpoint on the connected Paperclip instance as the signed-in board user. Use a typed Paperclip action when one exists.",
    inputSchema: s.actionInput(
      {
        method: s.stringEnum("The HTTP method.", ["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: s.string({
          description:
            "A relative Paperclip API path beginning with /api/. URLs, fragments, and path traversal are rejected.",
          minLength: 5,
          pattern: "^/api(?:/|$)",
        }),
        query: s.record("Optional query parameters.", s.unknown("One query parameter value.")),
        body: s.unknown("An optional JSON request body."),
      },
      ["method", "path"],
    ),
    outputSchema: s.actionOutput({
      status: s.integer("The Paperclip HTTP response status."),
      data: s.unknown("The parsed Paperclip response body, plain text, or null for an empty response."),
    }),
  }),
];
