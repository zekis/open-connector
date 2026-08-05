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
      actions: [
        {
          id: "outlook.search_emails",
          service: "outlook",
          name: "Search emails",
          description: "Search Outlook messages.",
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
    {
      service: "sharepoint",
      displayName: "SharePoint",
      categories: [],
      authTypes: ["oauth2"],
      auth: [{ type: "oauth2", scopes: [] }],
      iconUrl: "https://example.com/sharepoint.svg",
      actions: [
        {
          id: "sharepoint.create_file",
          service: "sharepoint",
          name: "Create file",
          description: "Create a SharePoint file.",
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
    expect(html).toContain("Start this Flow");
    expect(html).toContain("API call");
    expect(html).toContain("Schedule");
    expect(html).toContain("New email");
    expect(html).toContain("File created");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain(">Model<");
    expect(html).not.toContain("opus");
  });

  it("renders persisted schedule settings", () => {
    const scheduleFlow: FlowDefinition = {
      ...flow,
      trigger: { type: "schedule", cron: "0 9 * * 1-5", timeZone: "Australia/Perth" },
    };
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route
        path="/flows/:flowId/edit"
        element={<FlowBuilderPage data={{ ...editorData, flows: [scheduleFlow] }} onRefresh={() => {}} />}
      />,
    );

    expect(html).toContain('value="0 9 * * 1-5"');
    expect(html).toContain('value="Australia/Perth"');
    expect(html).toContain("Five fields: minute, hour, day, month, weekday.");
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
    expect(html).toContain('aria-label="Choose source connector"');
    expect(html).toContain('aria-label="Choose destination connector"');
  });

  it("groups permissions under their source and destination connectors", () => {
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route path="/flows/:flowId/edit" element={<FlowBuilderPage data={editorData} onRefresh={() => {}} />} />,
    );

    const sourceIndex = html.indexOf("Source permissions");
    const sourceActionIndex = html.indexOf("Search emails");
    const destinationIndex = html.indexOf("Destination permissions");
    const destinationActionIndex = html.indexOf("Create file");
    expect(sourceIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeLessThan(sourceActionIndex);
    expect(sourceActionIndex).toBeLessThan(destinationIndex);
    expect(destinationIndex).toBeLessThan(destinationActionIndex);
    expect(html).toContain("1/1 allowed");
    expect(html).toContain("0/1 allowed");
  });

  it("shows the connector-wide default while preserving Flow overrides", () => {
    const inheritedFlow: FlowDefinition = {
      ...flow,
      tools: [{ ...flow.tools[0]!, approval: "inherit" }],
    };
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route
        path="/flows/:flowId/edit"
        element={
          <FlowBuilderPage
            data={{
              ...editorData,
              flows: [inheritedFlow],
              connectionPermissions: [
                {
                  connectionId: "outlook-1",
                  actionId: "outlook.search_emails",
                  approval: "require_approval",
                  updatedAt: "2026-08-05T00:00:00.000Z",
                },
              ],
            }}
            onRefresh={() => {}}
          />
        }
      />,
    );

    expect(html).toContain('<option value="inherit" selected="">Use connector default (Require approval)</option>');
    expect(html).toContain('<option value="always_allow">Always allow</option>');
  });
});

function renderBuilder(path: string, route: ReactNode): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{route}</Routes>
    </MemoryRouter>,
  );
}
