import type { ActionApproval } from "../approvals/connection-approval-types.ts";
import type { AgentChatResponse } from "../chat/agent-chat-types.ts";
import type { FlowRunDetail } from "../flows/flow-runner.ts";
import type { FeedThread, IFeedStore } from "./feed-types.ts";

import { describe, expect, it, vi } from "vitest";
import { FeedService } from "./feed-service.ts";

const detail: FlowRunDetail = {
  run: {
    id: "run-1",
    flowId: "flow-1",
    flowRevision: "revision-1",
    flowSnapshot: {
      id: "flow-1",
      revision: "revision-1",
      name: "Archive project email",
      status: "active",
      sourceConnectionId: "outlook-1",
      destinationConnectionId: "obsidian-1",
      instructions: "Archive the email.",
      trigger: { type: "new_email", connectionId: "outlook-1", pollIntervalSeconds: 60 },
      agent: {
        provider: "claude_code",
        connectionId: "claude-1",
        model: "opus",
        reasoningEffort: "medium",
      },
      tools: [],
      maxSteps: 20,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
    trigger: "new_email",
    triggerEvent: {
      type: "new_email",
      occurredAt: "2026-08-14T01:00:00.000Z",
      payload: {
        service: "outlook",
        connectionId: "outlook-1",
        items: [
          {
            id: "message-1",
            subject: "Roy Hill weekly update",
            bodyPreview: "The commissioning plan is ready for review.",
            from: { emailAddress: { name: "Mel Blanch", address: "mel@example.com" } },
            hasAttachments: true,
            webLink: "https://outlook.office.com/mail/deeplink/read/message-1",
            attachments: [
              {
                id: "attachment-1",
                name: "Commissioning plan.pdf",
                contentType: "application/pdf",
                size: 42_000,
                isInline: false,
              },
            ],
          },
        ],
      },
    },
    status: "completed",
    stepCount: 1,
    startedAt: "2026-08-14T01:00:00.000Z",
    updatedAt: "2026-08-14T01:00:02.000Z",
    completedAt: "2026-08-14T01:00:02.000Z",
    finalOutput: "Archived the project email in Obsidian.",
    feedPost: {
      text: "All sorted — the project email is in Obsidian — the commissioning plan is ready for a look.",
      image: {
        alt: "An illustrated email moving into a project notebook.",
        headline: "Ready for a look",
        motif: "message",
        palette: "violet",
      },
    },
  },
  steps: [
    {
      id: "step-1",
      runId: "run-1",
      sequence: 1,
      kind: "action",
      status: "completed",
      actionId: "obsidian.create_note",
      connectionId: "obsidian-1",
      startedAt: "2026-08-14T01:00:01.000Z",
      completedAt: "2026-08-14T01:00:02.000Z",
    },
  ],
  approvals: [],
};

describe("FeedService", () => {
  it("projects trigger evidence and Flow work into a conversational Feed post", async () => {
    const store = new MemoryFeedStore();
    const service = createService(store, [], completedResponse("I can help with that follow-up."));

    const page = await service.list();

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "flow:run-1",
      kind: "trigger",
      title: "Roy Hill weekly update",
      summary: "The commissioning plan is ready for review.",
      author: "Mel Blanch",
      providerService: "outlook",
      post: {
        text: "The project email is in Obsidian, the commissioning plan is ready for a look.",
        image: { headline: "Ready for a look", motif: "message", palette: "violet" },
      },
      previews: [
        expect.objectContaining({ id: "email", kind: "email", name: "Roy Hill weekly update" }),
        expect.objectContaining({ id: "attachment-0", kind: "pdf", name: "Commissioning plan.pdf" }),
      ],
      agentSummary: "Archived the project email in Obsidian.",
      actions: [{ actionId: "obsidian.create_note", status: "completed" }],
      canReply: true,
    });
  });

  it("projects manual Flow runs into the Feed and keeps their result available for follow-up", async () => {
    const manualDetail = structuredClone(detail);
    manualDetail.run.id = "run-manual";
    manualDetail.run.trigger = "manual";
    manualDetail.run.triggerEvent = undefined;
    manualDetail.run.flowSnapshot.name = "Sync project notes";
    manualDetail.run.flowSnapshot.instructions = "Compare Azure DevOps work items with the Obsidian project notes.";
    manualDetail.run.flowSnapshot.sourceConnectionId = "azure-devops-1";
    manualDetail.run.flowSnapshot.tools = [
      {
        actionId: "azure_devops.list_work_items",
        connectionId: "azure-devops-1",
        role: "source",
        approval: "always_allow",
      },
    ];
    manualDetail.run.finalOutput = "Updated the project notes with three changed work items.";
    manualDetail.run.feedPost = {
      text: "Project notes are caught up with the three work items that changed today.",
      image: {
        alt: "Three work item cards flowing into a shared project note.",
        headline: "Notes caught up",
        motif: "document",
        palette: "blue",
      },
    };
    const service = createService(new MemoryFeedStore(), [], completedResponse("Done."), undefined, undefined, [
      manualDetail,
    ]);

    const page = await service.list();

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "flow:run-manual",
      kind: "trigger",
      title: "Sync project notes",
      summary: "Compare Azure DevOps work items with the Obsidian project notes.",
      author: "Manual run",
      providerService: "azure_devops",
      post: {
        text: "Project notes are caught up with the three work items that changed today.",
        image: { headline: "Notes caught up", motif: "document", palette: "blue" },
      },
      agentSummary: "Updated the project notes with three changed work items.",
      flow: { trigger: "manual", status: "completed" },
      canReply: true,
    });
  });

  it("turns a verbose legacy Flow result into a short, natural Feed post", async () => {
    const legacyDetail = structuredClone(detail);
    legacyDetail.run.id = "run-legacy";
    legacyDetail.run.flowSnapshot.name = "2158 Daily — Granola meeting todos";
    delete legacyDetail.run.feedPost;
    legacyDetail.run.finalOutput =
      "2158 2026-08-23 Meeting todos (Granola, last 7 days) Stockpile Go/No Go Meeting — 2026-08-21 [ ] Prepare go-live plan and present to HIO on Monday 24th August — owner: Zeke — due 2026-08-24";
    const service = createService(new MemoryFeedStore(), [], completedResponse("Done."), undefined, undefined, [
      legacyDetail,
    ]);

    const page = await service.list();

    expect(page.items[0]?.post.text).toBe(
      "The Granola meeting todos update is ready. I pulled everything together for a quick look.",
    );
    expect(page.items[0]?.post.text).not.toContain("—");
    expect(page.items[0]?.post.image.headline).toBe("Granola meeting todos");
  });

  it("persists follow-up comments and links one-time Chat approvals to their Feed thread", async () => {
    const approval = createActionApproval();
    const store = new MemoryFeedStore();
    const respond = vi.fn(async () => waitingResponse(approval.id));
    const service = createService(store, [approval], undefined, respond);

    const item = await service.reply("flow:run-1", { content: "Send Mel a short acknowledgement." });

    expect(item.comments.map((comment) => comment.role)).toEqual(["user", "assistant"]);
    expect(item.approvals).toMatchObject([{ id: approval.id, kind: "action", status: "pending" }]);
    expect(respond).toHaveBeenCalledWith({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("Roy Hill weekly update") }),
        { role: "user", content: "Send Mel a short acknowledgement." },
      ]),
      voiceMode: false,
    });

    await service.recordApprovalResponse(approval.id, completedResponse("Acknowledgement sent to Mel."));
    await expect(store.getThread("flow:run-1")).resolves.toMatchObject({
      pendingApprovalId: undefined,
      comments: [
        { role: "user", content: "Send Mel a short acknowledgement." },
        { role: "assistant", content: "Acknowledgement sent to Mel." },
      ],
    });
  });

  it("shows unrelated pending connector approvals as standalone decision posts", async () => {
    const approval = createActionApproval();
    const service = createService(new MemoryFeedStore(), [approval], completedResponse("Done."));

    const page = await service.list();

    expect(page.items.find((item) => item.id === `approval:${approval.id}`)).toMatchObject({
      kind: "approval",
      previews: [],
      approvals: [{ id: approval.id, kind: "action" }],
      canReply: false,
    });
  });

  it("loads one attachment through its originating connection without exposing provider credentials", async () => {
    const actions = {
      run: vi.fn(async () => ({
        executionId: "execution-1",
        auditPersisted: true,
        result: {
          ok: true,
          output: {
            name: "Commissioning plan.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42_000,
            file: { fileId: "transit-1" },
            contentBase64: null,
          },
        },
      })),
    };
    const service = createService(new MemoryFeedStore(), [], completedResponse("Done."), undefined, actions);

    await expect(service.getPreview("flow:run-1", "attachment-0")).resolves.toMatchObject({
      name: "Commissioning plan.pdf",
      mimeType: "application/pdf",
      fileId: "transit-1",
    });
    expect(actions.run).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "outlook.download_attachment",
        connectionId: "outlook-1",
        input: { messageId: "message-1", attachmentId: "attachment-1" },
        caller: "web",
        approvalPolicy: "bypass",
      }),
    );
  });
});

