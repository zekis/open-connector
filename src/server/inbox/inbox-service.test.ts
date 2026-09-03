import type { ConnectionSummary } from "../../connection-service.ts";
import type { IActionRunner, RunActionInput } from "../actions/action-runner.ts";
import type { TeamsGatewayAgent, TeamsGatewayThread } from "../teams-gateway/teams-gateway-types.ts";

import { describe, expect, it, vi } from "vitest";
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
  updatedAt: "2026-09-02T01:00:00.000Z",
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
});

function createService(run: IActionRunner["run"]): InboxService {
  return new InboxService({
    connections: {
      async listConnections() {
        return [outlookConnection];
      },
    },
    actions: { run },
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
    },
    async getPolicySnapshot() {
      return new ActionPolicyService().createSnapshot();
    },
  });
}

function actionResult(output: unknown) {
  return {
    executionId: "execution-1",
    auditPersisted: true,
    result: { ok: true, output },
    connection: outlookConnection,
  };
}
