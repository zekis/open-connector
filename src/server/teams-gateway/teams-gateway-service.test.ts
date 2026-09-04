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
  TeamsGatewayGraphAttachment,
  TeamsGatewayGraphFile,
  TeamsGatewayGraphTeam,
} from "./teams-gateway-graph.ts";
import type {
  ITeamsGatewayStore,
  TeamsGatewayAgent,
  TeamsGatewayContact,
  TeamsGatewayGroup,
  TeamsGatewaySubscription,
  TeamsGatewayThread,
} from "./teams-gateway-types.ts";

import { describe, expect, it, vi } from "vitest";
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
      "Files.ReadWrite.All",
      "Sites.ReadWrite.All",
    ],
  },
};

describe("TeamsGatewayService", () => {
  it("creates Graph subscriptions and uses valid notifications to wake the poller", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent()]);
    const graph = new FakeTeamsGraph([]);
    graph.teams = [{ id: "team-1", displayName: "Operations" }];
    graph.channels = [{ id: "channel-1", displayName: "General" }];
    const agentChat = new FakeAgentChat([completedResponse("Immediate reply")]);
    const service = createService(store, graph, agentChat, undefined, undefined, {
      publicOrigin: "https://connect.example.test",
    });

    await service.pollNow();
    const subscriptions = await store.listSubscriptions("agent-1");
    const subscription = subscriptions.find((item) => item.kind === "chat_messages");
    expect(subscriptions.map((item) => item.kind).sort()).toEqual([
      "channel_messages",
      "chat_messages",
      "team_channels",
    ]);
    expect(subscription).toMatchObject({
      kind: "chat_messages",
      resource: "/users/agent-user-id/chats/getAllMessages",
    });
    expect(graph.createdSubscriptions.find((item) => item.resource.includes("getAllMessages"))).toMatchObject({
      notificationUrl: "https://connect.example.test/api/teams-gateway/webhook",
      changeType: "created,updated",
    });

    graph.messages.push(inboundMessage("incoming-1", "2026-09-01T01:00:00.000Z", "Hello"));
    const listChatsCalls = graph.listChatsCalls;
    await expect(
      service.handleNotifications({
        value: [{ subscriptionId: subscription!.subscriptionId, clientState: "wrong" }],
      }),
    ).resolves.toBe(0);
    await expect(
      service.handleNotifications({
        value: [
          {
            subscriptionId: subscription!.subscriptionId,
            clientState: subscription!.clientState,
            resource: "chats('chat-1')/messages('incoming-1')",
          },
        ],
      }),
    ).resolves.toBe(1);
    await vi.waitFor(() => expect(graph.sent).toHaveLength(1));
    expect(graph.sent.map((item) => item.text)).toEqual(["Immediate reply"]);
    expect(graph.listChatsCalls).toBe(listChatsCalls);
  });

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

  it("keeps an enabled gateway agent online when Teams presence publishing is unavailable", async () => {
    const store = new MemoryTeamsGatewayStore();
    const graph = new FakeTeamsGraph([]);
    graph.presenceError = new Error("Presence publishing is forbidden.");
    const service = createService(store, graph, new FakeAgentChat([]));

    const created = await service.upsertAgent(undefined, {
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
    });

    expect(created.presence).toMatchObject({ status: "online", error: "Presence publishing is forbidden." });
    expect(await service.getMetrics()).toMatchObject([{ agentId: created.id, presence: "online" }]);
  });

  it("retries presence publishing after an earlier failure", async () => {
    const store = new MemoryTeamsGatewayStore([
      createAgent({
        presence: {
          status: "online",
          lastAttemptAt: "2026-09-01T01:00:00.000Z",
          error: "Presence publishing was forbidden.",
        },
      }),
    ]);
    const graph = new FakeTeamsGraph([]);
    const service = createService(store, graph, new FakeAgentChat([]));

    await service.pollNow();

    expect(graph.presenceSets).toBe(1);
    expect((await store.getAgent("agent-1"))?.presence).toEqual({
      status: "online",
      lastAttemptAt: "2026-09-01T02:00:00.000Z",
      lastSetAt: "2026-09-01T02:00:00.000Z",
    });
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

  it("suppresses its own message when Graph reports a different sender ID", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([
      {
        ...inboundMessage("echo-1", "2026-09-01T01:00:00.000Z", "This was sent by the agent."),
        senderId: "actual-agent-user-id",
        senderName: "Agent",
      },
    ]);
    graph.selfId = "stale-connection-profile-id";
    graph.chats = [
      {
        id: "chat-1",
        chatType: "oneOnOne",
        members: [
          { userId: "actual-agent-user-id", email: "agent@company.test", displayName: "Agent" },
          { userId: "person-user-id", email: "person@company.test", displayName: "Person" },
        ],
      },
    ];
    const chat = new FakeAgentChat([]);
    const service = createService(store, graph, chat);

    expect(await service.pollNow()).toMatchObject({ messages: 0, errors: 0 });
    expect(chat.inputs).toHaveLength(0);
    expect(await store.getThread("agent-1", "chat-1")).toMatchObject({ cursorMessageId: "echo-1" });
  });

  it("suppresses exact message IDs emitted through the gateway", async () => {
    const store = new MemoryTeamsGatewayStore([
      createAgent({ confirmBeforeTools: false, proactiveDmUsers: ["allowed@company.test"] }),
    ]);
    const graph = new FakeTeamsGraph([]);
    const chat = new FakeAgentChat([]);
    const service = createService(store, graph, chat);

    const sent = await service.sendProactiveMessage("agent-1", "allowed@company.test", "Gateway message");
    graph.messages.push({
      ...inboundMessage(sent.messageId!, "2026-09-01T02:01:00.000Z", "Gateway message"),
      senderId: "unexpected-sender-id",
    });
    graph.chats = [
      {
        id: sent.chatId,
        chatType: "oneOnOne",
        members: [
          { userId: "agent-user-id", email: "agent@company.test", displayName: "Agent" },
          { userId: "allowed-user-id", email: "allowed@company.test", displayName: "Allowed" },
        ],
      },
    ];

    expect(await service.pollNow()).toMatchObject({ messages: 0, errors: 0 });
    expect(chat.inputs).toHaveLength(0);
  });

  it("suppresses messages from every configured gateway agent", async () => {
    const store = new MemoryTeamsGatewayStore([
      createAgent({ id: "agent-1", teamsConnectionId: "teams-connection-1", confirmBeforeTools: false }),
      createAgent({ id: "agent-2", teamsConnectionId: "teams-connection-2", confirmBeforeTools: false }),
    ]);
    const graph = new FakeTeamsGraph([
      {
        ...inboundMessage("other-agent-message", "2026-09-01T01:00:00.000Z", "Agent status update"),
        senderId: "gateway-user-1",
      },
    ]);
    graph.contexts.set("teams-connection-1", { selfId: "gateway-user-1", selfEmail: "one@company.test" });
    graph.contexts.set("teams-connection-2", { selfId: "gateway-user-2", selfEmail: "two@company.test" });
    graph.chats = [
      {
        id: "group-chat-1",
        chatType: "group",
        topic: "Agent room",
        members: [
          { userId: "gateway-user-1", email: "one@company.test", displayName: "One" },
          { userId: "gateway-user-2", email: "two@company.test", displayName: "Two" },
          { userId: "person-user-id", email: "person@company.test", displayName: "Person" },
        ],
      },
    ];
    const chat = new FakeAgentChat([]);
    const service = createService(store, graph, chat);

    expect(await service.pollNow()).toMatchObject({ agents: 2, messages: 0, errors: 0 });
    expect(chat.inputs).toHaveLength(0);
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

  it("pauses provider work for a plan and continues after an authorized thumbs-up reaction", async () => {
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
    const service = createService(store, graph, chat, undefined, undefined, {
      publicOrigin: "https://connect.example.test",
    });

    await service.pollNow();
    expect(graph.sent[0]?.text).toContain("Plan: Check tomorrow's calendar");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toMatchObject({
      steps: ["Read tomorrow's events", "Summarize the schedule"],
      messageId: "sent-1",
    });
    expect(graph.sent[0]?.text).toContain("React 👍 to approve this plan");

    graph.reactions.set("sent-1", [{ reactionType: "like", userId: "person-user-id" }]);
    const subscription = (await store.listSubscriptions("agent-1")).find((item) => item.kind === "chat_messages");
    const listChatsCalls = graph.listChatsCalls;
    await service.handleNotifications({
      value: [
        {
          subscriptionId: subscription!.subscriptionId,
          clientState: subscription!.clientState,
          resource: "chats('chat-1')/messages('sent-1')",
        },
      ],
    });
    await vi.waitFor(() => expect(graph.sent.at(-1)?.text).toBe("Tomorrow has two meetings."));

    expect(graph.sent.at(-1)?.text).toBe("Tomorrow has two meetings.");
    expect(graph.listChatsCalls).toBe(listChatsCalls);
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toBeUndefined();
    expect((chat.inputs[1] as { messages: Array<{ role: string; content: string }> }).messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("approved this plan with a thumbs-up reaction"),
    });
    expect(chat.respondExtensions[1]?.systemPrompt).toContain("confirmed the current plan");
  });

  it("continues a pending plan when an authenticated inbox operator clicks thumbs up", async () => {
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
    const pendingThread = await store.getThread("agent-1", "chat-1");
    await service.approveOperatorPlan(pendingThread!.id, pendingThread!.pendingPlan!.messageId!);

    expect(graph.sent.at(-1)?.text).toBe("Tomorrow has two meetings.");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toBeUndefined();
    expect((chat.inputs[1] as { messages: Array<{ role: string; content: string }> }).messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("approved this plan with a thumbs-up reaction"),
    });
  });

  it("keeps the plan pending when a follow-up question arrives before the thumbs-up", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent()]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Escalate this blocker to Zeke."),
    ]);
    const chat = new FakeAgentChat([
      async (extension) => {
        const activity = await extension.runTool("propose_teams_plan", {
          summary: "Escalate the blocker",
          steps: ["Confirm Zeke's address", "Send the escalation"],
        });
        return completedResponse("Waiting for confirmation.", activity ? [activity] : []);
      },
      completedResponse("Not yet — the plan is still waiting for your thumbs-up."),
      completedResponse("The escalation was sent."),
    ]);
    const service = createService(store, graph, chat);

    await service.pollNow();
    graph.messages.push(inboundMessage("message-2", "2026-09-01T01:01:00.000Z", "Were you successful?"));
    await service.pollNow();

    expect(graph.sent.at(-1)?.text).toBe("Not yet — the plan is still waiting for your thumbs-up.");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toMatchObject({
      summary: "Escalate the blocker",
      messageId: "sent-1",
    });
    expect(chat.respondExtensions[1]?.systemPrompt).toContain("existing plan remains pending");

    graph.reactions.set("sent-1", [{ reactionType: "like", userId: "person-user-id" }]);
    await service.pollNow();

    expect(graph.sent.at(-1)?.text).toBe("The escalation was sent.");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toBeUndefined();
  });

  it("uses a written reply to replace the proposed plan", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent()]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Check tomorrow's calendar."),
    ]);
    const chat = new FakeAgentChat([
      async (extension) => {
        const activity = await extension.runTool("propose_teams_plan", {
          summary: "Check tomorrow's calendar",
          steps: ["Read all events", "Summarize the schedule"],
        });
        return completedResponse("Waiting for confirmation.", activity ? [activity] : []);
      },
      async (extension) => {
        const activity = await extension.runTool("propose_teams_plan", {
          summary: "Check customer meetings tomorrow",
          steps: ["Read tomorrow's events", "Keep customer meetings only", "Summarize them"],
        });
        return completedResponse("Updated the plan.", activity ? [activity] : []);
      },
    ]);
    const service = createService(store, graph, chat);

    await service.pollNow();
    graph.messages.push(inboundMessage("message-2", "2026-09-01T01:01:00.000Z", "Only include customer meetings."));
    await service.pollNow();

    expect(graph.sent.at(-1)?.text).toContain("Plan: Check customer meetings tomorrow");
    expect((await store.getThread("agent-1", "chat-1"))?.pendingPlan).toMatchObject({
      summary: "Check customer meetings tomorrow",
      messageId: "sent-2",
    });
    expect(chat.respondExtensions[1]?.systemPrompt).toContain("before any connected application access");
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

  it("keeps disabled group chats visible without reading or replying to them", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([]);
    graph.chats = [
      {
        id: "group-chat-1",
        chatType: "group",
        topic: "Do not monitor",
        members: [
          { userId: "agent-user-id", email: "agent@company.test", displayName: "Agent" },
          { userId: "person-user-id", email: "person@company.test", displayName: "Person" },
        ],
      },
    ];
    let now = new Date("2026-09-01T02:00:00.000Z");
    const chat = new FakeAgentChat([completedResponse("This is a new reply.")]);
    const service = createService(store, graph, chat, undefined, undefined, { now: () => now });

    await service.pollNow();
    const [detected] = await store.listGroups("agent-1");
    expect(detected).toMatchObject({ displayName: "Do not monitor", enabled: true });

    await service.setGroupEnabled(detected!.id, { enabled: false });
    graph.messages.push(inboundMessage("disabled-message", "2026-09-01T02:05:00.000Z", "Can you answer?"));
    expect(await service.pollNow()).toMatchObject({ chats: 0, messages: 0, errors: 0 });
    expect(chat.inputs).toEqual([]);
    expect(await store.getGroup(detected!.id)).toMatchObject({ enabled: false });

    now = new Date("2026-09-01T03:00:00.000Z");
    await service.setGroupEnabled(detected!.id, { enabled: true });
    expect(await service.pollNow()).toMatchObject({ messages: 0, errors: 0 });

    graph.messages.push(inboundMessage("new-message", "2026-09-01T03:01:00.000Z", "Can you answer now?"));
    expect(await service.pollNow()).toMatchObject({ messages: 1, errors: 0 });
    expect(graph.sent).toEqual([{ chatId: "group-chat-1", text: "This is a new reply." }]);
  });

  it("keeps a group disabled when Graph temporarily omits and rediscovers it", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([]);
    const groupChat: TeamsGatewayGraphChat = {
      id: "group-chat-1",
      chatType: "group",
      topic: "Stay silent",
      members: [
        { userId: "agent-user-id", email: "agent@company.test", displayName: "Agent" },
        { userId: "person-user-id", email: "person@company.test", displayName: "Person" },
      ],
    };
    graph.chats = [groupChat];
    const service = createService(store, graph, new FakeAgentChat([]));

    await service.pollNow();
    const [detected] = await store.listGroups("agent-1");
    await service.setGroupEnabled(detected!.id, { enabled: false });

    graph.chats = [];
    await service.pollNow();
    expect(await store.getGroup(detected!.id)).toMatchObject({ enabled: false });

    graph.chats = [groupChat];
    await service.pollNow();
    expect(await store.getGroup(detected!.id)).toMatchObject({ enabled: false });
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

  it("stops polling and subscribing to channels in a disabled Team", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([]);
    graph.chats = [];
    graph.teams = [{ id: "team-1", displayName: "Unrelated team" }];
    graph.channels = [{ id: "channel-1", displayName: "General" }];
    const service = createService(store, graph, new FakeAgentChat([]), undefined, undefined, {
      publicOrigin: "https://connect.example.test",
    });

    await service.pollNow();
    const [detected] = await store.listGroups("agent-1");
    expect((await store.listSubscriptions("agent-1")).map((item) => item.kind).sort()).toEqual([
      "channel_messages",
      "chat_messages",
      "team_channels",
    ]);

    await service.setGroupEnabled(detected!.id, { enabled: false });
    graph.channelThreads = [
      {
        root: inboundMessage("root-1", "2026-09-01T02:05:00.000Z", "Agent, reply here."),
        replies: [],
      },
    ];
    expect(await service.pollNow()).toMatchObject({ chats: 0, messages: 0, errors: 0 });
    expect(graph.channelReplies).toEqual([]);
    expect(await store.listSubscriptions("agent-1")).toMatchObject([{ kind: "chat_messages" }]);
  });

  it("does not overwrite a group toggle made during discovery", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([]);
    graph.chats = [];
    graph.teams = [{ id: "team-1", displayName: "Operations" }];
    graph.channels = [{ id: "channel-1", displayName: "General" }];
    const service = createService(store, graph, new FakeAgentChat([]));

    await service.pollNow();
    const [detected] = await store.listGroups("agent-1");
    let releaseChannels!: () => void;
    let markChannelsRequested!: () => void;
    const channelsRequested = new Promise<void>((resolve) => {
      markChannelsRequested = resolve;
    });
    graph.beforeListChannels = () =>
      new Promise<void>((resolve) => {
        releaseChannels = resolve;
        markChannelsRequested();
      });

    const polling = service.pollNow();
    await channelsRequested;
    await service.setGroupEnabled(detected!.id, { enabled: false });
    releaseChannels();
    await polling;

    expect(await store.getGroup(detected!.id)).toMatchObject({ enabled: false });
  });

  it("downloads incoming Teams attachments into the agent turn", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-with-file", "2026-09-01T01:00:00.000Z", "", [
        {
          id: "reference-1",
          kind: "reference",
          name: "../quarterly-report.txt",
          contentUrl: "https://tenant.sharepoint.com/quarterly-report.txt",
        },
      ]),
    ]);
    graph.attachmentFiles.set("reference-1", {
      name: "../quarterly-report.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("Revenue is on target."),
    });
    const chat = new FakeAgentChat([completedResponse("I reviewed the report.")]);
    const service = createService(store, graph, chat);

    expect(await service.pollNow()).toMatchObject({ messages: 1, errors: 0 });

    const thread = await store.getThread("agent-1", "chat-1");
    expect(thread?.messages[0]).toMatchObject({
      content: "Shared a file: quarterly-report.txt",
      attachments: [
        {
          id: "reference-1",
          fileId: "file-1",
          name: "quarterly-report.txt",
          mimeType: "text/plain",
        },
      ],
    });
    expect(chat.inputs[0]).toMatchObject({ messages: [{ attachments: [{ fileId: "file-1" }] }] });
  });

  it("lets an agent return a file into the current channel post thread", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: false })]);
    const graph = new FakeTeamsGraph([]);
    graph.chats = [];
    graph.teams = [{ id: "team-1", displayName: "Operations" }];
    graph.channels = [{ id: "channel-1", displayName: "General" }];
    graph.channelThreads = [
      {
        root: inboundMessage("root-1", "2026-09-01T01:00:00.000Z", "Send the prepared brief."),
        replies: [],
      },
    ];
    const files = new MemoryTransitFiles();
    const prepared = await files.create(new File(["Prepared brief"], "brief.txt", { type: "text/plain" }));
    const chat = new FakeAgentChat([
      async (extension) => {
        const activity = await extension.runTool("send_teams_attachment", {
          fileId: prepared.fileId,
          caption: "Here is the brief.",
        });
        expect(activity).toMatchObject({ ok: true, label: "Send Teams attachment" });
        return completedResponse("I sent the brief.", activity ? [activity] : []);
      },
    ]);
    const service = createService(store, graph, chat, new FakeApprovals(), files);

    expect(await service.pollNow()).toMatchObject({ messages: 1, errors: 0 });
    expect(graph.sentAttachments).toHaveLength(1);
    expect(graph.sentAttachments[0]).toMatchObject({ kind: "channel", rootMessageId: "root-1" });
    expect(graph.sentAttachments[0]?.file.name).toBe("brief.txt");
    await expect(graph.sentAttachments[0]?.file.text()).resolves.toBe("Prepared brief");
  });

  it("lets an agent discover an escalation recipient and call the Teams DM host tool directly", async () => {
    const store = new MemoryTeamsGatewayStore([
      createAgent({ confirmBeforeTools: false, proactiveDmUsers: ["zeke@company.test"] }),
    ]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Please escalate this blocker to Zeke."),
    ]);
    let extensionTools: string[] = [];
    let extensionPrompt = "";
    let recipients: Awaited<ReturnType<AgentChatExtension["runTool"]>>;
    let dmActivity: Awaited<ReturnType<AgentChatExtension["runTool"]>>;
    const chat = new FakeAgentChat([
      async (extension) => {
        extensionTools = extension.tools.map((tool) => tool.name);
        extensionPrompt = extension.systemPrompt;
        recipients = await extension.runTool("list_teams_dm_recipients", {});
        dmActivity = await extension.runTool("send_teams_dm", {
          recipientEmail: "zeke@company.test",
          text: "Clark needs approval for the account configuration.",
        });
        return completedResponse("I escalated the blocker to Zeke.", [recipients!, dmActivity!]);
      },
    ]);
    const service = createService(store, graph, chat);

    const result = await service.pollNow();
    expect(extensionTools).toEqual(expect.arrayContaining(["list_teams_dm_recipients", "send_teams_dm"]));
    expect(extensionPrompt).toContain("call propose_teams_plan, list_teams_dm_recipients, send_teams_dm");
    expect(recipients?.ok).toBe(true);
    const recipientOutput = recipients?.output as { recipients?: unknown[] } | undefined;
    expect(recipientOutput?.recipients).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: "zeke@company.test", source: "whitelist" })]),
    );
    expect(dmActivity).toMatchObject({ ok: true, label: "Send Teams DM" });
    expect(graph.sent).toEqual([
      { chatId: "created-chat", text: "Clark needs approval for the account configuration." },
      { chatId: "chat-1", text: "I escalated the blocker to Zeke." },
    ]);
    expect(result).toMatchObject({ messages: 1, errors: 0 });
  });

  it("keeps a proactive DM in context when the recipient replies with approval", async () => {
    const store = new MemoryTeamsGatewayStore([
      createAgent({ confirmBeforeTools: true, proactiveDmUsers: ["zeke@company.test"] }),
    ]);
    const graph = new FakeTeamsGraph([]);
    const chat = new FakeAgentChat([completedResponse("Thanks — I understand that you approved the proposal.")]);
    const service = createService(store, graph, chat);

    const sent = await service.sendProactiveMessage(
      "agent-1",
      "zeke@company.test",
      "Can you approve adding the external work account without an Entra join?",
    );
    graph.chats = [
      {
        id: sent.chatId,
        chatType: "oneOnOne",
        members: [
          { userId: "agent-user-id", email: "agent@company.test", displayName: "Agent" },
          { userId: "zeke-user-id", email: "zeke@company.test", displayName: "Zeke" },
        ],
      },
    ];
    graph.messages.push(inboundMessage("approval-reply", "2026-09-01T02:01:00.000Z", "approved"));

    await service.pollNow();

    expect((chat.inputs[0] as { messages: Array<{ role: string; content: string }> }).messages).toMatchObject([
      { role: "assistant", content: "Can you approve adding the external work account without an Entra join?" },
      { role: "user", content: "approved" },
    ]);
    expect(chat.respondExtensions[0]?.systemPrompt).toContain("they are answers to that message");
    const context = chat.respondExtensions[0]?.context as { recentTeamsMessages?: unknown[] } | undefined;
    expect(context?.recentTeamsMessages).toHaveLength(2);
  });

  it("lets the agent thumbs up the latest Teams message without a plan", async () => {
    const store = new MemoryTeamsGatewayStore([createAgent({ confirmBeforeTools: true })]);
    const graph = new FakeTeamsGraph([
      inboundMessage("message-1", "2026-09-01T01:00:00.000Z", "Here is the information you requested."),
    ]);
    const chat = new FakeAgentChat([
      async (extension) => {
        const activity = await extension.runTool("thumbs_up_teams_message", {});
        expect(activity).toMatchObject({ ok: true, label: "Thumbs up Teams message" });
        return completedResponse("Thank you.", activity ? [activity] : []);
      },
    ]);
    const service = createService(store, graph, chat);

    await service.pollNow();

    expect(graph.setReactions).toEqual([{ kind: "chat", messageId: "message-1", reactionType: "👍" }]);
    expect(graph.sent).toEqual([{ chatId: "chat-1", text: "Thank you." }]);
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
  files = new MemoryTransitFiles(),
  options: { publicOrigin?: string; now?: () => Date } = {},
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
    files,
    store,
    now: options.now ?? (() => new Date("2026-09-01T02:00:00.000Z")),
    timeZone: "Australia/Perth",
    publicOrigin: options.publicOrigin,
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

function inboundMessage(id: string, createdAt: string, text: string, attachments: TeamsGatewayGraphAttachment[] = []) {
  return { id, createdAt, senderId: "person-user-id", senderName: "Person", text, attachments };
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
  readonly inputs: unknown[] = [];
  readonly respondExtensions: AgentChatExtension[] = [];
  private readonly decisions: AgentChatDecision[];

  constructor(decisions: AgentChatDecision[]) {
    this.decisions = decisions;
  }

  async respondWithExtension(input: unknown, extension: AgentChatExtension): Promise<AgentChatResponse> {
    this.inputs.push(input);
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
  readonly reactions = new Map<string, Array<{ reactionType: string; userId: string }>>();
  readonly setReactions: Array<{ kind: "chat" | "channel"; messageId: string; reactionType: string }> = [];
  readonly contexts = new Map<string, { selfId: string; selfEmail: string }>();
  readonly attachmentFiles = new Map<string, TeamsGatewayGraphFile>();
  readonly sentAttachments: Array<{ kind: "chat" | "channel"; chatId?: string; rootMessageId?: string; file: File }> =
    [];
  readonly createdSubscriptions: Array<{
    notificationUrl: string;
    changeType: string;
    resource: string;
    expiresAt: string;
  }> = [];
  presenceSets = 0;
  listChatsCalls = 0;
  presenceError?: Error;
  beforeListChannels?: () => Promise<void>;
  subscriptionSequence = 0;
  selfId = "agent-user-id";
  selfEmail = "agent@company.test";

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

  async context(connectionId: string): Promise<TeamsGatewayGraphContext> {
    const identity = this.contexts.get(connectionId);
    return {
      selfId: identity?.selfId ?? this.selfId,
      selfEmail: identity?.selfEmail ?? this.selfEmail,
      presenceSessionId: "teams-app-id",
      deps: { accessToken: "token", fetcher: providerFetch },
    };
  }

  async listChats(): Promise<TeamsGatewayGraphChat[]> {
    this.listChatsCalls += 1;
    return this.chats.map((chat) => ({ ...chat, lastMessageAt: this.messages.at(-1)?.createdAt }));
  }

  async getChat(_context: TeamsGatewayGraphContext, chatId: string): Promise<TeamsGatewayGraphChat> {
    return (
      this.chats.find((chat) => chat.id === chatId) ?? {
        id: chatId,
        chatType: "oneOnOne",
        members: [
          { userId: this.selfId, email: this.selfEmail, displayName: "Agent" },
          { userId: "person-user-id", email: "person@company.test", displayName: "Person" },
        ],
      }
    );
  }

  async listJoinedTeams(): Promise<TeamsGatewayGraphTeam[]> {
    return this.teams;
  }

  async listChannels() {
    await this.beforeListChannels?.();
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

  async getChatMessage(_context: TeamsGatewayGraphContext, _chatId: string, messageId: string) {
    return this.messages.find((message) => message.id === messageId);
  }

  async getChannelMessage(_context: TeamsGatewayGraphContext, _teamId: string, _channelId: string, messageId: string) {
    return this.channelThreads.find((thread) => thread.root.id === messageId)?.root;
  }

  async getChannelReply(
    _context: TeamsGatewayGraphContext,
    _teamId: string,
    _channelId: string,
    _rootMessageId: string,
    replyId: string,
  ) {
    return this.listedChannelReplies.find((message) => message.id === replyId);
  }

  async getChatMessageReactions(_context: TeamsGatewayGraphContext, _chatId: string, messageId: string) {
    return this.reactions.get(messageId) ?? [];
  }

  async getChannelReplyReactions(
    _context: TeamsGatewayGraphContext,
    _teamId: string,
    _channelId: string,
    _rootMessageId: string,
    replyId: string,
  ) {
    return this.reactions.get(replyId) ?? [];
  }

  async setChatMessageReaction(
    _context: TeamsGatewayGraphContext,
    _chatId: string,
    messageId: string,
    reactionType: string,
  ): Promise<void> {
    this.setReactions.push({ kind: "chat", messageId, reactionType });
  }

  async setChannelMessageReaction(
    _context: TeamsGatewayGraphContext,
    _teamId: string,
    _channelId: string,
    _rootMessageId: string,
    replyId: string | undefined,
    reactionType: string,
  ): Promise<void> {
    this.setReactions.push({ kind: "channel", messageId: replyId ?? _rootMessageId, reactionType });
  }

  async downloadAttachment(
    _context: TeamsGatewayGraphContext,
    attachment: TeamsGatewayGraphAttachment,
  ): Promise<TeamsGatewayGraphFile> {
    const file = this.attachmentFiles.get(attachment.id);
    if (!file) throw new Error(`Attachment not found: ${attachment.id}`);
    return file;
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

  async sendChatAttachment(_context: TeamsGatewayGraphContext, chatId: string, file: File) {
    this.sentAttachments.push({ kind: "chat", chatId, file });
    return { id: `chat-file-${this.sentAttachments.length}`, name: file.name, webUrl: "https://example.test/file" };
  }

  async sendChannelReplyAttachment(
    _context: TeamsGatewayGraphContext,
    _teamId: string,
    _channelId: string,
    rootMessageId: string,
    file: File,
  ) {
    this.sentAttachments.push({ kind: "channel", rootMessageId, file });
    return {
      id: `channel-file-${this.sentAttachments.length}`,
      name: file.name,
      webUrl: "https://example.test/file",
    };
  }

  async createOneOnOneChat() {
    return { id: "created-chat" };
  }

  async createSubscription(
    _context: TeamsGatewayGraphContext,
    input: { notificationUrl: string; changeType: string; resource: string; expiresAt: string },
  ) {
    this.createdSubscriptions.push(input);
    return { id: `subscription-${++this.subscriptionSequence}`, resource: input.resource, expiresAt: input.expiresAt };
  }

  async renewSubscription(_context: TeamsGatewayGraphContext, subscriptionId: string, expiresAt: string) {
    return { id: subscriptionId, resource: "", expiresAt };
  }

  async deleteSubscription(): Promise<void> {}

  async setPresence(): Promise<void> {
    this.presenceSets += 1;
    if (this.presenceError) throw this.presenceError;
  }

  async clearPresence(): Promise<void> {}
}

class MemoryTransitFiles {
  readonly maxBytes = 25 * 1024 * 1024;
  private readonly files = new Map<string, File>();
  private sequence = 0;

  async create(file: File) {
    const fileId = `file-${++this.sequence}`;
    this.files.set(fileId, file);
    return {
      fileId,
      downloadUrl: `/v1/files/${fileId}`,
      sizeBytes: file.size,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
    };
  }

  async read(fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Transit file not found: ${fileId}`);
    return {
      file,
      sizeBytes: file.size,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
    };
  }
}

class MemoryTeamsGatewayStore implements ITeamsGatewayStore {
  private readonly agents = new Map<string, TeamsGatewayAgent>();
  private readonly threads = new Map<string, TeamsGatewayThread>();
  private readonly contacts = new Map<string, TeamsGatewayContact>();
  private readonly groups = new Map<string, TeamsGatewayGroup>();
  private readonly subscriptions = new Map<string, TeamsGatewaySubscription>();

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

  async getGroup(id: string): Promise<TeamsGatewayGroup | undefined> {
    return clone(this.groups.get(id));
  }

  async listGroups(agentId?: string): Promise<TeamsGatewayGroup[]> {
    return [...this.groups.values()]
      .filter((group) => !agentId || group.agentId === agentId)
      .map((group) => structuredClone(group));
  }

  async deleteMissingGroups(agentId: string, retainedIds: string[]): Promise<void> {
    const retained = new Set(retainedIds);
    for (const [id, group] of this.groups) {
      if (group.agentId === agentId && group.enabled !== false && !retained.has(id)) this.groups.delete(id);
    }
  }

  async setSubscription(subscription: TeamsGatewaySubscription): Promise<void> {
    this.subscriptions.set(subscription.sourceKey, structuredClone(subscription));
  }

  async getSubscriptionById(subscriptionId: string): Promise<TeamsGatewaySubscription | undefined> {
    return clone([...this.subscriptions.values()].find((item) => item.subscriptionId === subscriptionId));
  }

  async listSubscriptions(agentId?: string): Promise<TeamsGatewaySubscription[]> {
    return [...this.subscriptions.values()]
      .filter((subscription) => !agentId || subscription.agentId === agentId)
      .map((subscription) => structuredClone(subscription));
  }

  async deleteSubscription(sourceKey: string): Promise<void> {
    this.subscriptions.delete(sourceKey);
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
