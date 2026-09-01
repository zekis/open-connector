import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionSummary } from "../../connection-service.ts";
import type { ActionApproval } from "../approvals/connection-approval-types.ts";
import type { AgentChatExtension } from "../chat/agent-chat-service.ts";
import type { AgentChatResponse } from "../chat/agent-chat-types.ts";
import type {
  ITeamsGatewayGraphClient,
  TeamsGatewayGraphChannelThread,
  TeamsGatewayGraphChat,
  TeamsGatewayGraphContext,
  TeamsGatewayGraphTeam,
} from "./teams-gateway-graph.ts";
import type {
  ITeamsGatewayStore,
  TeamsGatewayAgent,
  TeamsGatewayContact,
  TeamsGatewayGroup,
  TeamsGatewayThread,
} from "./teams-gateway-types.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { providerFetch } from "../../providers/provider-runtime.ts";
import { TeamsGatewayService } from "./teams-gateway-service.ts";

const teamsConnection: ConnectionSummary = {
  id: "teams-connection",
  service: "microsoft_teams",
  connectionName: "default",
  authType: "oauth2",
  configured: true,
  virtual: false,
  default: true,
  profile: {
    accountId: "agent-user-id",
    displayName: "agent@company.test",
    grantedScopes: [
      "Chat.Read",
      "ChatMessage.Send",
      "Chat.Create",
      "User.ReadBasic.All",
      "Team.ReadBasic.All",
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
      "Presence.ReadWrite",
    ],
  },
};

