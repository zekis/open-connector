import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { AgentChatExtension } from "../chat/agent-chat-service.ts";
import type { TeamsGatewayAgent, TeamsGatewayThread } from "../teams-gateway/teams-gateway-types.ts";
import type { InboxConversationMetadata, IInboxStore } from "./inbox-types.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { InboxService } from "./inbox-service.ts";

const teamsConnection: ConnectionSummary = {
  id: "teams-connection-1",
  service: "microsoft_teams",
  connectionName: "support",
  authType: "oauth2",
  configured: true,
  virtual: false,
  default: true,
  profile: {
    accountId: "agent-user-1",
    displayName: "support@example.com",
    grantedScopes: ["Chat.ReadWrite"],
  },
};

const personalOutlookConnection: ConnectionSummary = {
  ...teamsConnection,
  id: "outlook-connection-1",
  service: "outlook",
  connectionName: "personal",
  profile: {
    accountId: "operator-user-1",
    displayName: "operator@example.com",
    grantedScopes: ["Mail.ReadWrite"],
  },
};

const devopsConnection: ConnectionSummary = {
  ...teamsConnection,
  id: "devops-connection-1",
  service: "azure_devops",
  connectionName: "engineering",
  authType: "api_key",
  profile: {
    accountId: "devops-user-1",
    displayName: "Engineering DevOps",
    grantedScopes: [],
  },
};

