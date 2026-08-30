import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { AgentChatExtension } from "../chat/agent-chat-service.ts";

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
    {
      id: "work.update_item",
      service: "work",
      name: "update_item",
      description: "Update one work item.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
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
    const calls: ExtensionCall[] = [];
    const generator = createGenerator(calls);

    await expect(
      generator.generate({
        prompt: "Show Connect work by status",
        agentConnectionId: "claude-agent",
      }),
    ).resolves.toEqual(generatedBoard);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.request).toMatchObject({
      agentProvider: "claude_code",
      messages: [{ role: "user", content: expect.stringContaining("Show Connect work by status") }],
    });
    expect(calls[0]?.extension.connectorActionIds?.has("work.list_items")).toBe(true);
    expect(calls[0]?.extension.connectorActionIds?.has("work.update_item")).toBe(false);
    expect(calls[0]?.extension).toMatchObject({ connectorApprovalPolicy: "bypass", includeFlowTools: false });
    expect(JSON.stringify(calls[0]?.extension.context)).toContain('"id":"work.list_items"');
    expect(JSON.stringify(calls[0]?.extension.context)).toContain('"enum":["New","Done"]');
    expect(calls[0]?.extension.systemPrompt).toContain("$target.value");
    expect(calls[0]?.extension.systemPrompt).toContain("without braces");
  });

  it("requires a configured agent before attempting generation", async () => {
    const generator = createGenerator([], undefined);

    await expect(generator.generate({ prompt: "Show work", agentConnectionId: "missing-agent" })).rejects.toMatchObject(
      { code: "kanban_agent_not_found", status: 404 },
    );
  });
});

interface ExtensionCall {
  request: unknown;
  extension: AgentChatExtension;
}

function createGenerator(calls: ExtensionCall[], agentId: string | undefined = "claude-agent"): KanbanGenerator {
  return new KanbanGenerator({
    catalog: createCatalogStore([provider], { executableActionIds: ["work.list_items", "work.update_item"] }),
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
    },
    agentChat: {
      async respondWithExtension(request, extension) {
        calls.push({ request, extension });
        await extension.runTool("submit_kanban_definition", generatedBoard);
        return {
          status: "completed",
          message: {
            id: "message-1",
            role: "assistant",
            content: "Board definition ready.",
            createdAt: "2026-08-30T00:00:00.000Z",
          },
          toolActivity: [],
        };
      },
    },
  });
}
