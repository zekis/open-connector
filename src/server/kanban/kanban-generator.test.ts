import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { ClaudeCodeTurnInput } from "../agents/claude-code-client.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { KanbanGenerator } from "./kanban-generator.ts";

const provider: ProviderDefinition = {
  service: "work",
  displayName: "Work",
  categories: ["Project Management"],
  authTypes: ["api_key"],
  auth: [{ type: "api_key" }],
  actions: [
    {
      id: "work.list_items",
      service: "work",
      name: "list_items",
      description: "List work items.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object", properties: { project: { type: "string" } } },
      outputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                status: { type: "string", enum: ["New", "Done"] },
              },
            },
          },
        },
      },
    },
  ],
};

const connection: ConnectionSummary = {
  id: "work-connection",
  service: "work",
  connectionName: "default",
  authType: "api_key",
  configured: true,
  virtual: false,
  default: true,
  profile: { accountId: "work", displayName: "Work account", grantedScopes: [] },
};

const generatedBoard = {
  name: "Delivery",
  cardLimit: 50,
  columns: [
    { id: "new", label: "New", value: "New" },
    { id: "done", label: "Done", value: "Done" },
  ],
  sources: [
    {
      id: "work-items",
      name: "Work items",
      connectionId: connection.id,
      actionId: "work.list_items",
      input: { project: "Connect" },
      itemsPath: "$.items[*]",
      mapping: { id: "$.id", title: "$.title", column: "$.status" },
    },
  ],
};

describe("KanbanGenerator", () => {
  it("gives the configured agent connected action schemas and returns its board definition", async () => {
    const calls: ClaudeCodeTurnInput[] = [];
    const generator = createGenerator(calls);

    await expect(
      generator.generate({
        prompt: "Show Connect work by status",
        agentConnectionId: "claude-agent",
      }),
    ).resolves.toEqual(generatedBoard);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ oauthToken: "oauth-token", model: "opus", effort: "medium" });
    expect(calls[0]?.prompt).toContain("Show Connect work by status");
    expect(calls[0]?.prompt).toContain('"id":"work.list_items"');
    expect(calls[0]?.prompt).toContain('"enum":["New","Done"]');
    expect(calls[0]?.prompt).not.toContain("oauth-token");
  });

  it("requires a configured agent before attempting generation", async () => {
    const generator = createGenerator([], undefined);

    await expect(generator.generate({ prompt: "Show work", agentConnectionId: "missing-agent" })).rejects.toMatchObject(
      { code: "kanban_agent_not_found", status: 404 },
    );
  });
});

function createGenerator(calls: ClaudeCodeTurnInput[], agentId: string | undefined = "claude-agent"): KanbanGenerator {
  return new KanbanGenerator({
    catalog: createCatalogStore([provider], { executableActionIds: ["work.list_items"] }),
    connections: {
      async listConnections() {
        return [connection];
      },
    },
    agents: {
      async getSummaryById(id) {
        return id === agentId
          ? {
              id,
              provider: "claude_code" as const,
              authType: "subscription_oauth" as const,
              configured: true as const,
              displayName: "Claude subscription",
            }
          : undefined;
      },
      async getClaudeOAuthToken() {
        return "oauth-token";
      },
      async assertCodexConnection() {},
    },
    agentSettings: {
      async get(providerName) {
        return { provider: providerName, model: "opus" };
      },
    },
    claudeCode: {
      async completeTurn(input) {
        calls.push(input);
        return { structuredOutput: generatedBoard };
      },
    },
    codex: {
      async completeTurn() {
        throw new Error("Unexpected Codex call");
      },
    },
  });
}
