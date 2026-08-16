import type { ProviderDefinition } from "../../core/types.ts";
import type { IActionRunner } from "../actions/action-runner.ts";
import type { AgentChatExtension } from "../chat/agent-chat-service.ts";
import type { AgentChatApprovalResult, AgentChatResponse } from "../chat/agent-chat-types.ts";
import type { ISynapseStore, SynapseSize, SynapseWorkspace } from "./synapse-types.ts";

import { describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { SynapseService } from "./synapse-service.ts";

const connections = [
  {
    id: "outlook-1",
    service: "outlook",
    connectionName: "work",
    authType: "oauth2" as const,
    configured: true,
    virtual: false,
    default: true,
    profile: { accountId: "outlook:zeke", displayName: "zeke@example.com", grantedScopes: [] },
  },
  {
    id: "brave-1",
    service: "brave",
    connectionName: "default",
    authType: "api_key" as const,
    configured: true,
    virtual: false,
    default: true,
    profile: { accountId: "brave:default", displayName: "Brave Search", grantedScopes: [] },
  },
];

describe("SynapseService", () => {
  it("gives a selected node only its connected graph context and projects connector results into artifacts", async () => {
    let extensionSeen: AgentChatExtension | undefined;
    const agentChat = {
      respondWithExtension: vi.fn(async (_input: unknown, extension: AgentChatExtension) => {
        extensionSeen = extension;
        return completedResponse([
          {
            id: "activity-1",
            type: "action",
            label: "brave.web_search",
            ok: true,
            actionId: "brave.web_search",
            connectionId: "brave-1",
            connectionDisplayName: "Brave Search",
            input: { query: "similar sales" },
            output: {
              results: [
                { title: "Deal one", description: "Half price", url: "https://example.com/deal-one" },
                { title: "Deal two", description: "Clearance", url: "https://example.com/deal-two" },
              ],
            },
          },
        ]);
      }),
      getApprovalResult: vi.fn(async (approvalId: string) => pendingApproval(approvalId)),
    };
    const service = createService(agentChat);
    const created = await service.create({ name: "Sales research" });
    const withOutlook = await service.addNode(created.id, {
      kind: "provider",
      connectionId: "outlook-1",
      position: { x: 100, y: 100 },
    });
    const outlookNode = withOutlook.nodes[0]!;

    const result = await service.chat(created.id, outlookNode.id, { content: "Search for similar sales." });

    expect(extensionSeen?.context).toMatchObject({ selectedNodeId: outlookNode.id, nodes: [{ id: outlookNode.id }] });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "provider", connectionId: "brave-1", service: "brave" }),
        expect.objectContaining({ kind: "artifact", title: "Deal one", artifactKind: "search_result" }),
        expect.objectContaining({ kind: "artifact", title: "Deal two", artifactKind: "search_result" }),
      ]),
    );
    expect(result.edges).toHaveLength(3);
    expect(result.threads[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.nodes.find((node) => node.kind === "artifact" && node.title === "Deal one")).toMatchObject({
      content: "Half price\n\n[Open source](https://example.com/deal-one)",
      itemIdentity: "brave-1:brave:web_search:https://example.com/deal-one",
      previews: [expect.objectContaining({ kind: "web", externalUrl: "https://example.com/deal-one" })],
    });
  });

  it("allows branch-local instances of one provider connection", async () => {
    const service = createService({
      respondWithExtension: vi.fn(async () => completedResponse([])),
      getApprovalResult: vi.fn(async (approvalId: string) => pendingApproval(approvalId)),
    });
    const workspace = await service.create({ name: "Parallel mail branches" });
    await service.addNode(workspace.id, {
      kind: "provider",
      connectionId: "outlook-1",
      position: { x: 100, y: 100 },
      instructions: "Investigate sales mail.",
    });
    const result = await service.addNode(workspace.id, {
      kind: "provider",
      connectionId: "outlook-1",
      position: { x: 500, y: 100 },
      instructions: "Investigate project mail.",
    });

    expect(result.nodes.filter((node) => node.kind === "provider" && node.connectionId === "outlook-1")).toHaveLength(
      2,
    );
  });

  it("reuses a stable provider item across repeated connector results", async () => {
    let activityNumber = 0;
    const service = createService({
      respondWithExtension: vi.fn(async () => {
        activityNumber += 1;
        return completedResponse([
          {
            id: `activity-${activityNumber}`,
            type: "action",
            label: "outlook.list_messages",
            ok: true,
            actionId: "outlook.list_messages",
            connectionId: "outlook-1",
            input: { top: 10 },
            output: {
              messages: [
                {
                  id: "message-1",
                  subject: "Project update",
                  bodyPreview: "Current status",
                  webLink: "https://outlook.office.com/mail/message-1",
                },
              ],
            },
          },
        ]);
      }),
      getApprovalResult: vi.fn(async (approvalId: string) => pendingApproval(approvalId)),
    });
    const workspace = await service.create({ name: "Stable mail" });
    const seeded = await service.addNode(workspace.id, {
      kind: "provider",
      connectionId: "outlook-1",
      position: { x: 100, y: 100 },
    });
    const outlook = seeded.nodes[0]!;

    await service.chat(workspace.id, outlook.id, { content: "Find updates." });
    const repeated = await service.chat(workspace.id, outlook.id, { content: "Refresh updates." });
    const artifacts = repeated.nodes.filter((node) => node.kind === "artifact");

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      itemIdentity: "outlook-1:outlook:message:message-1",
      sourceActivityId: "activity-2",
    });
  });

  it("orders connected context from the selected node outward", async () => {
    let extensionSeen: AgentChatExtension | undefined;
    const service = createService({
      respondWithExtension: vi.fn(async (_input: unknown, extension: AgentChatExtension) => {
        extensionSeen = extension;
        return completedResponse([]);
      }),
      getApprovalResult: vi.fn(async (approvalId: string) => pendingApproval(approvalId)),
    });
    const workspace = await service.create({ name: "Ranked context" });
    const first = await service.addNode(workspace.id, {
      kind: "artifact",
      artifactKind: "note",
      title: "Old distant node",
      position: { x: 100, y: 100 },
    });
    const second = await service.addNode(workspace.id, {
      kind: "artifact",
      artifactKind: "note",
      title: "Nearest node",
      position: { x: 400, y: 100 },
    });
    const third = await service.addNode(workspace.id, {
      kind: "artifact",
      artifactKind: "note",
      title: "Selected node",
      position: { x: 700, y: 100 },
    });
    await service.addEdge(workspace.id, { sourceNodeId: first.nodes[0]!.id, targetNodeId: second.nodes[1]!.id });
    await service.addEdge(workspace.id, { sourceNodeId: second.nodes[1]!.id, targetNodeId: third.nodes[2]!.id });

    await service.chat(workspace.id, third.nodes[2]!.id, { content: "Summarise this branch." });

    expect(extensionSeen?.context).toMatchObject({
      nodes: [
        { id: third.nodes[2]!.id, graphDistance: 0 },
        { id: second.nodes[1]!.id, graphDistance: 1 },
        { id: first.nodes[0]!.id, graphDistance: 2 },
      ],
    });
  });

  it("loads Outlook attachment previews through the source connection", async () => {
    const actions = {
      run: vi.fn(async () => ({
        executionId: "preview-execution",
        auditPersisted: true,
        result: {
          ok: true as const,
          output: {
            name: "Plans.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4,
            file: null,
            contentBase64: "JVBERg==",
          },
        },
      })),
    };
    const service = createService(
      {
        respondWithExtension: vi.fn(async () =>
          completedResponse([
            {
              id: "attachment-activity",
              type: "action",
              label: "outlook.list_attachments",
              ok: true,
              actionId: "outlook.list_attachments",
              connectionId: "outlook-1",
              input: { messageId: "message-1" },
              output: {
                attachments: [{ id: "attachment-1", name: "Plans.pdf", contentType: "application/pdf", size: 4 }],
              },
            },
          ]),
        ),
        getApprovalResult: vi.fn(async (approvalId: string) => pendingApproval(approvalId)),
      },
      actions,
    );
    const workspace = await service.create({ name: "Mail previews" });
    const seeded = await service.addNode(workspace.id, {
      kind: "provider",
      connectionId: "outlook-1",
      position: { x: 100, y: 100 },
    });
    const result = await service.chat(workspace.id, seeded.nodes[0]!.id, { content: "Show the attachment." });
    const attachment = result.nodes.find(
      (node): node is Extract<(typeof result.nodes)[number], { kind: "artifact" }> => node.kind === "artifact",
    )!;

    expect(attachment.previews).toEqual([
      expect.objectContaining({ id: "file", kind: "pdf", contentUrl: expect.stringContaining("/previews/file") }),
    ]);
    await expect(service.getPreview(workspace.id, attachment.id, "file")).resolves.toMatchObject({
      name: "Plans.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
    });
    expect(actions.run).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "outlook.download_attachment",
        connectionId: "outlook-1",
        input: { messageId: "message-1", attachmentId: "attachment-1" },
        approvalPolicy: "bypass",
      }),
    );
  });

  it("lets the agent create and revise durable artifact cards with Synapse graph tools", async () => {
    let turn = 0;
    const agentChat = {
      respondWithExtension: vi.fn(async (_input: unknown, extension: AgentChatExtension) => {
        turn += 1;
        const activity =
          turn === 1
            ? await extension.runTool("synapse_add_artifacts", {
                artifacts: [
                  {
                    artifactKind: "draft",
                    title: "Forward sale to Alex",
                    content: "Alex, take a look at this sale.",
                  },
                ],
              })
            : await extension.runTool("synapse_update_artifact", {
                content: "Hey Alex, this sale looks ideal for you.",
              });
        return completedResponse(activity ? [activity] : []);
      }),
      getApprovalResult: vi.fn(async (approvalId: string) => pendingApproval(approvalId)),
    };
    const service = createService(agentChat);
    const workspace = await service.create({ name: "Drafting" });
    const seeded = await service.addNode(workspace.id, {
      kind: "artifact",
      artifactKind: "email",
      title: "A useful sale",
      position: { x: 100, y: 100 },
    });
    const email = seeded.nodes[0]!;
    const drafted = await service.chat(workspace.id, email.id, { content: "Draft a note to Alex." });
    const draft = drafted.nodes.find(
      (node): node is Extract<(typeof drafted.nodes)[number], { kind: "artifact" }> =>
        node.kind === "artifact" && node.artifactKind === "draft",
    )!;

    const revised = await service.chat(workspace.id, draft.id, { content: "Make it friendlier." });

    expect(revised.nodes.find((node) => node.id === draft.id)).toMatchObject({
      content: "Hey Alex, this sale looks ideal for you.",
    });
  });

  it("accepts coordinates in every direction and moves new cards out of occupied space", async () => {
    const service = createService({
      respondWithExtension: vi.fn(async () => completedResponse([])),
      getApprovalResult: vi.fn(async (approvalId: string) => pendingApproval(approvalId)),
    });
    const workspace = await service.create({ name: "Infinite canvas" });
    const first = await service.addNode(workspace.id, {
      kind: "artifact",
      artifactKind: "note",
      title: "North west",
      content: "First card",
      position: { x: -50_000, y: -40_000 },
    });
    const resized = await service.updateNode(workspace.id, first.nodes[0]!.id, {
      size: { width: 520, height: 340 },
    });
    const second = await service.addNode(workspace.id, {
      kind: "artifact",
      artifactKind: "note",
      title: "Another card",
      content: "Second card",
      position: { x: -50_000, y: -40_000 },
    });

    expect(first.nodes[0]?.position).toEqual({ x: -50_000, y: -40_000 });
    expect(resized.nodes[0]?.size).toEqual({ width: 520, height: 340 });
    expect(second.nodes[1]?.position).not.toEqual(second.nodes[0]?.position);
    expect(
      cardsOverlap(second.nodes[0]!.position, second.nodes[0]!.size!, second.nodes[1]!.position, {
        width: 264,
        height: 164,
      }),
    ).toBe(false);
  });

  it("keeps a node conversation paused for approval and applies the resumed result once", async () => {
    const approvalId = "approval-1";
    let approvalResult: AgentChatApprovalResult = { approvalId, status: "pending" };
    const agentChat = {
      respondWithExtension: vi.fn(async () => waitingResponse(approvalId)),
      getApprovalResult: vi.fn(async () => approvalResult),
    };
    const service = createService(agentChat);
    const workspace = await service.create({ name: "Approved actions" });
    const seeded = await service.addNode(workspace.id, {
      kind: "provider",
      connectionId: "outlook-1",
      position: { x: 100, y: 100 },
    });
    const outlook = seeded.nodes[0]!;

    const waiting = await service.chat(workspace.id, outlook.id, { content: "Send the draft." });
    expect(waiting.threads[0]).toMatchObject({ pendingApprovalId: approvalId });

    approvalResult = {
      approvalId,
      status: "consumed",
      response: completedResponse([
        {
          id: "send-activity",
          type: "action",
          label: "outlook.send_draft",
          ok: true,
          actionId: "outlook.send_draft",
          connectionId: "outlook-1",
          input: { messageId: "draft-1" },
          output: { subject: "Sale for Alex", status: "sent" },
        },
      ]),
    };
    const resumed = await service.syncPendingApproval(workspace.id, outlook.id);

    expect(resumed.threads[0]).toMatchObject({ pendingApprovalId: undefined });
    expect(resumed.threads[0]?.messages).toHaveLength(2);
    expect(resumed.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "artifact", title: "Sale for Alex", sourceActivityId: "send-activity" }),
      ]),
    );
  });
});

