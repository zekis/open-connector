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
  isSynapseNodeControlTarget,
  mergeSynapseProgress,
  panNodeIntoView,
  SynapseApprovalNodeCard,
  SynapseNodeCard,
  SynapseNodeDetail,
  synapseNodeSpeech,
  synapseApprovalItems,
  synapseConnectedNodeGroups,
  zoomCanvasView,
} from "./synapse-page";

describe("Synapse canvas pointer routing", () => {
  it("keeps node content independent from the dedicated drag control", () => {
    const markdownContent = {
      closest: (selector: string) => (selector.includes(".synapse-node-markdown") ? { id: "markdown" } : null),
    };
    const button = {
      closest: (selector: string) => (selector.includes("button") ? { id: "button" } : null),
    };
    const resizeHandle = {
      closest: (selector: string) => (selector.includes(".synapse-node-resize") ? { id: "resize" } : null),
    };
    const dragHandle = {
      closest: (selector: string) => (selector.includes("button") ? { id: "drag" } : null),
    };

    expect(isSynapseNodeControlTarget(markdownContent)).toBe(false);
    expect(isSynapseNodeControlTarget(button)).toBe(true);
    expect(isSynapseNodeControlTarget(resizeHandle)).toBe(true);
    expect(isSynapseNodeControlTarget(dragHandle)).toBe(true);
  });
});

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
        refreshing={false}
        refreshDisabled={false}
        onPointerDown={() => {}}
        onPointerMove={() => {}}
        onPointerUp={() => {}}
        onPointerCancel={() => {}}
        onContextMenu={() => {}}
        onResizePointerDown={() => {}}
        onResizePointerMove={() => {}}
        onResizePointerUp={() => {}}
        onSelect={() => {}}
        onOpen={() => {}}
        onRefresh={() => {}}
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
    expect(html).toContain("Drag Outlook");
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
        refreshing
        refreshDisabled={false}
        onPointerDown={() => {}}
        onPointerMove={() => {}}
        onPointerUp={() => {}}
        onPointerCancel={() => {}}
        onContextMenu={() => {}}
        onResizePointerDown={() => {}}
        onResizePointerMove={() => {}}
        onResizePointerUp={() => {}}
        onSelect={() => {}}
        onOpen={() => {}}
        onRefresh={() => {}}
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
    expect(html).toContain("Ask Claude to refresh New mining opportunity");
    expect(html).toContain("Drag New mining opportunity");
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
      requests: [
        expect.objectContaining({
          approvalId: "approval-1",
          title: "outlook.send_message",
          connectionDisplayName: "Sales inbox",
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <SynapseApprovalNodeCard
        item={item!}
        providersByService={new Map([[provider.service, provider]])}
        selected
        speechAvailable
        speaking={false}
        speechConnecting={false}
        onDecision={async () => {}}
        onToggleSpeech={() => {}}
      />,
    );
    expect(html).toContain("Draft approval");
    expect(html).toContain("1 / 1");
    expect(html).toContain("Approve once");
    expect(html).toContain(" Deny</button>");
    expect(html).toContain('class="provider-icon large"');
    expect(html).toContain("Sales inbox");
    expect(html).toContain("Read outlook.send_message aloud");
  });

  it("projects every queued connector approval from one agent turn", () => {
    const draft: SynapseArtifactNode = {
      id: "draft-1",
      kind: "artifact",
      artifactKind: "draft",
      title: "Close selected YardCraft items",
      content: "# Proposed updates\n\nClose work items 194047 and 194048.",
      approvalIds: ["approval-1", "approval-2"],
      position: { x: 480, y: 120 },
      size: { width: 520, height: 410 },
      createdAt: "2026-08-15T01:01:00.000Z",
      updatedAt: "2026-08-15T01:01:00.000Z",
    };
    const workspace: SynapseWorkspace = {
      id: "synapse-1",
      name: "Bulk update",
      nodes: [providerNode, draft],
      edges: [],
      threads: [
        {
          nodeId: providerNode.id,
          pendingApprovalId: "approval-1",
          pendingApprovalIds: ["approval-1", "approval-2"],
          pendingMessageId: "message-1",
          updatedAt: "2026-08-15T01:02:00.000Z",
          messages: [
            {
              id: "message-1",
              role: "assistant",
              content: "Two changes are queued.",
              createdAt: "2026-08-15T01:02:00.000Z",
              toolActivity: [
                {
                  id: "activity-1",
                  type: "action",
                  label: "azure_devops.update_work_item",
                  ok: false,
                  actionId: "azure_devops.update_work_item",
                  connectionId: "devops-1",
                  approvalId: "approval-1",
                  input: { id: 194047, state: "Done" },
                  output: { error: { code: "approval_pending" } },
                },
                {
                  id: "activity-2",
                  type: "action",
                  label: "azure_devops.update_work_item",
                  ok: false,
                  actionId: "azure_devops.update_work_item",
                  connectionId: "devops-1",
                  approvalId: "approval-2",
                  input: { id: 194048, state: "Done" },
                  output: { error: { code: "approval_pending" } },
                },
              ],
            },
          ],
        },
      ],
      createdAt: "2026-08-15T01:00:00.000Z",
      updatedAt: "2026-08-15T01:02:00.000Z",
    };

    const items = synapseApprovalItems(workspace);
    expect(items).toEqual([
      expect.objectContaining({
        approvalId: "approval-1",
        position: draft.position,
        size: draft.size,
        requests: [
          expect.objectContaining({
            approvalId: "approval-1",
            input: { id: 194047, state: "Done" },
            draftNode: draft,
          }),
          expect.objectContaining({
            approvalId: "approval-2",
            input: { id: 194048, state: "Done" },
            draftNode: draft,
          }),
        ],
      }),
    ]);
    const html = renderToStaticMarkup(
      <SynapseApprovalNodeCard
        item={items[0]!}
        providersByService={new Map()}
        selected={false}
        speechAvailable={false}
        speaking={false}
        speechConnecting={false}
        onDecision={async () => {}}
        onToggleSpeech={() => {}}
      />,
    );
    expect(html).toContain("Close selected YardCraft items");
    expect(html).toContain("Close work items 194047 and 194048.");
    expect(html).toContain("1 / 2");
    expect(html).toContain("Approve all");
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Next approval"');
  });
});

