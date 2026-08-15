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
        items: [
          {
            subject: "Roy Hill weekly update",
            bodyPreview: "The commissioning plan is ready for review.",
            from: { emailAddress: { name: "Mel Blanch", address: "mel@example.com" } },
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
      agentSummary: "Archived the project email in Obsidian.",
      actions: [{ actionId: "obsidian.create_note", status: "completed" }],
      canReply: true,
    });
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
      approvals: [{ id: approval.id, kind: "action" }],
      canReply: false,
    });
  });
});

function createService(
  store: IFeedStore,
  approvals: ActionApproval[],
  response: AgentChatResponse | undefined,
  respond = vi.fn(async () => response!),
): FeedService {
  return new FeedService({
    flows: {
      async listRuns() {
        return [detail.run];
      },
      async getRunDetail() {
        return structuredClone(detail);
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
