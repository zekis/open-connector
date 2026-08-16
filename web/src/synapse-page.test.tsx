import type {
  AgentChatProgress,
  ProviderDefinition,
  SynapseArtifactNode,
  SynapseProviderNode,
  SynapseWorkspace,
} from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  fitCanvasView,
  appendSynapseUserMessage,
  mergeSynapseProgress,
  panNodeIntoView,
  SynapseApprovalNodeCard,
  SynapseNodeCard,
  synapseNodeSpeech,
  synapseApprovalItems,
  zoomCanvasView,
} from "./synapse-page";

describe("mergeSynapseProgress", () => {
  it("replaces a running tool call with its completed result without losing other calls", () => {
    const first: AgentChatProgress = {
      id: "call-1",
      phase: "tool_started",
      message: "Running query",
      speech: "Running query",
      tool: { id: "call-1", name: "run_connector_action", type: "action", label: "query", input: {} },
    };
    const second: AgentChatProgress = {
      id: "call-2",
      phase: "tool_started",
      message: "Running another query",
      speech: "Running another query",
    };
    const completed: AgentChatProgress = {
      ...first,
      phase: "tool_completed",
      message: "Query complete",
      tool: {
        ...first.tool!,
        activity: { id: "activity-1", type: "action", label: "query", ok: true, input: {}, output: {} },
      },
    };

    const result = mergeSynapseProgress(mergeSynapseProgress([first], second), completed);

    expect(result).toEqual([completed, second]);
  });
});

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
  content: "**Priority:** review the [sales brief](https://example.com/brief).",
  externalUrl: "https://outlook.office.com/mail/message-1",
  position: { x: 430, y: 120 },
  size: { width: 420, height: 280 },
  previews: [
    {
      id: "email",
      kind: "email",
      name: "New mining opportunity",
      contentUrl: "/api/synapses/synapse-1/nodes/artifact-1/previews/email",
    },
    {
      id: "attachment-0",
      kind: "pdf",
      name: "Sales brief.pdf",
      mimeType: "application/pdf",
      contentUrl: "/api/synapses/synapse-1/nodes/artifact-1/previews/attachment-0",
    },
  ],
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
        speechAvailable
        speaking={false}
        speechConnecting={false}
        checked
        onPointerDown={() => {}}
        onPointerMove={() => {}}
        onPointerUp={() => {}}
        onPointerCancel={() => {}}
        onContextMenu={() => {}}
        onResizePointerDown={() => {}}
        onResizePointerMove={() => {}}
        onResizePointerUp={() => {}}
        onSelect={() => {}}
        onToggleSpeech={() => {}}
        onCheckedChange={() => {}}
      />,
    );

    expect(html).toContain("Provider source");
    expect(html).toContain("Find important messages for this branch.");
    expect(html).toContain('class="provider-icon large"');
    expect(html).toContain("translate(100px, 120px)");
    expect(html).toContain("Read Outlook aloud");
    expect(html).toContain("Select Outlook");
    expect(html).toContain("multi-selected");
    expect(synapseNodeSpeech(providerNode)).toContain("Find important messages for this branch.");
  });

  it("renders an email artifact with its external source", () => {
    const html = renderToStaticMarkup(
      <SynapseNodeCard
        node={artifactNode}
        selected={false}
        linking
        speechAvailable
        speaking
        speechConnecting={false}
        checked={false}
        onPointerDown={() => {}}
        onPointerMove={() => {}}
        onPointerUp={() => {}}
        onPointerCancel={() => {}}
        onContextMenu={() => {}}
        onResizePointerDown={() => {}}
        onResizePointerMove={() => {}}
        onResizePointerUp={() => {}}
        onSelect={() => {}}
        onToggleSpeech={() => {}}
        onCheckedChange={() => {}}
      />,
    );

    expect(html).toContain("New mining opportunity");
    expect(html).toContain("<strong>Priority:</strong>");
    expect(html).toContain("sales brief");
    expect(html).toContain("https://outlook.office.com/mail/message-1");
    expect(html).toContain("link-target");
    expect(html).toContain('class="synapse-node-kind"');
    expect(html).toContain('class="synapse-node-title" title="New mining opportunity"');
    expect(html).toContain("width:420px;height:280px");
    expect(html).toContain("Resize New mining opportunity");
    expect(html).toContain("Open artifact resources");
    expect(html).toContain("Sales brief.pdf");
    expect(html).toContain("Stop reading New mining opportunity");
    expect(html).not.toContain("<iframe");
  });

  it("adds a user turn to node history immediately while the agent is working", () => {
    const workspace: SynapseWorkspace = {
      id: "synapse-1",
      name: "Sales research",
      nodes: [providerNode],
      edges: [],
      threads: [],
      createdAt: "2026-08-15T01:00:00.000Z",
      updatedAt: "2026-08-15T01:00:00.000Z",
    };

    const next = appendSynapseUserMessage(workspace, providerNode.id, "What changed?", "local-user-1");

    expect(next.threads).toEqual([
      expect.objectContaining({
        nodeId: providerNode.id,
        messages: [expect.objectContaining({ id: "local-user-1", role: "user", content: "What changed?" })],
      }),
    ]);
    expect(workspace.threads).toEqual([]);
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

    const html = renderToStaticMarkup(
      <SynapseApprovalNodeCard
        item={item!}
        provider={provider}
        selected
        speechAvailable
        speaking={false}
        speechConnecting={false}
        onSelect={() => {}}
        onDecision={async () => {}}
        onToggleSpeech={() => {}}
      />,
    );
    expect(html).toContain("Connector approval");
    expect(html).toContain("Approve once");
    expect(html).toContain(" Deny</button>");
    expect(html).toContain('class="provider-icon large"');
    expect(html).toContain("Sales inbox");
    expect(html).toContain("Read outlook.send_message aloud");
  });
});

