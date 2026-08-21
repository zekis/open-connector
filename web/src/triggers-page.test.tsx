import type { AppData, FlowDefinition, ProviderDefinition } from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { emptyData } from "./model";
import { TriggersPage } from "./triggers-page";

const outlook: ProviderDefinition = {
  service: "outlook",
  displayName: "Outlook",
  categories: ["Communication"],
  authTypes: ["oauth2"],
  auth: [{ type: "oauth2", scopes: [] }],
  events: [
    {
      id: "outlook.new_received_email",
      displayName: "New received email",
      description: "Runs when a new message appears in the Outlook inbox.",
      polling: {
        actionId: "outlook.list_messages",
        input: { mailFolderId: "inbox" },
        result: { kind: "records", collectionField: "messages", idFields: ["id"] },
      },
    },
    {
      id: "outlook.new_sent_email",
      displayName: "New sent email",
      description: "Runs when a new message appears in Outlook Sent Items.",
      polling: {
        actionId: "outlook.list_messages",
        input: { mailFolderId: "sentitems" },
        result: { kind: "records", collectionField: "messages", idFields: ["id"] },
      },
    },
  ],
  actions: [],
};

const flow: FlowDefinition = {
  id: "flow-1",
  revision: "revision-1",
  name: "Archive sent mail",
  status: "active",
  sourceConnectionId: "outlook-1",
  destinationConnectionId: "outlook-1",
  instructions: "Archive sent messages.",
  trigger: {
    type: "event",
    connectionId: "outlook-1",
    eventId: "outlook.new_sent_email",
    pollIntervalSeconds: 60,
  },
  agent: {
    provider: "claude_code",
    connectionId: "claude-1",
    model: "opus",
    reasoningEffort: "medium",
  },
  tools: [],
  maxSteps: 20,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const data: AppData = {
  ...emptyData,
  providers: [outlook],
  connections: [
    {
      id: "outlook-1",
      service: "outlook",
      connectionName: "work",
      authType: "oauth2",
      profile: { displayName: "zeke@example.com" },
      metadata: {},
    },
  ],
  flows: [flow],
};

describe("TriggersPage", () => {
  it("lists provider-declared events attached to existing Flows", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TriggersPage data={data} onRefresh={() => {}} />
      </MemoryRouter>,
    );

    expect(html).toContain("New sent email");
    expect(html).toContain("Archive sent mail");
    expect(html).toContain("zeke@example.com");
    expect(html).toContain("New trigger");
    expect(html).not.toContain("Mailbox query");
  });

  it("shows an empty state when every Flow is manual", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TriggersPage data={{ ...data, flows: [{ ...flow, trigger: { type: "manual" } }] }} onRefresh={() => {}} />
      </MemoryRouter>,
    );

    expect(html).toContain("No automatic triggers");
  });

  it("shows the selected event source for a multi-source Flow", () => {
    const multiSourceFlow: FlowDefinition = {
      ...flow,
      sourceConnectionId: undefined,
      sourceConnectionIds: ["outlook-1", "outlook-2"],
      trigger: {
        type: "event",
        connectionId: "outlook-2",
        eventId: "outlook.new_sent_email",
        pollIntervalSeconds: 60,
      },
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TriggersPage
          data={{
            ...data,
            flows: [multiSourceFlow],
            connections: [
              ...data.connections,
              {
                id: "outlook-2",
                service: "outlook",
                connectionName: "operations",
                authType: "oauth2",
                profile: { displayName: "operations@example.com" },
                metadata: {},
              },
            ],
          }}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("operations@example.com");
    expect(html).not.toContain("zeke@example.com");
  });
});