describe("SynapseNodeDetail", () => {
  const downstreamNode: SynapseArtifactNode = {
    ...artifactNode,
    id: "artifact-2",
    artifactKind: "note",
    title: "Opportunity decision",
    content: "Proceed after the sales brief is reviewed.",
    position: { x: 900, y: 220 },
  };
  const workspace: SynapseWorkspace = {
    id: "synapse-1",
    name: "Sales research",
    nodes: [providerNode, artifactNode, downstreamNode],
    edges: [
      {
        id: "edge-1",
        sourceNodeId: providerNode.id,
        targetNodeId: artifactNode.id,
        createdAt: "2026-08-15T01:01:00.000Z",
      },
      {
        id: "edge-2",
        sourceNodeId: artifactNode.id,
        targetNodeId: downstreamNode.id,
        createdAt: "2026-08-15T01:02:00.000Z",
      },
      {
        id: "edge-2-duplicate",
        sourceNodeId: artifactNode.id,
        targetNodeId: downstreamNode.id,
        createdAt: "2026-08-15T01:03:00.000Z",
      },
    ],
    threads: [],
    createdAt: "2026-08-15T01:00:00.000Z",
    updatedAt: "2026-08-15T01:03:00.000Z",
  };

  it("groups every directly attached node by edge direction without duplicates", () => {
    expect(synapseConnectedNodeGroups(workspace, artifactNode.id)).toEqual({
      incoming: [providerNode],
      outgoing: [downstreamNode],
    });
  });

  it("renders the expanded artifact beside directional navigation handles", () => {
    const html = renderToStaticMarkup(
      <SynapseNodeDetail
        workspace={workspace}
        node={artifactNode}
        providersByService={new Map([[provider.service, provider]])}
        speechAvailable
        speaking={false}
        speechConnecting={false}
        refreshing={false}
        refreshDisabled={false}
        onClose={() => {}}
        onNavigate={() => {}}
        onRefresh={() => {}}
        onToggleSpeech={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Expanded node New mining opportunity"');
    expect(html).toContain('aria-label="Return to Synapse canvas"');
    expect(html).toContain('aria-label="Incoming connected nodes"');
    expect(html).toContain('aria-label="Outgoing connected nodes"');
    expect(html).toContain('aria-label="Open connected node Outlook"');
    expect(html).toContain('aria-label="Open connected node Opportunity decision"');
    expect(html).toContain("<strong>Priority:</strong>");
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
