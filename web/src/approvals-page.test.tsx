import type { ActionApproval, AppData, FlowApproval, FlowDefinition } from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ApprovalsPage } from "./approvals-page";
import { emptyData } from "./model";

const flow: FlowDefinition = {
  id: "flow-1",
  revision: "revision-1",
  name: "Daily inbox sync",
  status: "active",
  sourceConnectionId: "outlook-1",
  destinationConnectionId: "sharepoint-1",
  instructions: "Copy today's messages into a spreadsheet.",
  trigger: { type: "manual" },
  agent: {
    connectionId: "openai-1",
    model: "opus",
    reasoningEffort: "medium",
  },
  tools: [
    {
      actionId: "sharepoint.create_file",
      connectionId: "sharepoint-1",
      approval: "require_approval",
    },
  ],
  maxSteps: 8,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const approval: FlowApproval = {
  id: "approval-1",
  flowId: flow.id,
  runId: "run-1234567890",
  stepId: "step-1",
  status: "pending",
  actionId: "sharepoint.create_file",
  connectionId: "sharepoint-1",
  input: {
    siteId: "team-site",
    fileName: "daily-mail.xlsx",
  },
  requestedAt: "2026-07-30T08:30:00.000Z",
};

const actionApproval: ActionApproval = {
  id: "action-approval-1",
  status: "pending",
  actionId: approval.actionId,
  connectionId: "sharepoint-1",
  caller: "chat",
  input: {
    siteId: "team-site",
    fileName: "agent-mail.xlsx",
  },
  requestedAt: "2026-07-30T09:30:00.000Z",
};

const data: AppData = {
  ...emptyData,
  providers: [
    {
      service: "sharepoint",
      displayName: "SharePoint",
      categories: [],
      authTypes: ["oauth2"],
      auth: [{ type: "oauth2", scopes: [] }],
      actions: [
        {
          id: approval.actionId,
          service: "sharepoint",
          name: "Create file",
          description: "Create a file in a SharePoint document library.",
          requiredScopes: [],
          execution: {
            locallyExecutable: true,
            catalogOnly: false,
            requiredAuthTypes: ["oauth2"],
            noAuthRunnable: false,
            needsCredential: true,
          },
        },
      ],
    },
  ],
  connections: [
    {
      id: "sharepoint-1",
      service: "sharepoint",
      authType: "oauth2",
      configured: true,
      profile: {
        displayName: "Operations site",
      },
      metadata: {},
    },
  ],
  flows: [flow],
  flowApprovals: [approval],
};

describe("ApprovalsPage", () => {
  it("renders a pending request with exact action, connection, and payload details", () => {
    const html = renderPage(data);

    expect(html).toContain("Daily inbox sync");
    expect(html).toContain("SharePoint · Create file");
    expect(html).toContain("Operations site · sharepoint");
    expect(html).toContain("daily-mail.xlsx");
    expect(html).toContain("Approve and continue");
    expect(html).toContain("Deny request");
    expect(html).toContain('href="/flows/flow-1/edit"');
  });

  it("renders a clear mailbox when no requests are pending", () => {
    const html = renderPage(emptyData);

    expect(html).toContain("Approval inbox is clear");
    expect(html).toContain("Approval-gated connector requests and Flow tools will pause here");
  });

  it("renders direct agent requests with pause and resume guidance", () => {
    const html = renderPage({
      ...data,
      flowApprovals: [],
      actionApprovals: [actionApproval],
    });

    expect(html).toContain("Agent chat request");
    expect(html).toContain("SharePoint · Create file");
    expect(html).toContain("agent-mail.xlsx");
    expect(html).toContain("Approve and resume Chat");
    expect(html).toContain("resumes the waiting Chat automatically");
    expect(html).not.toContain("Review Flow");
  });

  it("runs one exact MCP request without authorizing a retry", () => {
    const html = renderPage({
      ...data,
      flowApprovals: [],
      actionApprovals: [{ ...actionApproval, caller: "mcp" }],
    });

    expect(html).toContain("Approve and run");
    expect(html).toContain("executes this exact connector action once");
    expect(html).toContain("No retry is authorized");
    expect(html).not.toContain("next retry");
    expect(html).not.toContain("15 minutes");
  });
});

function renderPage(runtimeData: AppData): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ApprovalsPage data={runtimeData} onRefresh={() => {}} />
    </MemoryRouter>,
  );
}