describe("TeamsGatewayService", () => {
  it("binds each Teams identity to only one configured agent runtime", async () => {
    const store = new MemoryTeamsGatewayStore();
    const service = createService(store, new FakeTeamsGraph([]), new FakeAgentChat([]));
    const input = {
      name: "Operations agent",
      enabled: true,
      teamsConnectionId: teamsConnection.id,
      agentProvider: "claude_code",
      allowedDomains: ["company.test"],
      allowedExternalUsers: [],
      proactiveDmUsers: [],
      confirmBeforeTools: true,
      threadWindowHours: 12,
      toolGrants: [],
    };

    const created = await service.upsertAgent(undefined, input);
    expect(created).toMatchObject({
      name: "Operations agent",
      teamsConnectionId: teamsConnection.id,
      agentProvider: "claude_code",
      presence: { status: "online" },
    });
    await expect(
      service.upsertAgent(created.id, { ...input, teamsConnectionId: "another-teams-connection" }),
    ).rejects.toMatchObject({ code: "teams_identity_immutable", status: 409 });
    await expect(service.upsertAgent(undefined, { ...input, name: "Duplicate" })).rejects.toMatchObject({
      code: "teams_connection_in_use",
      status: 409,
    });
    const unconfiguredRuntimeService = createService(
      new MemoryTeamsGatewayStore(),
      new FakeTeamsGraph([]),
      new FakeAgentChat([]),
    );
    await expect(
      unconfiguredRuntimeService.upsertAgent(undefined, { ...input, agentProvider: "openai_codex" }),
    ).rejects.toMatchObject({ code: "agent_connection_not_found" });
  });

  it("processes authorized inbound DMs once and records prior contact", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Please summarize my work."),
    ]);
    const chat = new FakeAgentChat([completedResponse("Here is your summary.")]);
    const service = createService(store, graph, chat);

    expect(await service.pollNow()).toMatchObject({ agents: 1, chats: 1, messages: 1, errors: 0 });
    expect(await service.pollNow()).toMatchObject({ messages: 0, errors: 0 });

    expect(chat.respondExtensions).toHaveLength(1);
    expect(chat.respondExtensions[0]?.connectorGrants).toEqual([
      { connectionId: "calendar-connection", actionIds: new Set(["calendar.list_events"]) },
    ]);
    expect(graph.sent.map((item) => item.text)).toEqual(["Here is your summary."]);
    expect(await store.getContact("agent-1", "person@company.test")).toMatchObject({
      userId: "person-user-id",
      chatId: "chat-1",
      firstInboundAt: "2026-09-01T01:00:00.000Z",
    });
  });

  it("ignores an external sender unless the exact address is authorized", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ allowedDomains: ["another.test"] })]);
    const graph = new FakeTeamsGraph([inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Hello")]);
    const chat = new FakeAgentChat([completedResponse("This must not be sent.")]);
    const service = createService(store, graph, chat);

    await service.pollNow();

    expect(chat.respondExtensions).toEqual([]);
    expect(graph.sent).toEqual([]);
    expect(await store.getContact("agent-1", "person@company.test")).toBeUndefined();
    expect(await store.getThread("agent-1", "chat-1")).toMatchObject({
      cursorMessageId: "message-1",
      messages: [],
    });
  });

  it("pauses provider work for a plan and continues after the person confirms", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent()]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Check tomorrow's calendar."),
    ]);
    const chat = new FakeAgentChat([
      async (extension) => {
        const activity = await extension.runTool("propose_teams_plan", {
          summary: "Check tomorrow's calendar",
          steps: ["Read tomorrow's events", "Summarize the schedule"],
        });
        return completedResponse("Waiting for confirmation.", activity ? [activity] : []);
      },
      completedResponse("Tomorrow has two meetings."),
    ]);
    const service = createService(store, graph, chat);

    await service.pollNow();
    expect(graph.sent[0]?.text).toContain("Plan: Check tomorrow's calendar");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toMatchObject({
      steps: ["Read tomorrow's events", "Summarize the schedule"],
    });

    graph.messages.push(inboundMessage("message-2", "2026-09-01T01:01:00.000Z", "proceed"));
    await service.pollNow();

    expect(graph.sent.at(-1)?.text).toBe("Tomorrow has two meetings.");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toBeUndefined();
    expect(chat.respondExtensions[1]?.systemPrompt).toContain("confirmed the current plan");
  });

  it("keeps a batch paused until every requested action is approved", async () => {
    const firstApproval = createApproval("alpha-1");
    const secondApproval = createApproval("beta-2");
    const approvals = new FakeApprovals([firstApproval, secondApproval]);
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Update the two records."),
    ]);
    const chat = new FakeAgentChat([
      waitingResponse([firstApproval.id, secondApproval.id]),
      completedResponse("Both approved updates are complete."),
    ]);
    const service = createService(store, graph, chat, approvals);

    await service.pollNow();
    expect((await store.getThread("agent-1", "chat-1"))?.pendingApprovalIds).toEqual([
      firstApproval.id,
      secondApproval.id,
    ]);

    graph.messages.push(inboundMessage("message-2", "2026-09-01T01:01:00.000Z", "approve ALPHA1"));
    await service.pollNow();
    expect(approvals.status(firstApproval.id)).toBe("approved");
    expect(approvals.status(secondApproval.id)).toBe("pending");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingApprovalIds).toEqual([secondApproval.id]);
    expect(chat.respondExtensions).toHaveLength(1);

    graph.messages.push(inboundMessage("message-3", "2026-09-01T01:02:00.000Z", "approve"));
    await service.pollNow();
    expect(approvals.status(secondApproval.id)).toBe("approved");
    expect(graph.sent.at(-1)?.text).toBe("Both approved updates are complete.");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingApprovalIds).toBeUndefined();
  });

  it("detects group chats, keeps their roster as context, and replies to the group", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([
      inboundMessage("group-message-1", "2026-09-01T01:00:00.000Z", "Can everyone see this?"),
    ]);
    graph.chats = [
      {
        id: "group-chat-1",
        chatType: "group",
        topic: "Operations room",
        members: [
          { userId: "agent-user-id", email: "agent@company.test", displayName: "Agent" },
          { userId: "person-user-id", email: "person@company.test", displayName: "Person" },
          { userId: "colleague-user-id", email: "colleague@company.test", displayName: "Colleague" },
        ],
        lastMessageAt: "2026-09-01T01:00:00.000Z",
      },
    ];
    const chat = new FakeAgentChat([completedResponse("Yes — replying to the whole group.")]);
    const service = createService(store, graph, chat);

    expect(await service.pollNow()).toMatchObject({ chats: 1, messages: 1, errors: 0 });
    expect(graph.sent).toEqual([{ chatId: "group-chat-1", text: "Yes — replying to the whole group." }]);
    expect(await store.listGroups("agent-1")).toMatchObject([
      { kind: "group_chat", displayName: "Operations room", members: [{}, {}, {}] },
    ]);
    expect(await store.getThread("agent-1", "group-chat-1")).toMatchObject({
      conversationKind: "group_chat",
      conversationName: "Operations room",
    });
    expect(chat.respondExtensions[0]?.systemPrompt).toContain("visible to the group");
    expect(await store.listContacts("agent-1")).toEqual([]);
  });

  it("detects joined Team channels and replies in the original post thread", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([]);
    graph.chats = [];
    graph.teams = [{ id: "team-1", displayName: "Operations" }];
    graph.channels = [{ id: "channel-1", displayName: "General" }];
    graph.channelThreads = [
      {
        root: inboundMessage("root-1", "2026-09-01T01:00:00.000Z", "Agent, give us a status update."),
        replies: [],
      },
    ];
    const chat = new FakeAgentChat([
      completedResponse("Everything is operating normally."),
      completedResponse("The follow-up is noted."),
    ]);
    const service = createService(store, graph, chat);

    expect(await service.pollNow()).toMatchObject({ chats: 1, messages: 1, errors: 0 });
    expect(graph.channelReplies).toEqual([
      {
        teamId: "team-1",
        channelId: "channel-1",
        rootMessageId: "root-1",
        text: "Everything is operating normally.",
      },
    ]);
    expect(await store.listGroups("agent-1")).toMatchObject([
      { kind: "team", displayName: "Operations", channels: [{ displayName: "General" }] },
    ]);
    const [thread] = await store.listThreads("agent-1");
    expect(thread).toMatchObject({
      conversationKind: "channel",
      teamName: "Operations",
      channelName: "General",
      rootMessageId: "root-1",
    });
    expect(chat.respondExtensions[0]?.systemPrompt).toContain("current post thread");

    graph.channelThreads = [];
    graph.listedChannelReplies.push(
      inboundMessage("reply-1", "2026-09-01T02:05:00.000Z", "Please add that to the thread."),
    );
    expect(await service.pollNow()).toMatchObject({ messages: 1, errors: 0 });
    expect(graph.channelReplies.at(-1)).toMatchObject({
      rootMessageId: "root-1",
      text: "The follow-up is noted.",
    });
    expect(await service.getMetrics()).toMatchObject([
      { presence: "online", teamCount: 1, channelCount: 1, handledMessageCount: 2, replyCount: 2 },
    ]);
  });

  it("enforces both DM gates before creating a proactive chat", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ proactiveDmUsers: ["allowed@company.test"] })]);
    const graph = new FakeTeamsGraph([]);
    const service = createService(store, graph, new FakeAgentChat([]));

    await expect(service.sendProactiveMessage("agent-1", "new@company.test", "Hello")).rejects.toMatchObject({
      code: "dm_not_allowed",
      status: 403,
    });
    await expect(service.sendProactiveMessage("agent-1", "stranger@outside.test", "Hello")).rejects.toMatchObject({
      code: "dm_not_allowed",
      status: 403,
    });
    await expect(service.sendProactiveMessage("agent-1", "allowed@company.test", "Hello")).resolves.toMatchObject({
      chatId: "created-chat",
    });
  });
});