function cardsOverlap(
  left: { x: number; y: number },
  leftSize: SynapseSize,
  right: { x: number; y: number },
  rightSize: SynapseSize,
): boolean {
  return !(
    left.x + leftSize.width + 48 <= right.x ||
    right.x + rightSize.width + 48 <= left.x ||
    left.y + leftSize.height + 32 <= right.y ||
    right.y + rightSize.height + 32 <= left.y
  );
}

function createService(
  agentChat: {
    respondWithExtension: (input: unknown, extension: AgentChatExtension) => Promise<AgentChatResponse>;
    getApprovalResult: (approvalId: string) => Promise<AgentChatApprovalResult>;
  },
  actions?: Pick<IActionRunner, "run">,
): SynapseService {
  return new SynapseService({
    catalog: createCatalogStore([provider("outlook", "Outlook"), provider("brave", "Brave Search")]),
    connections: {
      async listConnections() {
        return structuredClone(connections);
      },
    },
    agentChat,
    actions,
    store: new MemorySynapseStore(),
  });
}

function provider(service: string, displayName: string): ProviderDefinition {
  return {
    service,
    displayName,
    description: `${displayName} provider`,
    categories: ["productivity"],
    authTypes: ["no_auth"],
    auth: [{ type: "no_auth" as const }],
    actions: [],
  };
}

