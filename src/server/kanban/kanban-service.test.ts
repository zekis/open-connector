import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { RunActionInput } from "../actions/action-runner.ts";
import type { IKanbanStore, KanbanBoardDefinition, KanbanBoardDefinitionInput } from "./kanban-types.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ActionPolicyService } from "../../core/action-policy.ts";
import { KanbanService } from "./kanban-service.ts";

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
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 500 } },
      },
      outputSchema: { type: "object" },
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
  profile: { accountId: "work-account", displayName: "Work account", grantedScopes: [] },
};

const definition: KanbanBoardDefinitionInput = {
  name: "Delivery",
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
      itemsPath: "$.workItems[*]",
      mapping: {
        id: "$.id",
        title: '$.fields["System.Title"]',
        column: '$.fields["System.State"]',
        priority: '$.fields["Microsoft.VSTS.Common.Priority"]',
        revision: "$.rev",
      },
      writeBack: {
        actionId: "work.update_item",
        inputTemplate: {
          id: "$card.id",
          project: "$source.input.project",
          revision: "$raw.rev",
          fields: { "System.State": "$target.value" },
        },
      },
    },
  ],
};

describe("KanbanService", () => {
  it("validates agent-generated definitions before returning them to the editor", async () => {
    const harness = createHarness({
      async generate() {
        return definition;
      },
    });

    await expect(
      harness.service.generate({ prompt: "Show delivery work", agentConnectionId: "agent-1" }),
    ).resolves.toMatchObject(definition);
  });

  it("persists a board and deterministically projects connector JSON", async () => {
    const harness = createHarness();
    const board = await harness.service.create(definition);

    const snapshot = await harness.service.refresh(board.id);

    expect(await harness.service.list()).toEqual([
      expect.objectContaining({ id: board.id, name: "Delivery", editableSourceCount: 1 }),
    ]);
    expect(snapshot.cards).toEqual([
      expect.objectContaining({
        key: "work-items:42",
        title: "Production release",
        columnId: "new",
        priority: 1,
        revision: 7,
        editable: true,
      }),
    ]);
    expect(snapshot.sources).toEqual([
      expect.objectContaining({ sourceId: "work-items", status: "completed", itemCount: 1 }),
    ]);
  });

  it("combines multiple connector sources without merging cards that share provider IDs", async () => {
    const harness = createHarness();
    const multipleSources = structuredClone(definition);
    multipleSources.sources.push({
      ...structuredClone(definition.sources[0]!),
      id: "support-items",
      name: "Support items",
      writeBack: undefined,
    });
    const board = await harness.service.create(multipleSources);

    const snapshot = await harness.service.refresh(board.id);

    expect(snapshot.cards.map((card) => card.key)).toEqual(["work-items:42", "support-items:42"]);
    expect(snapshot.cards.map((card) => card.editable)).toEqual([true, false]);
    expect(snapshot.sources).toHaveLength(2);
  });

  it("rejects malformed mapping and write-back paths when a board is saved", async () => {
    const harness = createHarness();
    const malformedMapping = structuredClone(definition);
    malformedMapping.sources[0]!.mapping.title = "$..title";
    await expect(harness.service.create(malformedMapping)).rejects.toMatchObject({ code: "invalid_kanban_path" });

    const malformedTemplate = structuredClone(definition);
    malformedTemplate.sources[0]!.writeBack!.inputTemplate.id = "$raw[?(@.id)]";
    await expect(harness.service.create(malformedTemplate)).rejects.toMatchObject({ code: "invalid_kanban_path" });

    const handlebarsTemplate = structuredClone(definition);
    handlebarsTemplate.sources[0]!.writeBack!.inputTemplate.id = "{{$card.id}}";
    await expect(harness.service.create(handlebarsTemplate)).rejects.toMatchObject({
      code: "invalid_kanban_template",
    });

    const invalidSourceInput = structuredClone(definition);
    invalidSourceInput.sources[0]!.input = { limit: 0 };
    await expect(harness.service.create(invalidSourceInput)).rejects.toMatchObject({
      code: "invalid_kanban_source_input",
    });
  });

  it("rejects duplicate raw column values that would make refreshes ambiguous", async () => {
    const harness = createHarness();
    const ambiguous = structuredClone(definition);
    ambiguous.columns[1]!.value = "New";

    await expect(harness.service.create(ambiguous)).rejects.toMatchObject({ code: "invalid_kanban" });
  });

  it("rejects board limits that could load hundreds of connector objects", async () => {
    const harness = createHarness();
    const excessive = structuredClone(definition);
    excessive.cardLimit = 101;

    await expect(harness.service.create(excessive)).rejects.toMatchObject({ code: "invalid_kanban" });
  });

  it("turns a card move into a schema-owned provider action and refreshes canonical data", async () => {
    const harness = createHarness();
    const board = await harness.service.create(definition);
    await harness.service.refresh(board.id);

    const result = await harness.service.moveCard(board.id, "work-items:42", "done");

    expect(result.status).toBe("completed");
    expect(harness.actions.inputs.find((input) => input.actionId === "work.update_item")?.input).toEqual({
      id: "42",
      project: "Connect",
      revision: 7,
      fields: { "System.State": "Done" },
    });
    expect(result.snapshot.cards[0]).toMatchObject({ columnId: "done" });
  });

  it("does not call a provider when a card is moved to its current column", async () => {
    const harness = createHarness();
    const board = await harness.service.create(definition);
    await harness.service.refresh(board.id);

    const result = await harness.service.moveCard(board.id, "work-items:42", "new");

    expect(result.status).toBe("completed");
    expect(harness.actions.inputs.filter((input) => input.actionId === "work.update_item")).toEqual([]);
  });

  it("caps provider reads and rendered cards to the board budget", async () => {
    const harness = createHarness();
    harness.actions.listSize = 5;
    const limited = structuredClone(definition);
    limited.cardLimit = 2;
    limited.sources[0]!.input.limit = 500;
    const board = await harness.service.create(limited);

    const snapshot = await harness.service.refresh(board.id);

    expect(snapshot.cards).toHaveLength(2);
    expect(snapshot.sources[0]).toMatchObject({ itemCount: 2, limited: true });
    expect(harness.actions.inputs.find((input) => input.actionId === "work.list_items")?.input).toMatchObject({
      limit: 2,
    });
  });

  it("keeps an approval-gated move visibly pending without changing provider state", async () => {
    const harness = createHarness();
    harness.actions.requireApproval = true;
    const board = await harness.service.create(definition);
    await harness.service.refresh(board.id);

    const result = await harness.service.moveCard(board.id, "work-items:42", "done");

    expect(result).toMatchObject({
      status: "waiting_for_approval",
      approvalId: "approval-1",
      snapshot: {
        cards: [
          {
            columnId: "new",
            pending: { columnId: "done", approvalId: "approval-1", status: "waiting_for_approval" },
          },
        ],
      },
    });
  });
});

