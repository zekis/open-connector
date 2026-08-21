import type { AppData, FlowDefinition } from "./model";
import type { ReactNode } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { FlowBuilderPage, flowToolSelectionKey } from "./flow-builder-page";
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
    expect(html).toContain('max="50"');
    expect(html).toContain('value="20"');
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
    expect(html).toContain("Triggers are managed separately");
    expect(html).toContain('href="/triggers"');
    expect(html).not.toContain("Start this Flow");
    expect(html).not.toContain(">Model<");
    expect(html).not.toContain("opus");
  });

  it("keeps persisted schedule settings out of the Flow editor", () => {
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

    expect(html).toContain("Triggers are managed separately");
    expect(html).not.toContain('value="0 9 * * 1-5"');
    expect(html).not.toContain('value="Australia/Perth"');
  });

  it("loads a Synapse canvas destination and removes destination connector permissions", () => {
    const canvasFlow: FlowDefinition = {
      ...flow,
      destinationConnectionId: undefined,
      destinationSynapseId: "synapse-1",
    };
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route
        path="/flows/:flowId/edit"
        element={<FlowBuilderPage data={{ ...editorData, flows: [canvasFlow] }} onRefresh={() => {}} />}
      />,
    );

    expect(html).toContain('<option value="existing_synapse" selected="">Existing canvas</option>');
    expect(html).toContain("Current canvas · synapse-1");
    expect(html).toContain("Canvas destination");
    expect(html).not.toContain("Destination permissions");
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
    expect(html).toContain("1 selected");
    expect(html).toContain("Add source");
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

  it("renders independent permission groups for multiple source connectors", () => {
    const multiSourceFlow: FlowDefinition = {
      ...flow,
      sourceConnectionId: undefined,
      sourceConnectionIds: ["outlook-1", "sharepoint-1"],
      tools: [
        { ...flow.tools[0]!, role: "source" },
        {
          actionId: "sharepoint.create_file",
          connectionId: "sharepoint-1",
          role: "source",
          approval: "always_allow",
        },
      ],
    };
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route
        path="/flows/:flowId/edit"
        element={<FlowBuilderPage data={{ ...editorData, flows: [multiSourceFlow] }} onRefresh={() => {}} />}
      />,
    );

    expect(html).toContain("2 selected");
    expect(html.match(/Source permissions/g)).toHaveLength(2);
    expect(html).toContain("zeke@example.com");
    expect(html).toContain("Projects");
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

  it("keeps source and destination grants independent when both use one connection", () => {
    const sameConnectionFlow: FlowDefinition = {
      ...flow,
      sourceConnectionId: "outlook-1",
      destinationConnectionId: "outlook-1",
      tools: [
        {
          actionId: "outlook.search_emails",
          connectionId: "outlook-1",
          role: "source",
          approval: "always_allow",
        },
        {
          actionId: "outlook.search_emails",
          connectionId: "outlook-1",
          role: "destination",
          approval: "require_approval",
        },
      ],
    };
    const html = renderBuilder(
      "/flows/flow-1/edit",
      <Route
        path="/flows/:flowId/edit"
        element={
          <FlowBuilderPage
            data={{ ...editorData, flows: [sameConnectionFlow], connections: [editorData.connections[0]!] }}
            onRefresh={() => {}}
          />
        }
      />,
    );

    expect(flowToolSelectionKey("source", "outlook-1", "outlook.search_emails")).not.toBe(
      flowToolSelectionKey("destination", "outlook-1", "outlook.search_emails"),
    );
    expect(html.match(/1\/1 allowed/g)).toHaveLength(2);
    expect(html).toContain('<option value="always_allow" selected="">Always allow</option>');
    expect(html).toContain('<option value="require_approval" selected="">Require approval</option>');
    expect(html).not.toContain("Connect at least two endpoint connections");
  });
});

function renderBuilder(path: string, route: ReactNode): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>{route}</Routes>
    </MemoryRouter>,
  );
}
