import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { applyApprovalResult, approvalIdFromToolActivity, ChatPage, ChatToolActivityList } from "./chat-page";
import { emptyData } from "./model";

describe("ChatPage", () => {
  it("shows configured Claude and the actions from connected applications", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChatPage
          data={{
            ...emptyData,
            providers: [
              {
                service: "example",
                displayName: "Example",
                categories: ["Developer Tools"],
                authTypes: ["api_key"],
                auth: [{ type: "api_key" }],
                actions: [
                  {
                    id: "example.lookup",
                    service: "example",
                    name: "lookup",
                    description: "Look up a record.",
                    requiredScopes: [],
                    execution: {
                      locallyExecutable: true,
                      catalogOnly: false,
                      requiredAuthTypes: ["api_key"],
                      noAuthRunnable: false,
                      needsCredential: true,
                    },
                  },
                ],
              },
            ],
            connections: [
              {
                id: "connection-1",
                service: "example",
                connectionName: "default",
                authType: "api_key",
                configured: true,
                virtual: false,
                default: true,
                profile: { displayName: "Example account" },
                metadata: {},
              },
            ],
            agentConnections: [
              {
                id: "claude-subscription",
                provider: "claude_code",
                authType: "subscription_oauth",
                configured: true,
                displayName: "Claude subscription",
              },
            ],
          }}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Claude is ready");
    expect(html).toContain("1 connected application · 1 available action");
    expect(html).toContain("What can I help you with?");
    expect(html).toContain("Summarize today&#x27;s important emails.");
    expect(html).toContain('aria-label="Message Claude"');
    expect(html).not.toContain("Set up Claude to start chatting");
  });

  it("directs an unconfigured runtime to Agent setup", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChatPage data={emptyData} onRefresh={() => {}} />
      </MemoryRouter>,
    );

    expect(html).toContain("Agent setup required");
    expect(html).toContain("Connect your agent");
    expect(html).toContain('href="/agents"');
    expect(html).toContain("Set up Claude to start chatting");
    expect(html).toContain("disabled");
  });

  it("recognizes an approval queued by a connector action", () => {
    expect(
      approvalIdFromToolActivity({
        id: "activity-1",
        type: "action",
        label: "Send email",
        ok: false,
        actionId: "outlook.send_email",
        connectionId: "connection-1",
        approvalId: "approval-1",
        input: { subject: "Hello" },
        output: {
          error: {
            code: "approval_required",
            message: "Approval is required.",
            details: { approvalId: "approval-1" },
          },
        },
      }),
    ).toBe("approval-1");
  });

  it("shows one inline decision surface for the active Chat approval", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChatToolActivityList
          activities={[
            {
              id: "activity-1",
              type: "action",
              label: "Send email",
              ok: false,
              actionId: "outlook.send_email",
              connectionId: "connection-1",
              approvalId: "approval-1",
              input: { subject: "Hello" },
              output: { error: { code: "approval_required", message: "Approval is required." } },
            },
          ]}
          activeApprovalId="approval-1"
          approvalDecision={null}
          onApprovalDecision={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Waiting for approval");
    expect(html).toContain("Approve and continue");
    expect(html).toContain(">Deny<");
    expect(html).toContain('class="chat-tool-call pending"');
    expect(html).not.toContain('class="chat-tool-call failed"');
    expect(html).toContain('href="/approvals"');
    expect(html).toContain('target="_blank"');
  });

  it("replaces a waiting message when the approved Chat resumes", () => {
    const resumed = applyApprovalResult(
      {
        messages: [
          {
            id: "waiting-message",
            role: "assistant",
            content: "Chat is paused for approval.",
            createdAt: "2026-08-06T01:00:00.000Z",
          },
        ],
        pendingApproval: { approvalId: "approval-1", assistantMessageId: "waiting-message" },
      },
      {
        approvalId: "approval-1",
        status: "consumed",
        response: {
          status: "completed",
          message: {
            id: "completed-message",
            role: "assistant",
            content: "Email sent.",
            createdAt: "2026-08-06T01:01:00.000Z",
          },
          toolActivity: [],
        },
      },
    );

    expect(resumed.pendingApproval).toBeUndefined();
    expect(resumed.messages).toEqual([expect.objectContaining({ id: "completed-message", content: "Email sent." })]);
  });
});