function createService(
  store: IFeedStore,
  approvals: ActionApproval[],
  response: AgentChatResponse | undefined,
  respond = vi.fn(async () => response!),
  actions?: ConstructorParameters<typeof FeedService>[0]["actions"],
  runDetails: FlowRunDetail[] = [detail],
): FeedService {
  return new FeedService({
    flows: {
      async listRuns() {
        return runDetails.map((candidate) => structuredClone(candidate.run));
      },
      async getRunDetail(runId) {
        const match = runDetails.find((candidate) => candidate.run.id === runId);
        if (!match) throw new Error(`Unknown test run: ${runId}`);
        return structuredClone(match);
      },
      async listApprovals() {
        return [];
      },
    },
    approvals: {
      async listActionApprovals() {
        return structuredClone(approvals);
      },
    },
    agentChat: { respond },
    actions,
    store,
  });
}

function completedResponse(content: string): AgentChatResponse {
  return {
    status: "completed",
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      createdAt: "2026-08-14T01:05:00.000Z",
    },
    toolActivity: [],
  };
}

function waitingResponse(approvalId: string): AgentChatResponse {
  return {
    status: "waiting_for_approval",
    approvalId,
    message: {
      id: "waiting-comment",
      role: "assistant",
      content: "I need approval to send that message.",
      createdAt: "2026-08-14T01:04:00.000Z",
    },
    toolActivity: [],
  };
}

function createActionApproval(): ActionApproval {
  return {
    id: "approval-1",
    status: "pending",
    actionId: "outlook.send_message",
    connectionId: "outlook-1",
    caller: "chat",
    input: { to: "mel@example.com", subject: "Re: Roy Hill weekly update" },
    requestHash: "hash-1",
    requestedAt: "2026-08-14T01:04:00.000Z",
  };
}

class MemoryFeedStore implements IFeedStore {
  private readonly threads = new Map<string, FeedThread>();

  async setThread(thread: FeedThread): Promise<void> {
    this.threads.set(thread.id, structuredClone(thread));
  }

  async getThread(id: string): Promise<FeedThread | undefined> {
    return structuredClone(this.threads.get(id));
  }

  async listThreads(limit = 500): Promise<FeedThread[]> {
    return [...this.threads.values()].slice(0, limit).map((thread) => structuredClone(thread));
  }
}
