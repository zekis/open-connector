import type { FeedItem, ProviderDefinition } from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FeedCard } from "./feed-page";

const provider: ProviderDefinition = {
  service: "outlook",
  displayName: "Outlook",
  categories: ["Communication"],
  authTypes: ["oauth2"],
  auth: [{ type: "oauth2", scopes: [] }],
  actions: [],
};

const item: FeedItem = {
  id: "flow:run-1",
  kind: "trigger",
  createdAt: "2026-08-14T01:00:00.000Z",
  updatedAt: "2026-08-14T01:05:00.000Z",
  title: "Roy Hill weekly update",
  summary: "The commissioning plan is ready for review.",
  author: "Mel Blanch",
  providerService: "outlook",
  previews: [
    {
      id: "email",
      kind: "email",
      name: "Roy Hill weekly update",
      summary: "The commissioning plan is ready for review.",
      contentUrl: "/api/feed/flow%3Arun-1/previews/email",
    },
    {
      id: "attachment-0",
      kind: "pdf",
      name: "Commissioning plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42_000,
      contentUrl: "/api/feed/flow%3Arun-1/previews/attachment-0",
    },
  ],
  flow: {
    id: "flow-1",
    name: "Archive project email",
    runId: "run-1",
    status: "waiting_for_approval",
    trigger: "new_email",
  },
  agentSummary: "Archived the source email and prepared a reply.",
  actions: [{ id: "step-1", actionId: "obsidian.create_note", status: "completed" }],
  comments: [
    {
      id: "comment-1",
      role: "user",
      content: "Please acknowledge it.",
      createdAt: "2026-08-14T01:04:00.000Z",
    },
  ],
  approvals: [
    {
      id: "approval-1",
      kind: "action",
      status: "pending",
      actionId: "outlook.send_message",
      connectionId: "outlook-1",
      input: { to: "mel@example.com" },
      requestedAt: "2026-08-14T01:05:00.000Z",
    },
  ],
  canReply: true,
};

describe("FeedCard", () => {
  it("renders trigger context, Claude updates, comments, and one-tap approval controls", () => {
    const html = renderToStaticMarkup(
      <FeedCard
        item={item}
        provider={provider}
        draft=""
        replyBusy={false}
        onDraftChange={() => {}}
        onDecision={async () => {}}
        onReply={async () => {}}
      />,
    );

    expect(html).toContain("Roy Hill weekly update");
    expect(html).toContain("Archived the source email and prepared a reply.");
    expect(html).toContain("Please acknowledge it.");
    expect(html).toContain("Open email");
    expect(html).toContain("Commissioning plan.pdf");
    expect(html).toContain("1 attachment");
    expect(html).toContain("Approve outlook.send_message");
    expect(html).toContain("Decide the pending request to continue");
    expect(html).toContain('class="provider-icon large"');
  });
});