describe("zoomCanvasView", () => {
  it("zooms around the pointer without moving its world coordinate", () => {
    const pointer = { x: 420, y: 260 };
    const zoomed = zoomCanvasView({ x: 30, y: -20, scale: 1 }, pointer, -120);

    expect(zoomed.scale).toBeGreaterThan(1);
    expect((pointer.x - zoomed.x) / zoomed.scale).toBeCloseTo(390);
    expect((pointer.y - zoomed.y) / zoomed.scale).toBeCloseTo(280);
  });

  it("clamps zoom to the supported viewing range", () => {
    expect(zoomCanvasView({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 100_000).scale).toBe(0.3);
    expect(zoomCanvasView({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, -100_000).scale).toBe(2.5);
  });
});

describe("panNodeIntoView", () => {
  it("keeps visible nodes fixed and reveals clipped nodes with padding", () => {
    const current = { x: 20, y: 30, scale: 1 };
    expect(panNodeIntoView(current, { x: 80, y: 70 }, { width: 240, height: 140 }, { width: 800, height: 500 })).toBe(
      current,
    );
    expect(
      panNodeIntoView(current, { x: 720, y: 440 }, { width: 240, height: 140 }, { width: 800, height: 500 }),
    ).toEqual({ x: -192, y: -112, scale: 1 });
  });
});

describe("fitCanvasView", () => {
  it("centres an arranged graph and scales it to the viewport", () => {
    const view = fitCanvasView(
      [
        { ...providerNode, position: { x: 80, y: 80 }, size: { width: 320, height: 140 } },
        { ...artifactNode, position: { x: 700, y: 400 }, size: { width: 420, height: 360 } },
      ],
      { width: 900, height: 600 },
    );

    expect(view.scale).toBeLessThan(1);
    expect(view.scale).toBeGreaterThanOrEqual(0.3);
    expect(80 * view.scale + view.x).toBeGreaterThan(0);
    expect(760 * view.scale + view.y).toBeLessThan(600);
  });
});