function createHarness(generator?: { generate(input: unknown): Promise<unknown> }): {
  service: KanbanService;
  actions: FakeKanbanActions;
} {
  const catalog = createCatalogStore([provider], {
    executableActionIds: ["work.list_items", "work.update_item"],
  });
  const actions = new FakeKanbanActions();
  const store = new MemoryKanbanStore();
  return {
    service: new KanbanService({
      catalog,
      connections: {
        async getConnectionSummaryById(id) {
          return id === connection.id ? connection : undefined;
        },
      },
      actions,
      approvals: {
        async getActionApproval(id) {
          return id === "approval-1"
            ? {
                id,
                status: "pending",
                actionId: "work.update_item",
                connectionId: connection.id,
                caller: "web",
                input: {},
                requestHash: "hash",
                requestedAt: "2026-08-29T00:00:00.000Z",
              }
            : undefined;
        },
      },
      store,
      generator,
      getPolicySnapshot: async () => new ActionPolicyService().createSnapshot(),
    }),
    actions,
  };
}

class FakeKanbanActions {
  readonly inputs: RunActionInput[] = [];
  state = "New";
  listSize = 1;
  requireApproval = false;

  async run(input: RunActionInput) {
    this.inputs.push(structuredClone(input));
    if (input.actionId === "work.update_item") {
      if (this.requireApproval) {
        return {
          executionId: crypto.randomUUID(),
          auditPersisted: true,
          result: {
            ok: false as const,
            error: {
              code: "approval_pending",
              message: "Approval required.",
              details: { approvalId: "approval-1" },
            },
          },
        };
      }
      this.state = (input.input as { fields: { "System.State": string } }).fields["System.State"];
      return {
        executionId: crypto.randomUUID(),
        auditPersisted: true,
        result: { ok: true as const, output: { updated: true } },
      };
    }
    return {
      executionId: crypto.randomUUID(),
      auditPersisted: true,
      result: {
        ok: true as const,
        output: {
          workItems: Array.from({ length: this.listSize }, (_, index) => ({
            id: 42 + index,
            rev: 7,
            fields: {
              "System.Title": index === 0 ? "Production release" : `Work item ${index + 1}`,
              "System.State": this.state,
              "Microsoft.VSTS.Common.Priority": 1,
            },
          })),
        },
      },
    };
  }
}

class MemoryKanbanStore implements IKanbanStore {
  private readonly boards = new Map<string, KanbanBoardDefinition>();

  async setBoard(board: KanbanBoardDefinition): Promise<void> {
    this.boards.set(board.id, structuredClone(board));
  }

  async getBoard(id: string): Promise<KanbanBoardDefinition | undefined> {
    const board = this.boards.get(id);
    return board ? structuredClone(board) : undefined;
  }

  async listBoards(): Promise<KanbanBoardDefinition[]> {
    return structuredClone([...this.boards.values()]);
  }

  async deleteBoard(id: string): Promise<boolean> {
    return this.boards.delete(id);
  }
}
