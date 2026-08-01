import type { AppData, FlowDefinition } from "./model";
import type { ReactNode } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { FlowBuilderPage } from "./flow-builder-page";
import { emptyData } from "./model";

const flow: FlowDefinition = {
  id: "flow-1",
  revision: "revision-1",
  name: "Daily inbox sync",
  status: "paused",
  sourceConnectionId: "outlook-1",
  destinationConnectionId: "sharepoint-1",
  instructions: "Copy today's messages into a spreadsheet.",
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

const editorData: AppData = {
  ...emptyData,
  flows: [flow],
  providers: [
    {
      service: "outlook",
      displayName: "Outlook",
      categories: [],
      authTypes: ["oauth2"],
      auth: [{ type: "oauth2", scopes: [] }],
      iconUrl: "https://example.com/outlook.svg",
      actions: [],
    },
    {
      service: "sharepoint",
      displayName: "SharePoint",
      categories: [],
      authTypes: ["oauth2"],
      auth: [{ type: "oauth2", scopes: [] }],
      iconUrl: "https://example.com/sharepoint.svg",
      actions: [],
    },
  ],
  connections: [
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
      profile: { displayName: "Projects" },
      metadata: {},
    },
  ],
  agentConnections: [
    {
      id: "claude-subscription-1",
      provider: "claude_code",
      authType: "subscription_oauth",
      configured: true,
      displayName: "Claude Code",
    },
  ],
};

describe("FlowBuilderPage", () => {
  it("renders a dedicated create route", () => {
    const html = renderBuilder(
      "/flows/new",
      <Route path="/flows/new" element={<FlowBuilderPage data={emptyData} onRefresh={() => {}} />} />,
    );

    expect(html).toContain("Create a Flow");
    expect(html).toContain("Back to Flows");
    expect(html).toContain("Connect a Claude subscription from the Agents panel");
    expect(html).not.toContain("Codex");
  });

  it("loads an existing Flow on its edit route", () => {
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route path="/flows/:flowId/edit" element={<FlowBuilderPage data={editorData} onRefresh={() => {}} />} />,
    );

    expect(html).toContain("Edit Daily inbox sync");
    expect(html).toContain('value="Daily inbox sync"');
    expect(html).toContain("Copy today&#x27;s messages into a spreadsheet.");
    expect(html).toContain("Save changes");
    expect(html).not.toContain(">Model<");
    expect(html).not.toContain("opus");
  });

  it("lays out provider connectors around the Flow instructions", () => {
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route path="/flows/:flowId/edit" element={<FlowBuilderPage data={editorData} onRefresh={() => {}} />} />,
    );

    const sourceIndex = html.indexOf("Source connector");
    const instructionsIndex = html.indexOf("Agent instructions");
    const destinationIndex = html.indexOf("Destination connector");
    expect(sourceIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeLessThan(instructionsIndex);
    expect(instructionsIndex).toBeLessThan(destinationIndex);
    expect(html).toContain("flow-direction-track");
    expect(html).toContain("https://example.com/outlook.svg");
    expect(html).toContain("https://example.com/sharepoint.svg");
  });
});

function renderBuilder(path: string, route: ReactNode): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{route}</Routes>
    </MemoryRouter>,
  );
}