function createService(
  store: MemoryTeamsGatewayStore,
  graph: FakeTeamsGraph,
  agentChat: FakeAgentChat,
  approvals = new FakeApprovals(),
): TeamsGatewayService {
  return new TeamsGatewayService({
    catalog: createCatalogStore([], { executableActionIds: [] }) as CatalogStore,
    connections: {
      async getConnectionSummaryById(id) {
        return id === teamsConnection.id ? teamsConnection : undefined;
      },
      async listConnections() {
        return [teamsConnection];
      },
    },
    agents: {
      async list() {
        return [
          {
            id: "claude-subscription",
            provider: "claude_code" as const,
            authType: "subscription_oauth" as const,
            configured: true as const,
            displayName: "Claude subscription",
          },
        ];
      },
    },
    agentChat,
    approvals,
    graph,
    store,
    now: () => new Date("2026-09-01T02:00:00.000Z"),
    timeZone: "Australia/Perth",
  });
}

function createAgent(overrides: Partial<TeamsGatewayAgent> = {}): TeamsGatewayAgent {
  return {
    id: "agent-1",
    name: "Operations agent",
    enabled: true,
    teamsConnectionId: teamsConnection.id,
    agentProvider: "claude_code",
    allowedDomains: ["company.test"],
    allowedExternalUsers: [],
    proactiveDmUsers: [],
    confirmBeforeTools: true,
    threadWindowHours: 12,
    toolGrants: [{ connectionId: "calendar-connection", actionIds: ["calendar.list_events"] }],
    watchStartedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function inboundMessage(id: string, createdAt: string, text: string) {
  return { id, createdAt, senderId: "person-user-id", senderName: "Person", text };
}

function completedResponse(text: string, toolActivity: AgentChatResponse["toolActivity"] = []): AgentChatResponse {
  return {
    status: "completed",
    message: { id: crypto.randomUUID(), role: "assistant", content: text, createdAt: "2026-09-01T02:00:00.000Z" },
    toolActivity,
  };
}

function waitingResponse(ids: string[]): AgentChatResponse {
  return {
    status: "waiting_for_approval",
    approvalId: ids[0],
    approvalIds: ids,
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `${ids.length} actions are waiting for approval.`,
      createdAt: "2026-09-01T02:00:00.000Z",
    },
    toolActivity: ids.map((id) => ({
      id: crypto.randomUUID(),
      type: "action",
      label: "example.update",
      ok: false,
      actionId: "example.update",
      connectionId: "example-connection",
      approvalId: id,
      input: {},
      output: {},
    })),
  };
}

function createApproval(id: string): ActionApproval {
  return {
    id,
    status: "pending",
    actionId: "example.update",
    connectionId: "example-connection",
    caller: "chat",
    input: {},
    requestHash: `request-${id}`,
    requestedAt: "2026-09-01T02:00:00.000Z",
  };
}

type AgentChatDecision =
  | AgentChatResponse
  | ((extension: AgentChatExtension) => AgentChatResponse | Promise<AgentChatResponse>);

class FakeAgentChat {
  readonly respondExtensions: AgentChatExtension[] = [];
  private readonly decisions: AgentChatDecision[];

  constructor(decisions: AgentChatDecision[]) {
    this.decisions = decisions;
  }

  async respondWithExtension(_input: unknown, extension: AgentChatExtension): Promise<AgentChatResponse> {
    this.respondExtensions.push(extension);
    const decision = this.decisions.shift();
    if (!decision) throw new Error("Unexpected agent turn.");
    return typeof decision === "function" ? await decision(extension) : decision;
  }

  async resumeWithExtension(_approvalId: string, extension?: AgentChatExtension): Promise<AgentChatResponse> {
    if (!extension) throw new Error("Expected the Teams extension when resuming.");
    return await this.respondWithExtension({}, extension);
  }
}

class FakeApprovals {
  private readonly approvals = new Map<string, ActionApproval>();

  constructor(approvals: ActionApproval[] = []) {
    for (const approval of approvals) this.approvals.set(approval.id, structuredClone(approval));
  }

  status(id: string): ActionApproval["status"] | undefined {
    return this.approvals.get(id)?.status;
  }

  async getActionApproval(id: string): Promise<ActionApproval | undefined> {
    return this.approvals.get(id);
  }

  async approve(id: string): Promise<ActionApproval> {
    return this.resolve(id, "approved");
  }

  async deny(id: string): Promise<ActionApproval> {
    return this.resolve(id, "denied");
  }

  private resolve(id: string, status: "approved" | "denied"): ActionApproval {
    const approval = this.approvals.get(id);
    if (!approval) throw new Error(`Approval not found: ${id}`);
    const updated = { ...approval, status, resolvedAt: "2026-09-01T02:00:00.000Z" };
    this.approvals.set(id, updated);
    return updated;
  }
}

class FakeTeamsGraph implements ITeamsGatewayGraphClient {
  readonly messages: ReturnType<typeof inboundMessage>[];
  readonly sent: Array<{ chatId: string; text: string }> = [];
  readonly channelReplies: Array<{ teamId: string; channelId: string; rootMessageId: string; text: string }> = [];
  chats: TeamsGatewayGraphChat[];
  teams: TeamsGatewayGraphTeam[] = [];
  channels: Array<{ id: string; displayName: string }> = [];
  channelThreads: TeamsGatewayGraphChannelThread[] = [];
  listedChannelReplies: ReturnType<typeof inboundMessage>[] = [];
  presenceSets = 0;

  constructor(messages: ReturnType<typeof inboundMessage>[]) {
    this.messages = messages;
    this.chats = [
      {
        id: "chat-1",
        chatType: "oneOnOne",
        members: [
          { userId: "agent-user-id", email: "agent@company.test", displayName: "Agent" },
          { userId: "person-user-id", email: "person@company.test", displayName: "Person" },
        ],
        lastMessageAt: this.messages.at(-1)?.createdAt,
      },
    ];
  }

  async context(): Promise<TeamsGatewayGraphContext> {
    return {
      selfId: "agent-user-id",
      selfEmail: "agent@company.test",
      presenceSessionId: "teams-app-id",
      deps: { accessToken: "token", fetcher: providerFetch },
    };
  }

  async listChats(): Promise<TeamsGatewayGraphChat[]> {
    return this.chats.map((chat) => ({ ...chat, lastMessageAt: this.messages.at(-1)?.createdAt }));
  }

  async listJoinedTeams(): Promise<TeamsGatewayGraphTeam[]> {
    return this.teams;
  }

  async listChannels() {
    return this.channels;
  }

  async listChannelThreads() {
    return this.channelThreads;
  }

  async listChannelReplies(
    _context: TeamsGatewayGraphContext,
    _teamId: string,
    _channelId: string,
    _rootMessageId: string,
    since: string,
  ) {
    return this.listedChannelReplies.filter((message) => Date.parse(message.createdAt) > Date.parse(since));
  }

  async listMessages(_context: TeamsGatewayGraphContext, _chatId: string, since: string) {
    return this.messages.filter((message) => Date.parse(message.createdAt) > Date.parse(since));
  }

  async resolveUser() {
    return { userId: "person-user-id", email: "person@company.test", displayName: "Person" };
  }

  async sendMessage(_context: TeamsGatewayGraphContext, chatId: string, text: string) {
    this.sent.push({ chatId, text });
    return { id: `sent-${this.sent.length}` };
  }

  async sendChannelReply(
    _context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    text: string,
  ) {
    this.channelReplies.push({ teamId, channelId, rootMessageId, text });
    return { id: `channel-sent-${this.channelReplies.length}` };
  }

  async createOneOnOneChat() {
    return { id: "created-chat" };
  }

  async setPresence(): Promise<void> {
    this.presenceSets += 1;
  }

  async clearPresence(): Promise<void> {}
}

class MemoryTeamsGatewayStore implements ITeamsGatewayStore {
  private readonly agents = new Map<string, TeamsGatewayAgent>();
  private readonly threads = new Map<string, TeamsGatewayThread>();
  private readonly contacts = new Map<string, TeamsGatewayContact>();
  private readonly groups = new Map<string, TeamsGatewayGroup>();

  constructor(agents: TeamsGatewayAgent[] = []) {
    for (const agent of agents) this.agents.set(agent.id, structuredClone(agent));
  }

  async setAgent(agent: TeamsGatewayAgent): Promise<void> {
    this.agents.set(agent.id, structuredClone(agent));
  }

  async getAgent(id: string): Promise<TeamsGatewayAgent | undefined> {
    return clone(this.agents.get(id));
  }

  async listAgents(): Promise<TeamsGatewayAgent[]> {
    return [...this.agents.values()].map((agent) => structuredClone(agent));
  }

  async deleteAgent(id: string): Promise<boolean> {
    return this.agents.delete(id);
  }

  async setThread(thread: TeamsGatewayThread): Promise<void> {
    this.threads.set(`${thread.agentId}:${thread.chatId}`, structuredClone(thread));
  }

  async getThread(agentId: string, chatId: string): Promise<TeamsGatewayThread | undefined> {
    return clone(this.threads.get(`${agentId}:${chatId}`));
  }

  async listThreads(agentId?: string, limit = 100): Promise<TeamsGatewayThread[]> {
    return [...this.threads.values()]
      .filter((thread) => !agentId || thread.agentId === agentId)
      .slice(0, limit)
      .map((thread) => structuredClone(thread));
  }

  async setContact(contact: TeamsGatewayContact): Promise<void> {
    this.contacts.set(`${contact.agentId}:${contact.email}`, structuredClone(contact));
  }

  async getContact(agentId: string, email: string): Promise<TeamsGatewayContact | undefined> {
    return clone(this.contacts.get(`${agentId}:${email.toLowerCase()}`));
  }

  async listContacts(agentId: string): Promise<TeamsGatewayContact[]> {
    return [...this.contacts.values()]
      .filter((contact) => contact.agentId === agentId)
      .map((contact) => structuredClone(contact));
  }

  async setGroup(group: TeamsGatewayGroup): Promise<void> {
    this.groups.set(group.id, structuredClone(group));
  }

  async listGroups(agentId?: string): Promise<TeamsGatewayGroup[]> {
    return [...this.groups.values()]
      .filter((group) => !agentId || group.agentId === agentId)
      .map((group) => structuredClone(group));
  }

  async deleteMissingGroups(agentId: string, retainedIds: string[]): Promise<void> {
    const retained = new Set(retainedIds);
    for (const [id, group] of this.groups) {
      if (group.agentId === agentId && !retained.has(id)) this.groups.delete(id);
    }
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