const devopsProvider: ProviderDefinition = {
  service: "azure_devops",
  displayName: "Azure DevOps",
  categories: ["Project Management"],
  authTypes: ["api_key"],
  auth: [{ type: "api_key" }],
  actions: [
    {
      id: "azure_devops.create_work_item",
      service: "azure_devops",
      name: "create_work_item",
      description: "Create a work item.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
};

const teamsAgent: TeamsGatewayAgent = {
  id: "agent-1",
  name: "Project agent",
  enabled: true,
  teamsConnectionId: "teams-connection-1",
  agentProvider: "openai_codex",
  allowedDomains: ["example.com"],
  allowedExternalUsers: [],
  proactiveDmUsers: [],
  confirmBeforeTools: true,
  threadWindowHours: 12,
  toolGrants: [],
  watchStartedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const teamsThread: TeamsGatewayThread = {
  id: "thread-1",
  agentId: teamsAgent.id,
  chatId: "chat-1",
  conversationKind: "direct",
  participantId: "user-1",
  participantEmail: "alex@example.com",
  participantName: "Alex",
  messages: [
    {
      id: "teams-message-1",
      role: "user",
      content: "Can you check the rollout?",
      createdAt: "2026-09-02T01:00:00.000Z",
    },
  ],
  cursorAt: "2026-09-02T01:00:00.000Z",
  createdAt: "2026-09-02T01:00:00.000Z",
  updatedAt: "2026-09-04T01:00:00.000Z",
};

describe("InboxService", () => {
  it("lists only Teams gateway agent conversations", async () => {
    const service = createService(new MemoryInboxStore(), [teamsConnection, personalOutlookConnection]);

    const page = await service.list();

    expect(page.sources).toEqual([
      expect.objectContaining({ provider: "microsoft_teams", displayName: "Project agent" }),
    ]);
    expect(page.conversations).toEqual([
      expect.objectContaining({ provider: "microsoft_teams", title: "Alex", unread: true }),
    ]);
    expect(page.errors).toEqual([]);
  });

  it("tracks unread Teams conversations until the operator opens them", async () => {
    const store = new MemoryInboxStore();
    const service = createService(store);

    const initial = await service.list();
    const teamsConversation = initial.conversations.find((item) => item.provider === "microsoft_teams")!;
    expect(teamsConversation.unread).toBe(true);

    await service.markRead(teamsConversation.id);

    const refreshed = await service.list();
    expect(refreshed.conversations.find((item) => item.provider === "microsoft_teams")?.unread).toBe(false);
  });

  it("keeps workflow state and private notes separate from provider messages", async () => {
    const store = new MemoryInboxStore();
    const service = createService(store);
    const conversationId = (await service.list()).conversations.find((item) => item.provider === "microsoft_teams")!.id;

    await service.update(conversationId, { status: "resolved", priority: "high", labels: ["Customer", "urgent"] });
    await service.addNote(conversationId, { content: "Check the contract before replying." });

    const conversation = await service.get(conversationId);
    expect(conversation).toMatchObject({
      status: "resolved",
      priority: "high",
      labels: ["Customer", "urgent"],
      noteCount: 1,
    });
    expect(conversation.messages.at(-1)).toMatchObject({
      kind: "note",
      content: "Check the contract before replying.",
      sender: { name: "Private note" },
    });
  });

  it("runs a message handoff with one exact connection and stores the AI result inline", async () => {
    const handoffs: HandoffCall[] = [];
    const service = createService(new MemoryInboxStore(), [teamsConnection, devopsConnection], {
      async respondWithExtension(request, extension) {
        handoffs.push({ request, extension });
        return {
          status: "completed",
          message: {
            id: "agent-message-1",
            role: "assistant",
            content: "Ticket AB#123 created.",
            createdAt: "2026-09-03T02:00:00.000Z",
          },
          toolActivity: [
            {
              id: "tool-1",
              type: "action",
              label: "Create work item",
              ok: true,
              actionId: "azure_devops.create_work_item",
              connectionId: devopsConnection.id,
              input: {},
              output: { id: 123 },
            },
          ],
        };
      },
    });
    const conversationId = (await service.list()).conversations.find((item) => item.provider === "microsoft_teams")!.id;

    const conversation = await service.runAiAction(conversationId, {
      scope: "message",
      targetId: "teams-message-1",
      connectionId: devopsConnection.id,
      instruction: "Create a bug from this report.",
    });

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.extension.connectorGrants).toEqual([
      {
        connectionId: devopsConnection.id,
        actionIds: new Set(["azure_devops.create_work_item"]),
      },
    ]);
    expect(handoffs[0]?.extension).toMatchObject({
      connectorApprovalPolicy: "bypass",
      includeFlowTools: false,
      context: {
        scope: "message",
        message: { id: "teams-message-1", content: "Can you check the rollout?" },
      },
    });
    expect(conversation.usedConnections).toEqual([
      {
        connectionId: devopsConnection.id,
        connectionName: "Engineering DevOps · engineering",
        service: "azure_devops",
      },
    ]);
    expect(conversation.messages.at(-1)).toMatchObject({
      kind: "action",
      content: "Ticket AB#123 created.",
      action: {
        status: "completed",
        connectionId: devopsConnection.id,
        activities: [{ label: "Create work item", ok: true }],
      },
    });

    await service.runAiAction(conversationId, {
      scope: "contact",
      targetId: "alex@example.com",
      connectionId: devopsConnection.id,
      instruction: "Find work owned by this contact.",
    });
    await service.runAiAction(conversationId, {
      scope: "conversation",
      connectionId: devopsConnection.id,
      instruction: "Summarise relevant work for this conversation.",
    });

    expect(handoffs[1]?.extension.context).toMatchObject({
      scope: "contact",
      contact: { name: "Alex", email: "alex@example.com" },
    });
    expect(handoffs[2]?.extension.context).toMatchObject({
      scope: "conversation",
      participants: [{ name: "Alex", email: "alex@example.com" }],
      messages: [{ id: "teams-message-1" }],
    });
  });

  it("shows and changes Teams operator takeover state", async () => {
    let thread: TeamsGatewayThread = {
      ...teamsThread,
      operatorTakeover: { startedAt: "2026-09-04T02:00:00.000Z" },
      messages: [
        ...teamsThread.messages,
        {
          id: "operator-message-1",
          role: "assistant",
          content: "I am looking into this for you.",
          sentBy: "operator",
          createdAt: "2026-09-04T02:01:00.000Z",
        },
      ],
    };
    const takeoverCalls: boolean[] = [];
    const teamsGateway: ConstructorParameters<typeof InboxService>[0]["teamsGateway"] = {
      async listAgents() {
        return [teamsAgent];
      },
      async listThreads() {
        return [thread];
      },
      async sendOperatorReply() {
        return thread;
      },
      async approveOperatorPlan() {
        return thread;
      },
      async setOperatorTakeover(_threadId, active) {
        takeoverCalls.push(active);
        thread = { ...thread, operatorTakeover: active ? thread.operatorTakeover : undefined };
        return thread;
      },
    };
    const service = createService(new MemoryInboxStore(), [], undefined, teamsGateway);
    const summary = (await service.list()).conversations[0]!;

    expect(summary).toMatchObject({
      operatorTakeover: true,
      operatorTakeoverAt: "2026-09-04T02:00:00.000Z",
    });
    expect((await service.get(summary.id)).messages.at(-1)?.sender.name).toBe("You · via Project agent");

    const released = await service.setTeamsTakeover(summary.id, { active: false });

    expect(takeoverCalls).toEqual([false]);
    expect(released.operatorTakeover).toBe(false);
  });
});

interface HandoffCall {
  request: unknown;
  extension: AgentChatExtension;
}

function createService(
  store: IInboxStore = new MemoryInboxStore(),
  connections: ConnectionSummary[] = [teamsConnection],
  agentChat: ConstructorParameters<typeof InboxService>[0]["agentChat"] = {
    async respondWithExtension() {
      throw new Error("Unexpected AI handoff.");
    },
  },
  teamsGateway: ConstructorParameters<typeof InboxService>[0]["teamsGateway"] = {
    async listAgents() {
      return [teamsAgent];
    },
    async listThreads() {
      return [teamsThread];
    },
    async sendOperatorReply() {
      return teamsThread;
    },
    async approveOperatorPlan() {
      return teamsThread;
    },
    async setOperatorTakeover() {
      return teamsThread;
    },
  },
): InboxService {
  return new InboxService({
    catalog: createCatalogStore([devopsProvider], { executableActionIds: ["azure_devops.create_work_item"] }),
    connections: {
      async listConnections() {
        return connections;
      },
    },
    agentChat,
    teamsGateway,
    store,
  });
}

class MemoryInboxStore implements IInboxStore {
  private readonly conversations = new Map<string, InboxConversationMetadata>();

  async setConversation(metadata: InboxConversationMetadata): Promise<void> {
    this.conversations.set(metadata.id, structuredClone(metadata));
  }

  async getConversation(id: string): Promise<InboxConversationMetadata | undefined> {
    const metadata = this.conversations.get(id);
    return metadata ? structuredClone(metadata) : undefined;
  }

  async listConversations(): Promise<InboxConversationMetadata[]> {
    return [...this.conversations.values()].map((metadata) => structuredClone(metadata));
  }
}
