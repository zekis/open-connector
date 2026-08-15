import type { ProviderDefinition, SynapseArtifactNode, SynapseProviderNode, SynapseWorkspace } from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SynapseApprovalNodeCard, SynapseNodeCard, synapseApprovalItems } from "./synapse-page";

const provider: ProviderDefinition = {
  service: "outlook",
  displayName: "Outlook",
  categories: ["Communication"],
  authTypes: ["oauth2"],
  auth: [{ type: "oauth2", scopes: [] }],
  actions: [],
};

const providerNode: SynapseProviderNode = {
  id: "provider-1",
  kind: "provider",
  connectionId: "outlook-1",
  service: "outlook",
  title: "Outlook",
  instructions: "Find important messages for this branch.",
  position: { x: 100, y: 120 },
  createdAt: "2026-08-15T01:00:00.000Z",
  updatedAt: "2026-08-15T01:00:00.000Z",
};

const artifactNode: SynapseArtifactNode = {
  id: "artifact-1",
  kind: "artifact",
  artifactKind: "email",
  title: "New mining opportunity",
  summary: "A new opportunity arrived from the sales team.",
  externalUrl: "https://outlook.office.com/mail/message-1",
  position: { x: 430, y: 120 },
  createdAt: "2026-08-15T01:01:00.000Z",
  updatedAt: "2026-08-15T01:01:00.000Z",
};

describe("SynapseNodeCard", () => {
  it("renders a provider as a draggable source card", () => {
    const html = renderToStaticMarkup(
      <SynapseNodeCard
        node={providerNode}
        provider={provider}
        selected
        linking={false}
        onPointerDown={() => {}}
        onPointerMove={() => {}}
        onPointerUp={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("Provider source");
    expect(html).toContain("Find important messages for this branch.");
    expect(html).toContain('class="provider-icon large"');
    expect(html).toContain("translate(100px, 120px)");
  });

  it("renders an email artifact with its external source", () => {
    const html = renderToStaticMarkup(
      <SynapseNodeCard
        node={artifactNode}
        selected={false}
        linking
        onPointerDown={() => {}}
        onPointerMove={() => {}}
        onPointerUp={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(html).toContain("New mining opportunity");
    expect(html).toContain("A new opportunity arrived from the sales team.");
    expect(html).toContain("https://outlook.office.com/mail/message-1");
    expect(html).toContain("link-target");
  });

  it("projects a pending connector approval onto the canvas", () => {
    const workspace: SynapseWorkspace = {
      id: "synapse-1",
      name: "Sales research",
      nodes: [providerNode],
      edges: [],
      threads: [
        {
          nodeId: providerNode.id,
          pendingApprovalId: "approval-1",
          pendingMessageId: "message-1",
          updatedAt: "2026-08-15T01:02:00.000Z",
          messages: [
            {
              id: "message-1",
              role: "assistant",
              content: "Waiting for approval.",
              createdAt: "2026-08-15T01:02:00.000Z",
              toolActivity: [
                {
                  id: "activity-1",
                  type: "action",
                  label: "outlook.send_message",
                  ok: false,
                  actionId: "outlook.send_message",
                  connectionId: "outlook-1",
                  connectionDisplayName: "Sales inbox",
                  approvalId: "approval-1",
                  input: { subject: "Opportunity" },
                  output: { status: "pending_approval" },
                },
              ],
            },
          ],
        },
      ],
      createdAt: "2026-08-15T01:00:00.000Z",
      updatedAt: "2026-08-15T01:02:00.000Z",
    };

    const [item] = synapseApprovalItems(workspace);
    expect(item).toMatchObject({
      approvalId: "approval-1",
      nodeId: "provider-1",
      title: "outlook.send_message",
      connectionDisplayName: "Sales inbox",
    });

    const html = renderToStaticMarkup(<SynapseApprovalNodeCard item={item!} selected onSelect={() => {}} />);
    expect(html).toContain("Approval required");
    expect(html).toContain("approve or deny");
    expect(html).toContain("Sales inbox");
  });
});