function pendingApproval(approvalId: string): AgentChatApprovalResult {
  return { approvalId, status: "pending" };
}

function completedResponse(toolActivity: AgentChatResponse["toolActivity"]): AgentChatResponse {
  return {
    status: "completed",
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "Added the useful results to the canvas.",
      createdAt: new Date().toISOString(),
    },
    toolActivity,
  };
}

function waitingResponse(approvalId: string): AgentChatResponse {
  return {
    status: "waiting_for_approval",
    approvalId,
    message: {
      id: "waiting-message",
      role: "assistant",
      content: "Waiting for approval.",
      createdAt: new Date().toISOString(),
    },
    toolActivity: [
      {
        id: "pending-action",
        type: "action",
        label: "outlook.send_draft",
        ok: false,
        actionId: "outlook.send_draft",
        connectionId: "outlook-1",
        approvalId,
        input: { messageId: "draft-1" },
        output: { error: { code: "approval_pending" } },
      },
    ],
  };
}

class MemorySynapseStore implements ISynapseStore {
  private readonly workspaces = new Map<string, SynapseWorkspace>();

  async setWorkspace(workspace: SynapseWorkspace): Promise<void> {
    this.workspaces.set(workspace.id, structuredClone(workspace));
  }

  async getWorkspace(id: string): Promise<SynapseWorkspace | undefined> {
    return structuredClone(this.workspaces.get(id));
  }

  async listWorkspaces(limit = 100): Promise<SynapseWorkspace[]> {
    return [...this.workspaces.values()].slice(0, limit).map((workspace) => structuredClone(workspace));
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    return this.workspaces.delete(id);
  }
}
