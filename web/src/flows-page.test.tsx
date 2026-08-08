import type { FlowApproval, FlowDefinition, ProviderDefinition } from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { FlowsPage } from "./flows-page";
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
    provider: "claude_code",
    connectionId: "claude-subscription-1",
    model: "opus",
    reasoningEffort: "medium",
  },
  tools: [
    {
      actionId: "outlook.search_emails",
      connectionId: "outlook-1",
      approval: "always_allow",
    },
  ],
  maxSteps: 8,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const approval: FlowApproval = {
  id: "approval-1",
  flowId: flow.id,
  runId: "run-1",
  stepId: "step-1",
  status: "pending",
  actionId: "outlook.search_emails",
  connectionId: "outlook-1",
  input: { received: "today" },
  requestedAt: "2026-07-30T01:00:00.000Z",
};

const providers: ProviderDefinition[] = [
  provider("outlook", "Outlook", "https://www.microsoft.com/microsoft-365/outlook/outlook-for-business"),
  provider("sharepoint", "SharePoint", "https://www.microsoft.com/microsoft-365/sharepoint/collaboration"),
];

describe("FlowsPage", () => {
  it("renders a list with links to separate create and edit builders", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FlowsPage
          data={{ ...emptyData, providers, connections, flows: [flow], flowApprovals: [approval] }}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Daily inbox sync");
    expect(html).toContain('href="/flows/new"');
    expect(html).toContain('href="/flows/flow-1/edit"');
    expect(html).not.toContain("flow-builder-form");
    expect(html).not.toContain("Approve and continue");
    expect(html).not.toContain("Waiting for approval");
    expect(html).not.toContain("opus");
    expect(html).not.toContain("Codex");
    expect(html).toContain("Manual");
    expect(html).toContain("Source");
    expect(html).toContain("Destination");
    expect(html).toContain("Outlook");
    expect(html).toContain("SharePoint");
    expect(html.match(/class="provider-icon large"/g) ?? []).toHaveLength(2);
    expect(html).toContain("Flows from source to destination");
  });
});

const connections = [
  {
    id: "outlook-1",
    service: "outlook",
    connectionName: "work",
    authType: "oauth2",
    profile: { displayName: "zeke@example.com" },
    metadata: {},
  },
  {
    id: "sharepoint-1",
    service: "sharepoint",
    connectionName: "projects",
    authType: "oauth2",
    profile: { displayName: "SGC Projects" },
    metadata: {},
  },
];

function provider(service: string, displayName: string, homepageUrl: string): ProviderDefinition {
  return {
    service,
    displayName,
    categories: [],
    authTypes: ["oauth2"],
    auth: [{ type: "oauth2", scopes: [] }],
    homepageUrl,
    actions: [],
  };
}
