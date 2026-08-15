import type {
  AgentChatToolActivity,
  AppData,
  ConnectionRecord,
  ProviderDefinition,
  SynapseArtifactKind,
  SynapseNode,
  SynapseWorkspace,
  SynapseWorkspaceSummary,
} from "./model";
import type { FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import {
  ArrowUpRight,
  Bot,
  BrainCircuit,
  Cable,
  Check,
  CircleAlert,
  Clock3,
  FileText,
  GitBranch,
  Link2,
  Loader2,
  Mail,
  MessageSquareText,
  Network,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { ChatMarkdown } from "./chat-markdown";
import { ChatToolActivityList } from "./chat-page";
import { flowConnectionDisplayName } from "./flow-connection-picker";
import { ProviderIcon } from "./shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const canvasWidth = 3_000;
const canvasHeight = 2_000;
const nodeWidth = 264;
const providerNodeHeight = 118;
const artifactNodeHeight = 164;
const approvalNodeHeight = 142;
const approvalPollIntervalMs = 2_000;

interface DragState {
  nodeId: string;
  offsetX: number;
  offsetY: number;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface SynapseApprovalCanvasItem {
  id: string;
  approvalId: string;
  nodeId: string;
  title: string;
  connectionDisplayName?: string;
  input: unknown;
  position: { x: number; y: number };
}

interface ProviderOption {
  connection: ConnectionRecord & { id: string };
  provider?: ProviderDefinition;
  label: string;
}

export function SynapsePage(props: { data: AppData; onRefresh(): void }): ReactNode {
  const [summaries, setSummaries] = useState<SynapseWorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<SynapseWorkspace>();
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedApprovalId, setSelectedApprovalId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [artifactOpen, setArtifactOpen] = useState(false);
  const [linkingFrom, setLinkingFrom] = useState<string>();
  const providersByService = useMemo(
    () => new Map(props.data.providers.map((provider) => [provider.service, provider])),
    [props.data.providers],
  );
  const approvalItems = useMemo(() => (workspace ? synapseApprovalItems(workspace) : []), [workspace]);
  const selectedApproval = approvalItems.find((item) => item.approvalId === selectedApprovalId);
  const pendingApprovalKey = approvalItems.map((item) => `${item.nodeId}:${item.approvalId}`).join("|");

  const applyWorkspace = useCallback((next: SynapseWorkspace): void => {
    setWorkspace(next);
    setSummaries((current) => {
      const summary = workspaceSummary(next);
      return [summary, ...current.filter((candidate) => candidate.id !== next.id)];
    });
  }, []);

  const loadWorkspace = useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    try {
      const next = await apiGet<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(id)}`);
      setWorkspace(next);
      setSelectedNodeId((current) =>
        current && next.nodes.some((node) => node.id === current) ? current : next.nodes[0]?.id,
      );
      setError(undefined);
    } catch (caught) {
      setError(messageFrom(caught, "Could not load this Synapse."));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSummaries = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await apiGet<SynapseWorkspaceSummary[]>("/api/synapses");
      setSummaries(next);
      if (next.length > 0) await loadWorkspace(next[0]!.id);
      else setWorkspace(undefined);
      setError(undefined);
    } catch (caught) {
      setError(messageFrom(caught, "Could not load Synapse."));
    } finally {
      setLoading(false);
    }
  }, [loadWorkspace]);

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries]);

  useEffect(() => {
    if (!workspace || !pendingApprovalKey) return;
    let cancelled = false;
    let checking = false;
    const workspaceId = workspace.id;
    const nodeIds = approvalItems.map((item) => item.nodeId);
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        for (const nodeId of nodeIds) {
          const next = await apiGet<SynapseWorkspace>(
            `/api/synapses/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
          );
          if (cancelled) return;
          applyWorkspace(next);
        }
      } catch (caught) {
        if (!cancelled) setError(messageFrom(caught, "Could not check pending Synapse approvals."));
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), approvalPollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyWorkspace, pendingApprovalKey, workspace?.id]);

  useEffect(() => {
    if (selectedApprovalId && !selectedApproval) setSelectedApprovalId(undefined);
  }, [selectedApproval, selectedApprovalId]);

  async function createWorkspace(name: string): Promise<void> {
    const next = await apiPost<SynapseWorkspace>("/api/synapses", { name });
    setWorkspace(next);
    setSelectedNodeId(undefined);
    setSelectedApprovalId(undefined);
    setSummaries((current) => [workspaceSummary(next), ...current]);
    setCreateOpen(false);
  }

  async function deleteWorkspace(): Promise<void> {
    if (!workspace || !window.confirm(`Delete “${workspace.name}” and all of its nodes?`)) return;
    await apiDelete(`/api/synapses/${encodeURIComponent(workspace.id)}`);
    const remaining = summaries.filter((summary) => summary.id !== workspace.id);
    setSummaries(remaining);
    setWorkspace(undefined);
    setSelectedNodeId(undefined);
    setSelectedApprovalId(undefined);
    if (remaining[0]) await loadWorkspace(remaining[0].id);
  }

  async function deleteNode(nodeId: string): Promise<void> {
    if (!workspace) return;
    const next = await apiDelete<SynapseWorkspace>(
      `/api/synapses/${encodeURIComponent(workspace.id)}/nodes/${encodeURIComponent(nodeId)}`,
    );
    applyWorkspace(next);
    setSelectedNodeId(next.nodes[0]?.id);
    setSelectedApprovalId(undefined);
  }

  async function connectTo(nodeId: string): Promise<void> {
    if (!workspace || !linkingFrom || linkingFrom === nodeId) return;
    try {
      const next = await apiPost<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(workspace.id)}/edges`, {
        sourceNodeId: linkingFrom,
        targetNodeId: nodeId,
      });
      applyWorkspace(next);
      setLinkingFrom(undefined);
      setSelectedNodeId(nodeId);
      setSelectedApprovalId(undefined);
    } catch (caught) {
      setError(messageFrom(caught, "Could not connect these nodes."));
    }
  }

  const selectedNode = workspace?.nodes.find((node) => node.id === selectedNodeId);

  return (
    <div className="synapse-page">
      <header className="synapse-toolbar">
        <div className="synapse-workspace-control">
          <span className="synapse-mark">
            <BrainCircuit size={18} aria-hidden="true" />
          </span>
          {summaries.length > 0 ? (
            <Select value={workspace?.id} onValueChange={(id) => void loadWorkspace(id)}>
              <SelectTrigger className="synapse-workspace-select" aria-label="Synapse workspace">
                <SelectValue placeholder="Choose a Synapse" />
              </SelectTrigger>
              <SelectContent>
                {summaries.map((summary) => (
                  <SelectItem value={summary.id} key={summary.id}>
                    {summary.name} · {summary.nodeCount} nodes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div>
              <strong>Synapse</strong>
              <small>Connected thinking on a living canvas</small>
            </div>
          )}
        </div>
        {linkingFrom ? (
          <div className="synapse-linking-hint">
            <Link2 size={14} /> Choose a node to connect
            <Button variant="ghost" size="sm" onClick={() => setLinkingFrom(undefined)}>
              Cancel
            </Button>
          </div>
        ) : null}
        <div className="synapse-toolbar-actions">
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New canvas
          </Button>
          <Button variant="outline" size="sm" disabled={!workspace} onClick={() => setSourceOpen(true)}>
            <Cable size={14} /> Add source
          </Button>
          <Button variant="outline" size="sm" disabled={!workspace} onClick={() => setArtifactOpen(true)}>
            <StickyNote size={14} /> Add artifact
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!workspace}
            aria-label="Delete canvas"
            onClick={() => void deleteWorkspace()}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </header>

      {error ? (
        <div className="synapse-error" role="alert">
          <CircleAlert size={15} /> {error}
        </div>
      ) : null}

      <div className={selectedNode || selectedApproval ? "synapse-stage with-panel" : "synapse-stage"}>
        {workspace ? (
          <SynapseCanvas
            workspace={workspace}
            approvalItems={approvalItems}
            selectedNodeId={selectedNodeId}
            selectedApprovalId={selectedApprovalId}
            linkingFrom={linkingFrom}
            providersByService={providersByService}
            onWorkspaceChange={setWorkspace}
            onWorkspaceSaved={applyWorkspace}
            onNodeSelect={(nodeId) => {
              if (linkingFrom) void connectTo(nodeId);
              else {
                setSelectedNodeId(nodeId);
                setSelectedApprovalId(undefined);
              }
            }}
            onApprovalSelect={(approvalId) => {
              if (linkingFrom) return;
              setSelectedNodeId(undefined);
              setSelectedApprovalId(approvalId);
            }}
          />
        ) : (
          <SynapseEmpty loading={loading} onCreate={() => setCreateOpen(true)} />
        )}
        {workspace && selectedNode ? (
          <SynapseNodePanel
            data={props.data}
            workspace={workspace}
            node={selectedNode}
            provider={selectedNode.kind === "provider" ? providersByService.get(selectedNode.service) : undefined}
            onClose={() => setSelectedNodeId(undefined)}
            onDelete={() => void deleteNode(selectedNode.id)}
            onLink={() => setLinkingFrom(selectedNode.id)}
            onWorkspaceChange={applyWorkspace}
            onRefresh={props.onRefresh}
          />
        ) : null}
        {workspace && selectedApproval ? (
          <SynapseApprovalPanel
            workspace={workspace}
            item={selectedApproval}
            onClose={() => setSelectedApprovalId(undefined)}
            onWorkspaceChange={applyWorkspace}
            onRefresh={props.onRefresh}
          />
        ) : null}
      </div>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={createWorkspace} />
      {workspace ? (
        <AddSourceDialog
          open={sourceOpen}
          workspace={workspace}
          data={props.data}
          onOpenChange={setSourceOpen}
          onCreated={(next) => {
            applyWorkspace(next);
            setSelectedNodeId(next.nodes.at(-1)?.id);
          }}
        />
      ) : null}
      {workspace ? (
        <AddArtifactDialog
          open={artifactOpen}
          workspace={workspace}
          onOpenChange={setArtifactOpen}
          onCreated={(next) => {
            applyWorkspace(next);
            setSelectedNodeId(next.nodes.at(-1)?.id);
          }}
        />
      ) : null}
    </div>
  );
}

function SynapseCanvas(props: {
  workspace: SynapseWorkspace;
  approvalItems: SynapseApprovalCanvasItem[];
  selectedNodeId?: string;
  selectedApprovalId?: string;
  linkingFrom?: string;
  providersByService: Map<string, ProviderDefinition>;
  onWorkspaceChange(workspace: SynapseWorkspace): void;
  onWorkspaceSaved(workspace: SynapseWorkspace): void;
  onNodeSelect(nodeId: string): void;
  onApprovalSelect(approvalId: string): void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const panRef = useRef<PanState | undefined>(undefined);
  const [panning, setPanning] = useState(false);

  function beginPan(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".synapse-node")) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
    event.preventDefault();
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
  }

  function finishPan(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = undefined;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function beginDrag(event: ReactPointerEvent<HTMLElement>, node: SynapseNode): void {
    if ((event.target as HTMLElement).closest("button,a")) return;
    if (props.linkingFrom) {
      props.onNodeSelect(node.id);
      return;
    }
    const scroll = scrollRef.current;
    if (!scroll) return;
    const rect = scroll.getBoundingClientRect();
    dragRef.current = {
      nodeId: node.id,
      offsetX: event.clientX - rect.left + scroll.scrollLeft - node.position.x,
      offsetY: event.clientY - rect.top + scroll.scrollTop - node.position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    props.onNodeSelect(node.id);
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>): void {
    const drag = dragRef.current;
    const scroll = scrollRef.current;
    if (!drag || !scroll) return;
    const rect = scroll.getBoundingClientRect();
    const position = {
      x: Math.max(
        20,
        Math.min(canvasWidth - nodeWidth - 20, event.clientX - rect.left + scroll.scrollLeft - drag.offsetX),
      ),
      y: Math.max(
        20,
        Math.min(canvasHeight - artifactNodeHeight - 20, event.clientY - rect.top + scroll.scrollTop - drag.offsetY),
      ),
    };
    props.onWorkspaceChange(moveNode(props.workspace, drag.nodeId, position));
  }

  function finishDrag(event: ReactPointerEvent<HTMLElement>): void {
    const drag = dragRef.current;
    const scroll = scrollRef.current;
    dragRef.current = undefined;
    if (!drag || !scroll) return;
    const rect = scroll.getBoundingClientRect();
    const position = {
      x: Math.round(
        Math.max(
          20,
          Math.min(canvasWidth - nodeWidth - 20, event.clientX - rect.left + scroll.scrollLeft - drag.offsetX),
        ),
      ),
      y: Math.round(
        Math.max(
          20,
          Math.min(canvasHeight - artifactNodeHeight - 20, event.clientY - rect.top + scroll.scrollTop - drag.offsetY),
        ),
      ),
    };
    props.onWorkspaceChange(moveNode(props.workspace, drag.nodeId, position));
    void apiPut<SynapseWorkspace>(
      `/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes/${encodeURIComponent(drag.nodeId)}`,
      { position },
    ).then(props.onWorkspaceSaved);
  }

  return (
    <div
      className={panning ? "synapse-canvas-scroll panning" : "synapse-canvas-scroll"}
      ref={scrollRef}
      onPointerDown={beginPan}
      onPointerMove={movePan}
      onPointerUp={finishPan}
      onPointerCancel={finishPan}
    >
      <div className="synapse-canvas" style={{ width: canvasWidth, height: canvasHeight }}>
        <svg className="synapse-edges" width={canvasWidth} height={canvasHeight} aria-hidden="true">
          <defs>
            <marker id="synapse-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" />
            </marker>
          </defs>
          {props.workspace.edges.map((edge) => {
            const source = props.workspace.nodes.find((node) => node.id === edge.sourceNodeId);
            const target = props.workspace.nodes.find((node) => node.id === edge.targetNodeId);
            if (!source || !target) return null;
            const sourceHeight = source.kind === "provider" ? providerNodeHeight : artifactNodeHeight;
            const targetHeight = target.kind === "provider" ? providerNodeHeight : artifactNodeHeight;
            const startX = source.position.x + nodeWidth;
            const startY = source.position.y + sourceHeight / 2;
            const endX = target.position.x;
            const endY = target.position.y + targetHeight / 2;
            const bend = Math.max(80, Math.abs(endX - startX) * 0.45);
            return (
              <path
                className="synapse-edge"
                d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`}
                markerEnd="url(#synapse-arrow)"
                key={edge.id}
              />
            );
          })}
          {props.approvalItems.map((item) => {
            const source = props.workspace.nodes.find((node) => node.id === item.nodeId);
            if (!source) return null;
            const sourceHeight = source.kind === "provider" ? providerNodeHeight : artifactNodeHeight;
            const direction = item.position.x >= source.position.x ? 1 : -1;
            const startX = direction > 0 ? source.position.x + nodeWidth : source.position.x;
            const startY = source.position.y + sourceHeight / 2;
            const endX = direction > 0 ? item.position.x : item.position.x + nodeWidth;
            const endY = item.position.y + approvalNodeHeight / 2;
            const bend = Math.max(80, Math.abs(endX - startX) * 0.45);
            return (
              <path
                className="synapse-edge approval"
                d={`M ${startX} ${startY} C ${startX + direction * bend} ${startY}, ${endX - direction * bend} ${endY}, ${endX} ${endY}`}
                markerEnd="url(#synapse-arrow)"
                key={`edge-${item.id}`}
              />
            );
          })}
        </svg>
        {props.workspace.nodes.map((node) => (
          <SynapseNodeCard
            key={node.id}
            node={node}
            selected={props.selectedNodeId === node.id}
            linking={props.linkingFrom !== undefined && props.linkingFrom !== node.id}
            provider={node.kind === "provider" ? props.providersByService.get(node.service) : undefined}
            onPointerDown={(event) => beginDrag(event, node)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onSelect={() => props.onNodeSelect(node.id)}
          />
        ))}
        {props.approvalItems.map((item) => (
          <SynapseApprovalNodeCard
            item={item}
            selected={props.selectedApprovalId === item.approvalId}
            onSelect={() => props.onApprovalSelect(item.approvalId)}
            key={item.id}
          />
        ))}
        {props.workspace.nodes.length === 0 ? (
          <div className="synapse-canvas-hint">
            <Network size={28} />
            <strong>Add your first source</strong>
            <span>Choose Outlook, Brave, or another connected provider to begin.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SynapseNodeCard(props: {
  node: SynapseNode;
  selected: boolean;
  linking: boolean;
  provider?: ProviderDefinition;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
  onSelect(): void;
}): ReactNode {
  const style = { transform: `translate(${props.node.position.x}px, ${props.node.position.y}px)` };
  if (props.node.kind === "provider") {
    return (
      <article
        className={`synapse-node provider${props.selected ? " selected" : ""}${props.linking ? " link-target" : ""}`}
        style={style}
        onPointerDown={props.onPointerDown}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
        onDoubleClick={props.onSelect}
      >
        <div className="synapse-node-icon provider">
          {props.provider ? <ProviderIcon provider={props.provider} large /> : <Cable size={22} />}
        </div>
        <div className="synapse-node-copy">
          <span className="synapse-node-eyebrow">Provider source</span>
          <strong>{props.node.title}</strong>
          <small>{props.node.instructions ?? "Ask this node to retrieve or act through its connection."}</small>
        </div>
        <span className="synapse-port input" />
        <span className="synapse-port output" />
      </article>
    );
  }
  const Icon = artifactIcon(props.node.artifactKind);
  return (
    <article
      className={`synapse-node artifact ${props.node.artifactKind}${props.selected ? " selected" : ""}${props.linking ? " link-target" : ""}`}
      style={style}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onDoubleClick={props.onSelect}
    >
      <header>
        <span className="synapse-node-icon artifact">
          <Icon size={18} />
        </span>
        <span>{artifactLabel(props.node.artifactKind)}</span>
        {props.node.externalUrl ? (
          <a href={props.node.externalUrl} target="_blank" rel="noreferrer" aria-label="Open source">
            <ArrowUpRight size={14} />
          </a>
        ) : null}
      </header>
      <strong>{props.node.title}</strong>
      <p>{props.node.summary ?? props.node.content ?? "Open the node and ask Claude to develop this artifact."}</p>
      <span className="synapse-port input" />
      <span className="synapse-port output" />
    </article>
  );
}

export function SynapseApprovalNodeCard(props: {
  item: SynapseApprovalCanvasItem;
  selected: boolean;
  onSelect(): void;
}): ReactNode {
  const style = { transform: `translate(${props.item.position.x}px, ${props.item.position.y}px)` };
  return (
    <article
      className={`synapse-node approval${props.selected ? " selected" : ""}`}
      style={style}
      onPointerDown={(event) => {
        event.stopPropagation();
        props.onSelect();
      }}
    >
      <header>
        <span className="synapse-node-icon approval">
          <ShieldCheck size={18} />
        </span>
        <span>Approval required</span>
        <small>
          <Clock3 size={11} /> Pending
        </small>
      </header>
      <strong>{props.item.title}</strong>
      <p>{props.item.connectionDisplayName ?? "Connected provider action"}</p>
      <span className="synapse-approval-open">Open to approve or deny</span>
      <span className="synapse-port input" />
    </article>
  );
}

function SynapseApprovalPanel(props: {
  workspace: SynapseWorkspace;
  item: SynapseApprovalCanvasItem;
  onWorkspaceChange(workspace: SynapseWorkspace): void;
  onClose(): void;
  onRefresh(): void;
}): ReactNode {
  const [decision, setDecision] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string>();

  async function decide(nextDecision: "approve" | "deny"): Promise<void> {
    if (decision) return;
    setDecision(nextDecision);
    setError(undefined);
    try {
      await apiPost(`/api/action-approvals/${encodeURIComponent(props.item.approvalId)}/${nextDecision}`, {});
      const next = await apiGet<SynapseWorkspace>(
        `/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes/${encodeURIComponent(props.item.nodeId)}/approval`,
      );
      props.onWorkspaceChange(next);
      props.onRefresh();
    } catch (caught) {
      setError(messageFrom(caught, `Could not ${nextDecision} this action.`));
    } finally {
      setDecision(null);
    }
  }

  return (
    <aside className="synapse-panel synapse-approval-panel">
      <header className="synapse-panel-header">
        <span className="synapse-panel-icon approval">
          <ShieldCheck size={20} />
        </span>
        <div>
          <span>Pending connector action</span>
          <strong>{props.item.title}</strong>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close approval" onClick={props.onClose}>
          ×
        </Button>
      </header>
      <div className="synapse-approval-review">
        <div className="synapse-approval-status">
          <Clock3 size={16} />
          <div>
            <strong>Waiting for your decision</strong>
            <span>Approval applies only to this action instance.</span>
          </div>
        </div>
        <dl>
          <div>
            <dt>Action</dt>
            <dd>{props.item.title}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd>{props.item.connectionDisplayName ?? "Connected provider"}</dd>
          </div>
        </dl>
        <div className="synapse-approval-payload">
          <span>Request payload</span>
          <pre>{formatJson(props.item.input)}</pre>
        </div>
      </div>
      {error ? <div className="synapse-panel-error">{error}</div> : null}
      <div className="synapse-approval-actions">
        <Button variant="outline" disabled={Boolean(decision)} onClick={() => void decide("deny")}>
          {decision === "deny" ? <Loader2 className="spin" size={15} /> : <X size={15} />} Deny
        </Button>
        <Button disabled={Boolean(decision)} onClick={() => void decide("approve")}>
          {decision === "approve" ? <Loader2 className="spin" size={15} /> : <Check size={15} />} Approve once
        </Button>
      </div>
    </aside>
  );
}

function SynapseNodePanel(props: {
  data: AppData;
  workspace: SynapseWorkspace;
  node: SynapseNode;
  provider?: ProviderDefinition;
  onWorkspaceChange(workspace: SynapseWorkspace): void;
  onClose(): void;
  onDelete(): void;
  onLink(): void;
  onRefresh(): void;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [approvalDecision, setApprovalDecision] = useState<"approve" | "deny" | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const thread = props.workspace.threads.find((candidate) => candidate.nodeId === props.node.id);
  const configured = props.data.agentConnections?.some((connection) => connection.provider === "claude_code");

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: "smooth" });
  }, [thread?.messages.length, sending]);

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setDraft("");
    setError(undefined);
    try {
      const next = await apiPost<SynapseWorkspace>(
        `/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes/${encodeURIComponent(props.node.id)}/messages`,
        { content },
      );
      props.onWorkspaceChange(next);
      props.onRefresh();
    } catch (caught) {
      setDraft(content);
      setError(messageFrom(caught, "Claude could not continue this node."));
    } finally {
      setSending(false);
    }
  }

  async function decide(decision: "approve" | "deny"): Promise<void> {
    if (!thread?.pendingApprovalId || approvalDecision) return;
    setApprovalDecision(decision);
    setError(undefined);
    try {
      await apiPost(`/api/action-approvals/${encodeURIComponent(thread.pendingApprovalId)}/${decision}`, {});
      const next = await apiGet<SynapseWorkspace>(
        `/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes/${encodeURIComponent(props.node.id)}/approval`,
      );
      props.onWorkspaceChange(next);
      props.onRefresh();
    } catch (caught) {
      setError(messageFrom(caught, `Could not ${decision} this action.`));
    } finally {
      setApprovalDecision(null);
    }
  }

  return (
    <aside className="synapse-panel">
      <header className="synapse-panel-header">
        <span className="synapse-panel-icon">
          {props.node.kind === "provider" && props.provider ? (
            <ProviderIcon provider={props.provider} large />
          ) : (
            <BrainCircuit size={20} />
          )}
        </span>
        <div>
          <span>{props.node.kind === "provider" ? "Provider context" : artifactLabel(props.node.artifactKind)}</span>
          <strong>{props.node.title}</strong>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close node chat" onClick={props.onClose}>
          ×
        </Button>
      </header>
      <div className="synapse-panel-actions">
        <Button variant="ghost" size="sm" onClick={props.onLink}>
          <GitBranch size={14} /> Connect
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onDelete}>
          <Trash2 size={14} /> Delete
        </Button>
      </div>
      {props.node.kind === "artifact" && (props.node.summary || props.node.content) ? (
        <details className="synapse-node-context">
          <summary>Artifact context</summary>
          <div>{props.node.summary}</div>
          {props.node.content ? <pre>{props.node.content}</pre> : null}
        </details>
      ) : null}
      <div className="synapse-transcript" ref={transcriptRef}>
        {!configured ? (
          <div className="synapse-chat-empty">
            <Bot size={24} />
            <strong>Connect Claude to chat</strong>
            <span>Synapse uses the subscription configured on the Agents page.</span>
            <Button asChild size="sm">
              <Link to="/agents">Open Agents</Link>
            </Button>
          </div>
        ) : thread?.messages.length ? (
          thread.messages.map((message) => (
            <div className={`synapse-message ${message.role}`} key={message.id}>
              {message.role === "assistant" ? <Bot size={15} /> : null}
              <div>
                {message.toolActivity?.length ? (
                  <ChatToolActivityList
                    activities={message.toolActivity}
                    activeApprovalId={thread.pendingApprovalId}
                    approvalDecision={approvalDecision}
                    onApprovalDecision={(decision) => void decide(decision)}
                  />
                ) : null}
                <div className="synapse-message-bubble">
                  {message.role === "assistant" ? <ChatMarkdown>{message.content}</ChatMarkdown> : message.content}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="synapse-chat-empty">
            <Sparkles size={24} />
            <strong>Explore this node</strong>
            <span>{nodeSuggestion(props.node)}</span>
          </div>
        )}
        {sending ? (
          <div className="synapse-message assistant thinking">
            <Bot size={15} />
            <div className="synapse-message-bubble">
              <Loader2 className="spin" size={15} /> Claude is working across this branch…
            </div>
          </div>
        ) : null}
      </div>
      {error ? <div className="synapse-panel-error">{error}</div> : null}
      <form className="synapse-composer" onSubmit={(event) => void send(event)}>
        <Textarea
          value={draft}
          disabled={!configured || Boolean(thread?.pendingApprovalId)}
          placeholder={thread?.pendingApprovalId ? "Waiting for approval…" : "Ask about this node and its connections…"}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!configured || !draft.trim() || sending || Boolean(thread?.pendingApprovalId)}
        >
          {sending ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
          <span className="sr-only">Send</span>
        </Button>
      </form>
    </aside>
  );
}

function CreateWorkspaceDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(name: string): Promise<void>;
}): ReactNode {
  const [name, setName] = useState("New Synapse");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await props.onCreate(name.trim());
      setName("New Synapse");
      setError(undefined);
    } catch (caught) {
      setError(messageFrom(caught, "Could not create the canvas."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Create a Synapse</DialogTitle>
            <DialogDescription>
              Start a durable canvas for one investigation, project, or chain of actions.
            </DialogDescription>
          </DialogHeader>
          <Label className="field synapse-dialog-field">
            <span>Canvas name</span>
            <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
          </Label>
          {error ? <div className="synapse-panel-error">{error}</div> : null}
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              {busy ? <Loader2 className="spin" size={14} /> : <BrainCircuit size={14} />} Create canvas
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddSourceDialog(props: {
  open: boolean;
  workspace: SynapseWorkspace;
  data: AppData;
  onOpenChange(open: boolean): void;
  onCreated(workspace: SynapseWorkspace): void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const options = useMemo(() => providerOptions(props.data), [props.data]);
  const normalized = query.trim().toLowerCase();
  const visible = options.filter((option) =>
    `${option.label} ${option.connection.service} ${option.provider?.displayName ?? ""}`
      .toLowerCase()
      .includes(normalized),
  );

  async function choose(option: ProviderOption): Promise<void> {
    setBusy(option.connection.id);
    try {
      const next = await apiPost<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes`, {
        kind: "provider",
        connectionId: option.connection.id,
        position: initialNodePosition(props.workspace),
      });
      props.onCreated(next);
      props.onOpenChange(false);
      setQuery("");
      setError(undefined);
    } catch (caught) {
      setError(messageFrom(caught, "Could not add this source."));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="synapse-source-dialog">
        <DialogHeader>
          <DialogTitle>Add a provider source</DialogTitle>
          <DialogDescription>
            Choose a connected account. Its actions become available to agents on this branch.
          </DialogDescription>
        </DialogHeader>
        <div className="synapse-source-search">
          <Search size={15} />
          <Input
            value={query}
            autoFocus
            placeholder="Search Outlook, Brave, SharePoint…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="synapse-source-options">
          {visible.map((option) => (
            <button type="button" key={option.connection.id} onClick={() => void choose(option)}>
              {option.provider ? <ProviderIcon provider={option.provider} large /> : <Cable size={20} />}
              <span>
                <strong>{option.provider?.displayName ?? option.connection.service}</strong>
                <small>{option.label}</small>
              </span>
              {busy === option.connection.id ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
            </button>
          ))}
          {visible.length === 0 ? <div className="synapse-source-empty">No matching connected providers.</div> : null}
        </div>
        {error ? <div className="synapse-panel-error">{error}</div> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddArtifactDialog(props: {
  open: boolean;
  workspace: SynapseWorkspace;
  onOpenChange(open: boolean): void;
  onCreated(workspace: SynapseWorkspace): void;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [kind, setKind] = useState<SynapseArtifactKind>("note");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const next = await apiPost<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes`, {
        kind: "artifact",
        artifactKind: kind,
        title: title.trim(),
        summary: summary.trim() || undefined,
        position: initialNodePosition(props.workspace),
      });
      props.onCreated(next);
      props.onOpenChange(false);
      setTitle("");
      setSummary("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Add an artifact</DialogTitle>
            <DialogDescription>Seed the canvas with a note, draft, task, or other piece of context.</DialogDescription>
          </DialogHeader>
          <div className="synapse-artifact-form">
            <Label className="field">
              <span>Type</span>
              <Select value={kind} onValueChange={(value) => setKind(value as SynapseArtifactKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["note", "draft", "task", "document", "email", "search_result", "generic"] as const).map(
                    (value) => (
                      <SelectItem value={value} key={value}>
                        {artifactLabel(value)}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </Label>
            <Label className="field">
              <span>Title</span>
              <Input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
            </Label>
            <Label className="field">
              <span>Context</span>
              <Textarea value={summary} rows={4} onChange={(event) => setSummary(event.target.value)} />
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || busy}>
              {busy ? <Loader2 className="spin" size={14} /> : <StickyNote size={14} />} Add artifact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SynapseEmpty(props: { loading: boolean; onCreate(): void }): ReactNode {
  return (
    <div className="synapse-empty">
      <span>
        <BrainCircuit size={34} />
      </span>
      <h2>{props.loading ? "Loading Synapse…" : "Turn connected data into a map you can talk to."}</h2>
      <p>Start with a provider, let Claude fan results into artifacts, then follow the branch that matters.</p>
      <Button disabled={props.loading} onClick={props.onCreate}>
        {props.loading ? <Loader2 className="spin" size={15} /> : <Plus size={15} />} Create your first Synapse
      </Button>
    </div>
  );
}

function providerOptions(data: AppData): ProviderOption[] {
  const providers = new Map(data.providers.map((provider) => [provider.service, provider]));
  return data.connections
    .filter((connection): connection is ConnectionRecord & { id: string } =>
      Boolean(connection.id && connection.configured !== false),
    )
    .map((connection) => ({
      connection,
      provider: providers.get(connection.service),
      label: flowConnectionDisplayName(connection),
    }))
    .sort((left, right) =>
      `${left.provider?.displayName} ${left.label}`.localeCompare(`${right.provider?.displayName} ${right.label}`),
    );
}

export function synapseApprovalItems(workspace: SynapseWorkspace): SynapseApprovalCanvasItem[] {
  return workspace.threads.flatMap((thread) => {
    if (!thread.pendingApprovalId) return [];
    const owner = workspace.nodes.find((node) => node.id === thread.nodeId);
    if (!owner) return [];
    const pendingMessage = thread.messages.find((message) => message.id === thread.pendingMessageId);
    const activity = pendingApprovalActivity(pendingMessage?.toolActivity, thread.pendingApprovalId);
    const rightX = owner.position.x + nodeWidth + 96;
    const maximumX = canvasWidth - nodeWidth - 20;
    const x = rightX <= maximumX ? rightX : Math.max(20, owner.position.x - nodeWidth - 96);
    return [
      {
        id: `approval:${thread.pendingApprovalId}`,
        approvalId: thread.pendingApprovalId,
        nodeId: thread.nodeId,
        title: activity?.actionId ?? activity?.label ?? "Connector action",
        connectionDisplayName: activity?.connectionDisplayName,
        input: activity?.input ?? {},
        position: { x, y: Math.max(20, owner.position.y + 4) },
      },
    ];
  });
}

function pendingApprovalActivity(
  activities: AgentChatToolActivity[] | undefined,
  approvalId: string,
): AgentChatToolActivity | undefined {
  return activities?.find((activity) => activity.approvalId === approvalId);
}

function moveNode(workspace: SynapseWorkspace, nodeId: string, position: { x: number; y: number }): SynapseWorkspace {
  return {
    ...workspace,
    nodes: workspace.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

function initialNodePosition(workspace: SynapseWorkspace): { x: number; y: number } {
  const index = workspace.nodes.length;
  return { x: 100 + (index % 4) * 320, y: 120 + Math.floor(index / 4) * 220 };
}

function workspaceSummary(workspace: SynapseWorkspace): SynapseWorkspaceSummary {
  return { id: workspace.id, name: workspace.name, nodeCount: workspace.nodes.length, updatedAt: workspace.updatedAt };
}

function artifactLabel(kind: SynapseArtifactKind): string {
  switch (kind) {
    case "search_result":
      return "Search result";
    case "email":
      return "Email";
    case "draft":
      return "Draft";
    case "document":
      return "Document";
    case "note":
      return "Note";
    case "task":
      return "Task";
    default:
      return "Artifact";
  }
}

function artifactIcon(kind: SynapseArtifactKind): typeof FileText {
  if (kind === "email" || kind === "draft") return Mail;
  if (kind === "note") return StickyNote;
  if (kind === "search_result") return Search;
  if (kind === "task") return MessageSquareText;
  return FileText;
}

function nodeSuggestion(node: SynapseNode): string {
  if (node.kind === "provider")
    return "Ask Claude to retrieve something. Useful results will become connected artifact cards.";
  if (node.artifactKind === "draft") return "Ask Claude to revise this draft, then tell it when you are ready to send.";
  return "Ask a follow-up. Claude sees this artifact and every node connected to its branch.";
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "{}";
  } catch {
    return "Unable to display this request payload.";
  }
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
