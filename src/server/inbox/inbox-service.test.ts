import type { ConnectionSummary } from "../../connection-service.ts";
import type { ProviderDefinition } from "../../core/types.ts";
import type { IActionRunner, RunActionInput } from "../actions/action-runner.ts";
import type { AgentChatExtension } from "../chat/agent-chat-service.ts";
import type { TeamsGatewayAgent, TeamsGatewayThread } from "../teams-gateway/teams-gateway-types.ts";
import type { InboxConversationMetadata, IInboxStore } from "./inbox-types.ts";

import { describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ActionPolicyService } from "../../core/action-policy.ts";
import { InboxService } from "./inbox-service.ts";

const outlookConnection: ConnectionSummary = {
  id: "outlook-connection-1",
  service: "outlook",
  connectionName: "work",
  authType: "oauth2",
  configured: true,
  virtual: false,
  default: true,
  profile: {
    accountId: "outlook-user-1",
    displayName: "operator@example.com",
    grantedScopes: ["Mail.ReadWrite", "Mail.Send"],
  },
};

const todoConnection: ConnectionSummary = {
  ...outlookConnection,
  id: "todo-connection-1",
  service: "microsoft_todo",
  connectionName: "work-tasks",
};

const devopsConnection: ConnectionSummary = {
  ...outlookConnection,
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
  it("combines Teams gateway threads and Outlook conversations newest first", async () => {
    const run = vi.fn(async (input: RunActionInput) =>
      actionResult(
        input.actionId === "outlook.list_messages"
          ? {
              messages: [
                {
                  id: "outlook-message-1",
                  conversationId: "conversation-1",
                  subject: "Quarterly report",
                  bodyPreview: "The report is ready.",
                  receivedDateTime: "2026-09-03T01:00:00.000Z",
                  from: { emailAddress: { name: "Morgan", address: "morgan@example.com" } },
                  toRecipients: [{ emailAddress: { name: "Operator", address: "operator@example.com" } }],
                  isRead: false,
                  hasAttachments: false,
                },
              ],
              nextLink: null,
            }
          : {},
      ),
    );
    const service = createService(run);

    const page = await service.list();

    expect(page.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "microsoft_teams", displayName: "Project agent" }),
        expect.objectContaining({ provider: "outlook", accountLabel: "operator@example.com" }),
      ]),
    );
    expect(page.conversations.map((conversation) => conversation.provider)).toEqual(["outlook", "microsoft_teams"]);
    expect(page.conversations[0]).toMatchObject({ title: "Quarterly report", unread: true });
    expect(page.conversations[1]?.updatedAt).toBe("2026-09-02T01:00:00.000Z");
  });

  it("tracks unread Teams conversations until the operator opens them", async () => {
    const store = new MemoryInboxStore();
    const run = vi.fn(async () => actionResult({ messages: [], nextLink: null }));
    const service = createService(run, store);

    const initial = await service.list();
    const teamsConversation = initial.conversations.find((item) => item.provider === "microsoft_teams")!;
    expect(teamsConversation.unread).toBe(true);

    await service.markRead(teamsConversation.id);

    const refreshed = await service.list();
    expect(refreshed.conversations.find((item) => item.provider === "microsoft_teams")?.unread).toBe(false);
  });

  it("sends an Outlook attachment reply through a draft before sending", async () => {
    const actions: string[] = [];
    const run = vi.fn(async (input: RunActionInput) => {
      actions.push(input.actionId);
      if (input.actionId === "outlook.create_reply_draft") return actionResult({ id: "draft-1" });
      if (input.actionId === "outlook.list_messages") {
        return actionResult({
          messages: [
            {
              id: "outlook-message-1",
              conversationId: "conversation-1",
              subject: "Quarterly report",
              body: { contentType: "text", content: "The report is ready." },
              bodyPreview: "The report is ready.",
              receivedDateTime: "2026-09-03T01:00:00.000Z",
              from: { emailAddress: { name: "Morgan", address: "morgan@example.com" } },
              toRecipients: [{ emailAddress: { name: "Operator", address: "operator@example.com" } }],
              isRead: true,
              hasAttachments: false,
            },
          ],
          nextLink: null,
        });
      }
      return actionResult({ success: true });
    });
    const service = createService(run);
    const conversationId = (await service.list()).conversations.find((item) => item.provider === "outlook")!.id;
    actions.length = 0;

    await service.reply(conversationId, {
      text: "Thanks, attached.",
      attachments: [{ fileId: "transit-1", name: "notes.txt" }],
    });

    expect(actions).toEqual([
      "outlook.create_reply_draft",
      "outlook.add_attachment",
      "outlook.send_draft",
      "outlook.list_messages",
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "outlook.add_attachment",
        approvalPolicy: "bypass",
        input: { messageId: "draft-1", file: { fileId: "transit-1", name: "notes.txt" } },
      }),
    );
  });

  it("replies to the specific Outlook message selected from the timeline", async () => {
    const run = vi.fn(async (input: RunActionInput) => {
      if (input.actionId !== "outlook.list_messages") return actionResult({ success: true });
      return actionResult({
        messages: [
          {
            id: "outlook-message-older",
            conversationId: "conversation-1",
            subject: "Quarterly report",
            bodyPreview: "Can you review this?",
            receivedDateTime: "2026-09-02T01:00:00.000Z",
            from: { emailAddress: { name: "Morgan", address: "morgan@example.com" } },
            toRecipients: [{ emailAddress: { name: "Operator", address: "operator@example.com" } }],
            isRead: true,
            hasAttachments: false,
          },
          {
            id: "outlook-message-latest",
            conversationId: "conversation-1",
            subject: "Quarterly report",
            bodyPreview: "One more detail.",
            receivedDateTime: "2026-09-03T01:00:00.000Z",
            from: { emailAddress: { name: "Morgan", address: "morgan@example.com" } },
            toRecipients: [{ emailAddress: { name: "Operator", address: "operator@example.com" } }],
            isRead: true,
            hasAttachments: false,
          },
        ],
        nextLink: null,
      });
    });
    const service = createService(run);
    const conversationId = (await service.list()).conversations.find((item) => item.provider === "outlook")!.id;

    await service.reply(conversationId, {
      text: "Reviewed.",
      targetMessageId: "outlook-message-older",
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "outlook.reply_email",
        input: { messageId: "outlook-message-older", comment: "Reviewed." },
      }),
    );
  });

  it("preserves useful formatting from an Outlook HTML unique body", async () => {
    const calls: RunActionInput[] = [];
    const run = vi.fn(async (input: RunActionInput) => {
      calls.push(input);
      return actionResult({
        messages: [
          {
            id: "outlook-message-1",
            conversationId: "conversation-1",
            subject: "Formatted update",
            body: { contentType: "html", content: "<p>Quoted thread that should not be repeated.</p>" },
            uniqueBody: {
              contentType: "html",
              content:
                '<table><tr><td></td><td></td></tr></table><h2>Update</h2><p>Hello <strong>team</strong>.</p><ul><li>First item</li><li>Second item</li></ul><p><a href="https://example.com/report">Open report</a></p><p>[&lt;!--unsubscribe%20url--&gt;]Unsubscribe from this digest</p><p>Disclaimer: This message may contain confidential information.</p>',
            },
            bodyPreview: "Update Hello team.",
            receivedDateTime: "2026-09-03T01:00:00.000Z",
            from: { emailAddress: { name: "Morgan", address: "morgan@example.com" } },
            toRecipients: [{ emailAddress: { name: "Operator", address: "operator@example.com" } }],
            isRead: true,
            hasAttachments: false,
          },
        ],
        nextLink: null,
      });
    });
    const service = createService(run);
    const conversationId = (await service.list()).conversations.find((item) => item.provider === "outlook")!.id;

    const conversation = await service.get(conversationId);

    expect(conversation.messages[0]?.content).toContain("## Update");
    expect(conversation.messages[0]?.content).toContain("Hello **team**.");
    expect(conversation.messages[0]?.content).toContain("- First item");
    expect(conversation.messages[0]?.content).toContain("[Open report](https://example.com/report)");
    expect(conversation.messages[0]?.content).toContain("Unsubscribe from this digest");
    expect(conversation.messages[0]?.content).toContain(
      "> **Disclaimer:** This message may contain confidential information.",
    );
    expect(conversation.messages[0]?.content).not.toMatch(/^\s*\|/mu);
    expect(conversation.messages[0]?.content).not.toContain("<!--unsubscribe");
    expect(conversation.messages[0]?.content).not.toContain("Quoted thread");
    expect(calls.at(-1)?.input).toMatchObject({
      bodyContentType: "html",
      select: expect.arrayContaining(["body", "uniqueBody"]),
    });
  });

  it("keeps workflow state and private notes separate from provider messages", async () => {
    const store = new MemoryInboxStore();
    const run = vi.fn(async () => actionResult({ messages: [] }));
    const service = createService(run, store);
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
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("finds Microsoft To Do tasks that reference an Outlook email ID", async () => {
    const run = vi.fn(async (input: RunActionInput) => {
      if (input.actionId === "microsoft_todo.list_task_lists") {
        return actionResult({ taskLists: [{ id: "list-1", displayName: "Tasks" }], nextLink: null });
      }
      if (input.actionId === "microsoft_todo.list_tasks") {
        return actionResult({
          tasks: [
            {
              id: "task-1",
              title: "Reply to Morgan",
              body: { content: "Source email: &lt;internet-message-1@example.com&gt;" },
              status: "notStarted",
              importance: "high",
              linkedResources: [
                {
                  externalId: "outlook-message-1",
                  webUrl: "https://outlook.office.com/mail/inbox/id/outlook-message-1",
                },
              ],
            },
            { id: "task-2", title: "Unrelated", body: { content: "Another email" }, status: "completed" },
          ],
          nextLink: null,
        });
      }
      return actionResult({
        messages: [
          {
            id: "outlook-message-1",
            conversationId: "conversation-1",
            internetMessageId: "<internet-message-1@example.com>",
            subject: "Quarterly report",
            bodyPreview: "The report is ready.",
            receivedDateTime: "2026-09-03T01:00:00.000Z",
            from: { emailAddress: { name: "Morgan", address: "morgan@example.com" } },
            toRecipients: [{ emailAddress: { name: "Operator", address: "operator@example.com" } }],
            isRead: true,
            hasAttachments: false,
          },
        ],
        nextLink: null,
      });
    });
    const service = createService(run, new MemoryInboxStore(), [outlookConnection, todoConnection]);
    const conversationId = (await service.list()).conversations.find((item) => item.provider === "outlook")!.id;

    const result = await service.listLinkedTasks(conversationId);

    expect(result).toEqual({
      available: true,
      errors: [],
      tasks: [
        expect.objectContaining({
          id: "task-1",
          taskListName: "Tasks",
          title: "Reply to Morgan",
          sourceUrl: "https://outlook.office.com/mail/inbox/id/outlook-message-1",
        }),
      ],
    });
  });

  it("runs a message handoff with one exact connection and stores the AI result inline", async () => {
    const handoffs: HandoffCall[] = [];
    const service = createService(
      vi.fn(async () => actionResult({ messages: [] })),
      new MemoryInboxStore(),
      [outlookConnection, devopsConnection],
      {
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
      },
    );
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
});

interface HandoffCall {
  request: unknown;
  extension: AgentChatExtension;
}

function createService(
  run: IActionRunner["run"],
  store: IInboxStore = new MemoryInboxStore(),
  connections: ConnectionSummary[] = [outlookConnection],
  agentChat: ConstructorParameters<typeof InboxService>[0]["agentChat"] = {
    async respondWithExtension() {
      throw new Error("Unexpected AI handoff.");
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
    actions: { run },
    agentChat,
    teamsGateway: {
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
    },
    async getPolicySnapshot() {
      return new ActionPolicyService().createSnapshot();
    },
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

function actionResult(output: unknown) {
  return {
    executionId: "execution-1",
    auditPersisted: true,
    result: { ok: true, output },
    connection: outlookConnection,
  };
}
