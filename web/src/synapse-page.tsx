import type {
  AgentChatToolActivity,
  AppData,
  ConnectionRecord,
  FeedPreview,
  ProviderDefinition,
  SaynaVoiceConfiguration,
  SynapseArtifactKind,
  SynapseNode,
  SynapseSelectionResult,
  SynapseSize,
  SynapseWorkspace,
  SynapseWorkspaceSummary,
} from "./model";
import type { SaynaVoiceState } from "./sayna-voice";
import type { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import {
  Bot,
  BrainCircuit,
  Cable,
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  File,
  FileImage,
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
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";
import { ChatMarkdown } from "./chat-markdown";
import { ChatToolActivityList } from "./chat-page";
import { flowConnectionDisplayName } from "./flow-connection-picker";
import { SaynaVoiceClient } from "./sayna-voice";
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

const nodeWidth = 264;
const providerNodeHeight = 118;
const artifactNodeHeight = 164;
const approvalNodeHeight = 142;
const nodeHorizontalGap = 48;
const nodeVerticalGap = 32;
const approvalPollIntervalMs = 2_000;
const canvasGridSize = 22;
const minimumCanvasScale = 0.3;
const maximumCanvasScale = 2.5;
const wheelZoomSensitivity = 0.0015;
const minimumNodeWidth = 220;
const maximumNodeWidth = 1_200;
const minimumNodeHeight = 100;
const maximumNodeHeight = 1_200;

interface DragState {
  nodeId: string;
  pointerId: number;
  offsetX: number;
  offsetY: number;
}

interface ResizeState {
  nodeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

export interface CanvasView {
  x: number;
  y: number;
  scale: number;
}

interface CanvasOccupant {
  position: { x: number; y: number };
  width: number;
  height: number;
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

interface SynapseContextRequest {
  clientX: number;
  clientY: number;
  position: { x: number; y: number };
  nodeId?: string;
}

interface NewNodePlacement {
  position: { x: number; y: number };
  parentNodeId?: string;
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
  const [newNodePlacement, setNewNodePlacement] = useState<NewNodePlacement>();
  const [contextMenu, setContextMenu] = useState<SynapseContextRequest>();
  const [arranging, setArranging] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [linkingFrom, setLinkingFrom] = useState<string>();
  const [voiceConfiguration, setVoiceConfiguration] = useState<SaynaVoiceConfiguration>();
  const [voiceState, setVoiceState] = useState<SaynaVoiceState>("offline");
  const [speakingNodeId, setSpeakingNodeId] = useState<string>();
  const [voiceError, setVoiceError] = useState<string>();
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [synthesizingSelection, setSynthesizingSelection] = useState(false);
  const voiceClientRef = useRef<SaynaVoiceClient | undefined>(undefined);
  const voiceStateRef = useRef<SaynaVoiceState>("offline");
  const providersByService = useMemo(
    () => new Map(props.data.providers.map((provider) => [provider.service, provider])),
    [props.data.providers],
  );
  const approvalItems = useMemo(() => (workspace ? synapseApprovalItems(workspace) : []), [workspace]);
  const selectedApproval = approvalItems.find((item) => item.approvalId === selectedApprovalId);
  const selectedNodeIdSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
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
    setWorkspaceNameDraft(workspace?.name ?? "");
    setSelectedNodeIds([]);
  }, [workspace?.id]);

  useEffect(() => {
    let cancelled = false;
    void apiGet<SaynaVoiceConfiguration>("/api/agent-chat/voice/config")
      .then((configuration) => {
        if (!cancelled) setVoiceConfiguration(configuration);
      })
      .catch(() => {
        // Voice is optional on Cloudflare and older Node runtimes.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!voiceConfiguration?.enabled || !voiceConfiguration.websocketPath) return;
    const client = new SaynaVoiceClient(voiceConfiguration, {
      onStateChange: (nextState) => {
        const previousState = voiceStateRef.current;
        voiceStateRef.current = nextState;
        setVoiceState(nextState);
        if (
          nextState === "error" ||
          nextState === "offline" ||
          (previousState === "speaking" && nextState !== "speaking")
        ) {
          setSpeakingNodeId(undefined);
        }
      },
      onListeningChange: () => {},
      onTranscript: () => {},
      onError: setVoiceError,
    });
    voiceClientRef.current = client;
    return () => {
      client.close();
      if (voiceClientRef.current === client) voiceClientRef.current = undefined;
    };
  }, [voiceConfiguration]);

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
    setSelectedNodeIds([]);
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
    setSelectedNodeIds([]);
    if (remaining[0]) await loadWorkspace(remaining[0].id);
  }

  async function deleteNode(nodeId: string): Promise<void> {
    if (!workspace) return;
    const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || !window.confirm(`Delete “${node.title}” and its connections?`)) return;
    const next = await apiDelete<SynapseWorkspace>(
      `/api/synapses/${encodeURIComponent(workspace.id)}/nodes/${encodeURIComponent(nodeId)}`,
    );
    applyWorkspace(next);
    setSelectedNodeId(next.nodes[0]?.id);
    setSelectedApprovalId(undefined);
    setSelectedNodeIds((current) => current.filter((selectedId) => selectedId !== nodeId));
  }

  async function saveWorkspace(): Promise<void> {
    if (!workspace || savingWorkspace) return;
    const name = workspaceNameDraft.trim();
    if (!name) {
      setError("Give this canvas a name before saving it.");
      return;
    }
    setSavingWorkspace(true);
    setError(undefined);
    try {
      applyWorkspace(await apiPut<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(workspace.id)}`, { name }));
      setWorkspaceNameDraft(name);
    } catch (caught) {
      setError(messageFrom(caught, "Could not save this canvas."));
    } finally {
      setSavingWorkspace(false);
    }
  }

  function setNodeChecked(nodeId: string, checked: boolean): void {
    setSelectedNodeIds((current) => {
      if (!checked) return current.filter((selectedId) => selectedId !== nodeId);
      if (current.includes(nodeId)) return current;
      if (current.length >= 20) {
        setError("Select no more than 20 nodes at once.");
        return current;
      }
      return [...current, nodeId];
    });
  }

  async function askSelectedNodes(content: string): Promise<void> {
    if (!workspace || selectedNodeIds.length < 2 || synthesizingSelection) return;
    setSynthesizingSelection(true);
    setError(undefined);
    try {
      const result = await apiPost<SynapseSelectionResult>(
        `/api/synapses/${encodeURIComponent(workspace.id)}/selection/messages`,
        { nodeIds: selectedNodeIds, content },
      );
      applyWorkspace(result.workspace);
      setSelectedNodeIds([]);
      setSelectedApprovalId(undefined);
      setSelectedNodeId(result.resultNodeId);
      props.onRefresh();
    } catch (caught) {
      setError(messageFrom(caught, "Claude could not combine the selected nodes."));
    } finally {
      setSynthesizingSelection(false);
    }
  }

  async function autoArrange(): Promise<void> {
    if (!workspace || arranging) return;
    setArranging(true);
    setError(undefined);
    try {
      const next = await apiPost<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(workspace.id)}/arrange`, {});
      applyWorkspace(next);
      setFitRequest((current) => current + 1);
    } catch (caught) {
      setError(messageFrom(caught, "Could not auto-arrange this Synapse."));
    } finally {
      setArranging(false);
    }
  }

  async function autoSizeNode(nodeId: string): Promise<void> {
    if (!workspace) return;
    try {
      const next = await apiPut<SynapseWorkspace>(
        `/api/synapses/${encodeURIComponent(workspace.id)}/nodes/${encodeURIComponent(nodeId)}`,
        { autoSize: true },
      );
      applyWorkspace(next);
    } catch (caught) {
      setError(messageFrom(caught, "Could not auto-size this node."));
    }
  }

  function openNodeDialog(kind: "provider" | "artifact", placement?: NewNodePlacement): void {
    setContextMenu(undefined);
    setNewNodePlacement(placement);
    if (kind === "provider") setSourceOpen(true);
    else setArtifactOpen(true);
  }

  function toggleNodeSpeech(nodeId: string, text: string): void {
    const client = voiceClientRef.current;
    if (!client || !voiceConfiguration?.enabled) {
      setVoiceError("Configure Sayna voice in Chat before reading Synapse nodes aloud.");
      return;
    }
    if (speakingNodeId === nodeId) {
      client.stopSpeaking();
      setSpeakingNodeId(undefined);
      return;
    }
    client.stopSpeaking();
    setVoiceError(undefined);
    setSpeakingNodeId(nodeId);
    void client.speak(text);
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
  const synthesisNodes = workspace?.nodes.filter((node) => selectedNodeIdSet.has(node.id)) ?? [];
  const agentConfigured =
    props.data.agentConnections?.some((connection) => connection.provider === "claude_code") ?? false;

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
          {workspace ? (
            <form
              className="synapse-name-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveWorkspace();
              }}
            >
              <Input
                value={workspaceNameDraft}
                aria-label="Canvas name"
                maxLength={120}
                onChange={(event) => setWorkspaceNameDraft(event.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                size="icon-sm"
                disabled={savingWorkspace || !workspaceNameDraft.trim() || workspaceNameDraft.trim() === workspace.name}
                aria-label="Save canvas"
                title="Save canvas name and current canvas"
              >
                {savingWorkspace ? <Loader2 className="spin" size={14} /> : <Save size={14} />}
              </Button>
            </form>
          ) : null}
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
          <Button variant="outline" size="sm" disabled={!workspace} onClick={() => openNodeDialog("provider")}>
            <Cable size={14} /> Add source
          </Button>
          <Button variant="outline" size="sm" disabled={!workspace} onClick={() => openNodeDialog("artifact")}>
            <StickyNote size={14} /> Add artifact
          </Button>
          <Button variant="outline" size="sm" disabled={!workspace || arranging} onClick={() => void autoArrange()}>
            {arranging ? <Loader2 className="spin" size={14} /> : <Network size={14} />} Auto arrange
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!workspace}
            aria-label="Delete canvas"
            title="Delete canvas"
            onClick={() => void deleteWorkspace()}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </header>

      {error || voiceError ? (
        <div className="synapse-error" role="alert">
          <CircleAlert size={15} /> {error ?? voiceError}
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
            fitRequest={fitRequest}
            speechAvailable={voiceConfiguration?.enabled === true}
            speakingNodeId={speakingNodeId}
            speechConnecting={voiceState === "connecting"}
            checkedNodeIds={selectedNodeIdSet}
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
            onContextRequest={(request) => {
              setContextMenu(request);
              if (request.nodeId) {
                setSelectedNodeId(request.nodeId);
                setSelectedApprovalId(undefined);
              }
            }}
            onToggleSpeech={toggleNodeSpeech}
            onNodeCheckedChange={setNodeChecked}
          />
        ) : (
          <SynapseEmpty loading={loading} onCreate={() => setCreateOpen(true)} />
        )}
        {workspace && synthesisNodes.length > 0 ? (
          <SynapseSelectionComposer
            nodes={synthesisNodes}
            configured={agentConfigured}
            sending={synthesizingSelection}
            onClear={() => setSelectedNodeIds([])}
            onSubmit={askSelectedNodes}
          />
        ) : null}
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
          placement={newNodePlacement}
          onOpenChange={(open) => {
            setSourceOpen(open);
            if (!open) setNewNodePlacement(undefined);
          }}
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
          placement={newNodePlacement}
          onOpenChange={(open) => {
            setArtifactOpen(open);
            if (!open) setNewNodePlacement(undefined);
          }}
          onCreated={(next) => {
            applyWorkspace(next);
            setSelectedNodeId(next.nodes.at(-1)?.id);
          }}
        />
      ) : null}
      {workspace && contextMenu ? (
        <SynapseContextMenu
          request={contextMenu}
          targetNode={workspace.nodes.find((node) => node.id === contextMenu.nodeId)}
          selectedNode={workspace.nodes.find((node) => node.id === selectedNodeId)}
          onClose={() => setContextMenu(undefined)}
          onOpenNode={(nodeId) => {
            setSelectedNodeId(nodeId);
            setSelectedApprovalId(undefined);
            setContextMenu(undefined);
          }}
          onAddProvider={(placement) => openNodeDialog("provider", placement)}
          onAddArtifact={(placement) => openNodeDialog("artifact", placement)}
          onConnect={(nodeId) => {
            setLinkingFrom(nodeId);
            setContextMenu(undefined);
          }}
          onAutoSize={(nodeId) => {
            setContextMenu(undefined);
            void autoSizeNode(nodeId);
          }}
          onAutoArrange={() => {
            setContextMenu(undefined);
            void autoArrange();
          }}
          onDelete={(nodeId) => {
            setContextMenu(undefined);
            void deleteNode(nodeId);
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
  fitRequest: number;
  speechAvailable: boolean;
  speakingNodeId?: string;
  speechConnecting: boolean;
  checkedNodeIds: ReadonlySet<string>;
  providersByService: Map<string, ProviderDefinition>;
  onWorkspaceChange(workspace: SynapseWorkspace): void;
  onWorkspaceSaved(workspace: SynapseWorkspace): void;
  onNodeSelect(nodeId: string): void;
  onApprovalSelect(approvalId: string): void;
  onContextRequest(request: SynapseContextRequest): void;
  onToggleSpeech(nodeId: string, text: string): void;
  onNodeCheckedChange(nodeId: string, checked: boolean): void;
}): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const resizeRef = useRef<ResizeState | undefined>(undefined);
  const panRef = useRef<PanState | undefined>(undefined);
  const workspaceRef = useRef(props.workspace);
  const [panning, setPanning] = useState(false);
  const [canvasView, setCanvasView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 });
  workspaceRef.current = props.workspace;

  const revealSelectedNode = useCallback((): void => {
    if (dragRef.current || resizeRef.current || panRef.current) return;
    const canvas = scrollRef.current;
    const selectedNode = workspaceRef.current.nodes.find((node) => node.id === props.selectedNodeId);
    if (!canvas || !selectedNode) return;
    const rect = canvas.getBoundingClientRect();
    setCanvasView((current) =>
      panNodeIntoView(current, selectedNode.position, sizeForCanvasNode(selectedNode), {
        width: rect.width,
        height: rect.height,
      }),
    );
  }, [props.selectedNodeId]);

  useEffect(() => {
    if (!props.selectedNodeId) return;
    const canvas = scrollRef.current;
    if (!canvas) return;
    let frame = window.requestAnimationFrame(revealSelectedNode);
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(revealSelectedNode);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [props.selectedNodeId, revealSelectedNode]);

  useEffect(() => {
    if (props.fitRequest === 0) return;
    const canvas = scrollRef.current;
    if (!canvas) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      setCanvasView(fitCanvasView(workspaceRef.current.nodes, { width: rect.width, height: rect.height }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.fitRequest]);

  useEffect(() => {
    const canvas = scrollRef.current;
    if (!canvas) return;
    const zoom = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const deltaY = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
      setCanvasView((current) =>
        zoomCanvasView(current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, deltaY),
      );
    };
    canvas.addEventListener("wheel", zoom, { passive: false });
    return () => canvas.removeEventListener("wheel", zoom);
  }, []);

  function beginPan(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".synapse-node")) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: canvasView.x,
      offsetY: canvasView.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
    event.preventDefault();
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>): void {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setCanvasView((current) => ({
      ...current,
      x: pan.offsetX + event.clientX - pan.startX,
      y: pan.offsetY + event.clientY - pan.startY,
    }));
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
    if ((event.target as HTMLElement).closest("button,a,.synapse-node-markdown,.synapse-node-resize")) return;
    if (props.linkingFrom) {
      props.onNodeSelect(node.id);
      return;
    }
    const scroll = scrollRef.current;
    if (!scroll) return;
    const rect = scroll.getBoundingClientRect();
    dragRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      offsetX: (event.clientX - rect.left - canvasView.x) / canvasView.scale - node.position.x,
      offsetY: (event.clientY - rect.top - canvasView.y) / canvasView.scale - node.position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    props.onNodeSelect(node.id);
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>): void {
    const drag = dragRef.current;
    const scroll = scrollRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !scroll) return;
    const rect = scroll.getBoundingClientRect();
    const position = {
      x: (event.clientX - rect.left - canvasView.x) / canvasView.scale - drag.offsetX,
      y: (event.clientY - rect.top - canvasView.y) / canvasView.scale - drag.offsetY,
    };
    props.onWorkspaceChange(moveNode(props.workspace, drag.nodeId, position));
  }

  function finishDrag(event: ReactPointerEvent<HTMLElement>): void {
    const drag = dragRef.current;
    const scroll = scrollRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !scroll) return;
    dragRef.current = undefined;
    const rect = scroll.getBoundingClientRect();
    const position = {
      x: Math.round((event.clientX - rect.left - canvasView.x) / canvasView.scale - drag.offsetX),
      y: Math.round((event.clientY - rect.top - canvasView.y) / canvasView.scale - drag.offsetY),
    };
    props.onWorkspaceChange(moveNode(props.workspace, drag.nodeId, position));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void apiPut<SynapseWorkspace>(
      `/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes/${encodeURIComponent(drag.nodeId)}`,
      { position },
    ).then((workspace) => {
      props.onWorkspaceSaved(workspace);
      window.requestAnimationFrame(revealSelectedNode);
    });
  }

  function beginResize(event: ReactPointerEvent<HTMLElement>, node: SynapseNode): void {
    if (event.button !== 0) return;
    const size = sizeForCanvasNode(node);
    resizeRef.current = {
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: size.width,
      startHeight: size.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  }

  function moveResize(event: ReactPointerEvent<HTMLElement>): void {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const size = sizeFromPointer(resize, event.clientX, event.clientY, canvasView.scale);
    props.onWorkspaceChange(resizeNode(props.workspace, resize.nodeId, size));
  }

  function finishResize(event: ReactPointerEvent<HTMLElement>): void {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = undefined;
    const size = sizeFromPointer(resize, event.clientX, event.clientY, canvasView.scale);
    props.onWorkspaceChange(resizeNode(props.workspace, resize.nodeId, size));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void apiPut<SynapseWorkspace>(
      `/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes/${encodeURIComponent(resize.nodeId)}`,
      { size, autoSize: false },
    ).then((workspace) => {
      props.onWorkspaceSaved(workspace);
      props.onNodeSelect(resize.nodeId);
      window.requestAnimationFrame(revealSelectedNode);
    });
  }

  function requestContext(event: ReactMouseEvent<HTMLElement>, node?: SynapseNode): void {
    event.preventDefault();
    event.stopPropagation();
    const canvas = scrollRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    props.onContextRequest({
      clientX: event.clientX,
      clientY: event.clientY,
      position: node
        ? {
            x: node.position.x + sizeForCanvasNode(node).width + nodeHorizontalGap,
            y: node.position.y,
          }
        : {
            x: Math.round((event.clientX - rect.left - canvasView.x) / canvasView.scale),
            y: Math.round((event.clientY - rect.top - canvasView.y) / canvasView.scale),
          },
      nodeId: node?.id,
    });
  }

  return (
    <div
      className={panning ? "synapse-canvas-scroll panning" : "synapse-canvas-scroll"}
      ref={scrollRef}
      style={{
        backgroundPosition: `${canvasView.x}px ${canvasView.y}px`,
        backgroundSize: `${canvasGridSize * canvasView.scale}px ${canvasGridSize * canvasView.scale}px`,
      }}
      onPointerDown={beginPan}
      onPointerMove={movePan}
      onPointerUp={finishPan}
      onPointerCancel={finishPan}
      onContextMenu={(event) => requestContext(event)}
    >
      <div
        className="synapse-canvas"
        style={{ transform: `translate(${canvasView.x}px, ${canvasView.y}px) scale(${canvasView.scale})` }}
      >
        <svg className="synapse-edges" width="1" height="1" aria-hidden="true">
          <defs>
            <marker id="synapse-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" />
            </marker>
          </defs>
          {props.workspace.edges.map((edge) => {
            const source = props.workspace.nodes.find((node) => node.id === edge.sourceNodeId);
            const target = props.workspace.nodes.find((node) => node.id === edge.targetNodeId);
            if (!source || !target) return null;
            const sourceSize = sizeForCanvasNode(source);
            const targetSize = sizeForCanvasNode(target);
            const direction = target.position.x >= source.position.x ? 1 : -1;
            const startX = direction > 0 ? source.position.x + sourceSize.width : source.position.x;
            const startY = source.position.y + sourceSize.height / 2;
            const endX = direction > 0 ? target.position.x : target.position.x + targetSize.width;
            const endY = target.position.y + targetSize.height / 2;
            const bend = Math.max(80, Math.abs(endX - startX) * 0.45);
            return (
              <path
                className="synapse-edge"
                d={`M ${startX} ${startY} C ${startX + direction * bend} ${startY}, ${endX - direction * bend} ${endY}, ${endX} ${endY}`}
                markerEnd="url(#synapse-arrow)"
                key={edge.id}
              />
            );
          })}
          {props.approvalItems.map((item) => {
            const source = props.workspace.nodes.find((node) => node.id === item.nodeId);
            if (!source) return null;
            const sourceSize = sizeForCanvasNode(source);
            const direction = item.position.x >= source.position.x ? 1 : -1;
            const startX = direction > 0 ? source.position.x + sourceSize.width : source.position.x;
            const startY = source.position.y + sourceSize.height / 2;
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
            speechAvailable={props.speechAvailable}
            speaking={props.speakingNodeId === node.id}
            speechConnecting={props.speakingNodeId === node.id && props.speechConnecting}
            checked={props.checkedNodeIds.has(node.id)}
            provider={node.kind === "provider" ? props.providersByService.get(node.service) : undefined}
            onPointerDown={(event) => beginDrag(event, node)}
            onPointerMove={moveDrag}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onContextMenu={(event) => requestContext(event, node)}
            onResizePointerDown={(event) => beginResize(event, node)}
            onResizePointerMove={moveResize}
            onResizePointerUp={finishResize}
            onSelect={() => props.onNodeSelect(node.id)}
            onToggleSpeech={() => props.onToggleSpeech(node.id, synapseNodeSpeech(node))}
            onCheckedChange={(checked) => props.onNodeCheckedChange(node.id, checked)}
          />
        ))}
        {props.approvalItems.map((item) => (
          <SynapseApprovalNodeCard
            item={item}
            selected={props.selectedApprovalId === item.approvalId}
            speechAvailable={props.speechAvailable}
            speaking={props.speakingNodeId === item.id}
            speechConnecting={props.speakingNodeId === item.id && props.speechConnecting}
            onSelect={() => props.onApprovalSelect(item.approvalId)}
            onToggleSpeech={() => props.onToggleSpeech(item.id, synapseApprovalSpeech(item))}
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
      <span className="synapse-zoom-level">{Math.round(canvasView.scale * 100)}%</span>
    </div>
  );
}

export function SynapseNodeCard(props: {
  node: SynapseNode;
  selected: boolean;
  linking: boolean;
  speechAvailable: boolean;
  speaking: boolean;
  speechConnecting: boolean;
  checked: boolean;
  provider?: ProviderDefinition;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void;
  onContextMenu(event: ReactMouseEvent<HTMLElement>): void;
  onResizePointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onResizePointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onResizePointerUp(event: ReactPointerEvent<HTMLElement>): void;
  onSelect(): void;
  onToggleSpeech(): void;
  onCheckedChange(checked: boolean): void;
}): ReactNode {
  const size = sizeForCanvasNode(props.node);
  const style = {
    transform: `translate(${props.node.position.x}px, ${props.node.position.y}px)`,
    width: size.width,
    height: size.height,
  };
  if (props.node.kind === "provider") {
    return (
      <article
        className={`synapse-node provider${props.selected ? " selected" : ""}${props.checked ? " multi-selected" : ""}${props.linking ? " link-target" : ""}`}
        style={style}
        onPointerDown={props.onPointerDown}
        onPointerMove={props.onPointerMove}
        onPointerUp={props.onPointerUp}
        onPointerCancel={props.onPointerCancel}
        onContextMenu={props.onContextMenu}
        onDoubleClick={props.onSelect}
      >
        <SynapseNodeCheckbox checked={props.checked} label={props.node.title} onCheckedChange={props.onCheckedChange} />
        <SynapseTtsButton
          available={props.speechAvailable}
          speaking={props.speaking}
          connecting={props.speechConnecting}
          label={props.node.title}
          onToggle={props.onToggleSpeech}
        />
        <div className="synapse-node-icon provider">
          {props.provider ? <ProviderIcon provider={props.provider} large /> : <Cable size={22} />}
        </div>
        <div className="synapse-node-copy">
          <span className="synapse-node-eyebrow">Provider source</span>
          <strong>{props.node.title}</strong>
          <div className="synapse-node-markdown provider-markdown">
            <ChatMarkdown>
              {props.node.instructions ?? "Ask this node to retrieve or act through its connection."}
            </ChatMarkdown>
          </div>
        </div>
        <span className="synapse-port input" />
        <span className="synapse-port output" />
        <span
          className="synapse-node-resize"
          role="separator"
          aria-label={`Resize ${props.node.title}`}
          onPointerDown={props.onResizePointerDown}
          onPointerMove={props.onResizePointerMove}
          onPointerUp={props.onResizePointerUp}
          onPointerCancel={props.onResizePointerUp}
        />
      </article>
    );
  }
  const Icon = artifactIcon(props.node.artifactKind);
  const markdown = props.node.content ?? props.node.summary ?? "Open the node and ask Claude to develop this artifact.";
  const previews = props.node.previews ?? [];
  return (
    <article
      className={`synapse-node artifact ${props.node.artifactKind}${props.selected ? " selected" : ""}${props.checked ? " multi-selected" : ""}${props.linking ? " link-target" : ""}`}
      style={style}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onContextMenu={props.onContextMenu}
      onDoubleClick={props.onSelect}
    >
      <SynapseNodeCheckbox checked={props.checked} label={props.node.title} onCheckedChange={props.onCheckedChange} />
      <SynapseTtsButton
        available={props.speechAvailable}
        speaking={props.speaking}
        connecting={props.speechConnecting}
        label={props.node.title}
        onToggle={props.onToggleSpeech}
      />
      <header>
        <span className="synapse-node-icon artifact">
          <Icon size={18} />
        </span>
        <span className="synapse-node-kind">{artifactLabel(props.node.artifactKind)}</span>
      </header>
      <strong className="synapse-node-title" title={props.node.title}>
        {props.node.title}
      </strong>
      <SynapseArtifactShortcuts previews={previews} externalUrl={props.node.externalUrl} />
      <div className="synapse-node-markdown">
        <ChatMarkdown>{markdown}</ChatMarkdown>
      </div>
      <span className="synapse-port input" />
      <span className="synapse-port output" />
      <span
        className="synapse-node-resize"
        role="separator"
        aria-label={`Resize ${props.node.title}`}
        onPointerDown={props.onResizePointerDown}
        onPointerMove={props.onResizePointerMove}
        onPointerUp={props.onResizePointerUp}
        onPointerCancel={props.onResizePointerUp}
      />
    </article>
  );
}

export function synapseNodeSpeech(node: SynapseNode): string {
  const content =
    node.kind === "provider"
      ? (node.instructions ?? "Ask this node to retrieve or act through its connection.")
      : (node.content ?? node.summary ?? "Open the node and ask Claude to develop this artifact.");
  return `${node.title}\n\n${content}`;
}

function SynapseTtsButton(props: {
  available: boolean;
  speaking: boolean;
  connecting: boolean;
  label: string;
  onToggle(): void;
}): ReactNode {
  const active = props.speaking || props.connecting;
  const actionLabel = active ? `Stop reading ${props.label}` : `Read ${props.label} aloud`;
  return (
    <button
      className={active ? "synapse-node-tts active" : "synapse-node-tts"}
      type="button"
      disabled={!props.available}
      aria-label={actionLabel}
      aria-pressed={active}
      title={props.available ? actionLabel : "Configure Sayna voice in Chat to enable text to speech"}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
    >
      {props.connecting ? (
        <Loader2 className="spin" size={14} />
      ) : active ? (
        <Square size={12} />
      ) : (
        <Volume2 size={15} />
      )}
    </button>
  );
}

function SynapseNodeCheckbox(props: {
  checked: boolean;
  label: string;
  onCheckedChange(checked: boolean): void;
}): ReactNode {
  return (
    <label
      className={props.checked ? "synapse-node-select checked" : "synapse-node-select"}
      title={props.checked ? `Remove ${props.label} from selection` : `Add ${props.label} to selection`}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={props.checked}
        aria-label={`Select ${props.label}`}
        onChange={(event) => props.onCheckedChange(event.target.checked)}
      />
    </label>
  );
}

function SynapseArtifactShortcuts(props: { previews: FeedPreview[]; externalUrl?: string }): ReactNode {
  const links = props.previews
    .map((preview) => ({ preview, url: preview.contentUrl ?? preview.externalUrl }))
    .filter((entry): entry is { preview: FeedPreview; url: string } => Boolean(entry.url));
  const externalAlreadyListed = links.some(({ url }) => url === props.externalUrl);
  if (links.length === 0 && (!props.externalUrl || externalAlreadyListed)) return null;
  return (
    <div className="synapse-artifact-shortcuts" aria-label="Open artifact resources">
      {links.slice(0, 8).map(({ preview, url }) => (
        <a href={url} target="_blank" rel="noreferrer" title={`Open ${preview.name}`} key={preview.id}>
          <PreviewIcon preview={preview} />
          <span>{preview.name}</span>
        </a>
      ))}
      {props.externalUrl && !externalAlreadyListed ? (
        <a href={props.externalUrl} target="_blank" rel="noreferrer" title="Open source">
          <ExternalLink size={14} />
          <span>Source</span>
        </a>
      ) : null}
      {links.length > 8 ? <span className="synapse-shortcut-overflow">+{links.length - 8}</span> : null}
    </div>
  );
}

function PreviewIcon({ preview }: { preview: FeedPreview }): ReactNode {
  if (preview.kind === "email") return <Mail size={16} />;
  if (preview.kind === "image") return <FileImage size={16} />;
  if (preview.kind === "pdf" || preview.kind === "document") return <FileText size={16} />;
  if (preview.kind === "web") return <ExternalLink size={16} />;
  return <File size={16} />;
}

export function SynapseApprovalNodeCard(props: {
  item: SynapseApprovalCanvasItem;
  selected: boolean;
  speechAvailable: boolean;
  speaking: boolean;
  speechConnecting: boolean;
  onSelect(): void;
  onToggleSpeech(): void;
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
      <SynapseTtsButton
        available={props.speechAvailable}
        speaking={props.speaking}
        connecting={props.speechConnecting}
        label={props.item.title}
        onToggle={props.onToggleSpeech}
      />
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

function synapseApprovalSpeech(item: SynapseApprovalCanvasItem): string {
  return `Approval required. ${item.title}. ${item.connectionDisplayName ?? "Connected provider action"}. Open this node to approve or deny the request.`;
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

function SynapseSelectionComposer(props: {
  nodes: SynapseNode[];
  configured: boolean;
  sending: boolean;
  onClear(): void;
  onSubmit(content: string): Promise<void>;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const ready = props.nodes.length >= 2 && props.configured && !props.sending;

  function submit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !ready) return;
    void props.onSubmit(content);
  }

  return (
    <aside className="synapse-selection-composer" aria-label="Ask selected nodes">
      <header>
        <span>
          <Check size={14} /> {props.nodes.length} selected
        </span>
        <span className="synapse-selection-names" title={props.nodes.map((node) => node.title).join(", ")}>
          {props.nodes.map((node) => node.title).join(" · ")}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Clear node selection" onClick={props.onClear}>
          <X size={14} />
        </Button>
      </header>
      <form onSubmit={submit}>
        <Textarea
          value={draft}
          rows={2}
          maxLength={20_000}
          disabled={!props.configured || props.sending}
          placeholder={
            props.nodes.length < 2
              ? "Select at least one more node…"
              : "Ask across these nodes or request a new connected source…"
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!ready}
            onClick={() =>
              void props.onSubmit(
                "Summarise the selected nodes into one concise durable note. Preserve the important facts, relationships, decisions, and next actions.",
              )
            }
          >
            <Sparkles size={14} /> Summarise
          </Button>
          <Button type="submit" size="sm" disabled={!ready || !draft.trim()}>
            {props.sending ? <Loader2 className="spin" size={14} /> : <Send size={14} />} Ask selected
          </Button>
        </div>
      </form>
      {!props.configured ? <small>Connect Claude on the Agents page to use multi-node questions.</small> : null}
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
  const hasArtifactContext = props.node.kind === "artifact" && Boolean(props.node.summary || props.node.content);

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
    props.onWorkspaceChange(appendSynapseUserMessage(props.workspace, props.node.id, content));
    try {
      const next = await apiPost<SynapseWorkspace>(
        `/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes/${encodeURIComponent(props.node.id)}/messages`,
        { content },
      );
      props.onWorkspaceChange(next);
      props.onRefresh();
    } catch (caught) {
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
    <aside className={hasArtifactContext ? "synapse-panel has-artifact-context" : "synapse-panel"}>
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
      {hasArtifactContext && props.node.kind === "artifact" ? (
        <section className="synapse-node-context">
          <strong>Artifact Markdown</strong>
          <ChatMarkdown>{props.node.content ?? props.node.summary ?? ""}</ChatMarkdown>
        </section>
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

function SynapseContextMenu(props: {
  request: SynapseContextRequest;
  targetNode?: SynapseNode;
  selectedNode?: SynapseNode;
  onClose(): void;
  onOpenNode(nodeId: string): void;
  onAddProvider(placement: NewNodePlacement): void;
  onAddArtifact(placement: NewNodePlacement): void;
  onConnect(nodeId: string): void;
  onAutoSize(nodeId: string): void;
  onAutoArrange(): void;
  onDelete(nodeId: string): void;
}): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) props.onClose();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", props.onClose);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", props.onClose);
    };
  }, [props.onClose]);

  const menuWidth = 236;
  const menuHeight = props.targetNode ? 332 : props.selectedNode ? 252 : 154;
  const left = Math.max(8, Math.min(props.request.clientX, window.innerWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(props.request.clientY, window.innerHeight - menuHeight - 8));
  const placement = {
    position: props.request.position,
    parentNodeId: props.request.nodeId,
  };
  return (
    <div className="synapse-context-menu" style={{ left, top }} role="menu" ref={menuRef}>
      {props.targetNode ? (
        <>
          <button type="button" role="menuitem" onClick={() => props.onOpenNode(props.targetNode!.id)}>
            <MessageSquareText size={15} /> Open node chat
          </button>
          <button type="button" role="menuitem" onClick={() => props.onAddProvider(placement)}>
            <Cable size={15} /> Add connected connector
          </button>
          <button type="button" role="menuitem" onClick={() => props.onAddArtifact(placement)}>
            <StickyNote size={15} /> Add connected artifact
          </button>
          <button type="button" role="menuitem" onClick={() => props.onConnect(props.targetNode!.id)}>
            <GitBranch size={15} /> Connect to another node
          </button>
          <button type="button" role="menuitem" onClick={() => props.onAutoSize(props.targetNode!.id)}>
            <Sparkles size={15} /> Auto-size node
          </button>
          <div className="synapse-context-separator" />
        </>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={() => props.onAddProvider(placement)}>
            <Cable size={15} /> Add connector here
          </button>
          <button type="button" role="menuitem" onClick={() => props.onAddArtifact(placement)}>
            <StickyNote size={15} /> Add artifact here
          </button>
        </>
      )}
      <button type="button" role="menuitem" onClick={props.onAutoArrange}>
        <Network size={15} /> Auto arrange canvas
      </button>
      {props.targetNode || props.selectedNode ? <div className="synapse-context-separator" /> : null}
      {!props.targetNode && props.selectedNode ? (
        <button type="button" role="menuitem" onClick={() => props.onAutoSize(props.selectedNode!.id)}>
          <Sparkles size={15} /> Auto-size selected node
        </button>
      ) : null}
      {props.targetNode || props.selectedNode ? (
        <button
          className="destructive"
          type="button"
          role="menuitem"
          onClick={() => props.onDelete((props.targetNode ?? props.selectedNode)!.id)}
        >
          <Trash2 size={15} /> Delete selected node
        </button>
      ) : null}
    </div>
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
  placement?: NewNodePlacement;
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
        position: props.placement?.position ?? initialNodePosition(props.workspace, "provider"),
        parentNodeId: props.placement?.parentNodeId,
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
  placement?: NewNodePlacement;
  onOpenChange(open: boolean): void;
  onCreated(workspace: SynapseWorkspace): void;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [kind, setKind] = useState<SynapseArtifactKind>("note");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim() || !markdown.trim() || busy) return;
    setBusy(true);
    try {
      const next = await apiPost<SynapseWorkspace>(`/api/synapses/${encodeURIComponent(props.workspace.id)}/nodes`, {
        kind: "artifact",
        artifactKind: kind,
        title: title.trim(),
        content: markdown.trim() || undefined,
        position: props.placement?.position ?? initialNodePosition(props.workspace, "artifact"),
        parentNodeId: props.placement?.parentNodeId,
      });
      props.onCreated(next);
      props.onOpenChange(false);
      setTitle("");
      setMarkdown("");
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
            <DialogDescription>
              Seed the canvas with a note, draft, task, or other piece of rendered Markdown.
            </DialogDescription>
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
              <span>Markdown</span>
              <Textarea
                value={markdown}
                rows={7}
                placeholder="Write the exact Markdown shown on this card…"
                onChange={(event) => setMarkdown(event.target.value)}
              />
            </Label>
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || !markdown.trim() || busy}>
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
  const items: SynapseApprovalCanvasItem[] = [];
  for (const thread of workspace.threads) {
    if (!thread.pendingApprovalId) continue;
    const owner = workspace.nodes.find((node) => node.id === thread.nodeId);
    if (!owner) continue;
    const pendingMessage = thread.messages.find((message) => message.id === thread.pendingMessageId);
    const activity = pendingApprovalActivity(pendingMessage?.toolActivity, thread.pendingApprovalId);
    const ownerSize = sizeForCanvasNode(owner);
    const position = findOpenCanvasPosition(
      workspace,
      items.map((item) => ({ position: item.position, width: nodeWidth, height: approvalNodeHeight })),
      { x: owner.position.x + ownerSize.width + nodeHorizontalGap, y: owner.position.y },
      { width: nodeWidth, height: approvalNodeHeight },
    );
    items.push({
      id: `approval:${thread.pendingApprovalId}`,
      approvalId: thread.pendingApprovalId,
      nodeId: thread.nodeId,
      title: activity?.actionId ?? activity?.label ?? "Connector action",
      connectionDisplayName: activity?.connectionDisplayName,
      input: activity?.input ?? {},
      position,
    });
  }
  return items;
}

function pendingApprovalActivity(
  activities: AgentChatToolActivity[] | undefined,
  approvalId: string,
): AgentChatToolActivity | undefined {
  return activities?.find((activity) => activity.approvalId === approvalId);
}

export function appendSynapseUserMessage(
  workspace: SynapseWorkspace,
  nodeId: string,
  content: string,
  messageId = `local-user-${crypto.randomUUID()}`,
): SynapseWorkspace {
  const createdAt = new Date().toISOString();
  const message = { id: messageId, role: "user" as const, content, createdAt };
  const existing = workspace.threads.find((thread) => thread.nodeId === nodeId);
  return {
    ...workspace,
    threads: existing
      ? workspace.threads.map((thread) =>
          thread.nodeId === nodeId
            ? { ...thread, messages: [...thread.messages, message].slice(-40), updatedAt: createdAt }
            : thread,
        )
      : [...workspace.threads, { nodeId, messages: [message], updatedAt: createdAt }],
  };
}

function moveNode(workspace: SynapseWorkspace, nodeId: string, position: { x: number; y: number }): SynapseWorkspace {
  return {
    ...workspace,
    nodes: workspace.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)),
  };
}

function resizeNode(workspace: SynapseWorkspace, nodeId: string, size: SynapseSize): SynapseWorkspace {
  return {
    ...workspace,
    nodes: workspace.nodes.map((node) => (node.id === nodeId ? { ...node, size, autoSize: false } : node)),
  };
}

function sizeFromPointer(resize: ResizeState, clientX: number, clientY: number, scale: number): SynapseSize {
  return {
    width: Math.round(
      Math.min(maximumNodeWidth, Math.max(minimumNodeWidth, resize.startWidth + (clientX - resize.startX) / scale)),
    ),
    height: Math.round(
      Math.min(maximumNodeHeight, Math.max(minimumNodeHeight, resize.startHeight + (clientY - resize.startY) / scale)),
    ),
  };
}

function sizeForCanvasNode(node: SynapseNode): SynapseSize {
  return (
    node.size ?? {
      width: nodeWidth,
      height: node.kind === "provider" ? providerNodeHeight : artifactNodeHeight,
    }
  );
}

export function zoomCanvasView(current: CanvasView, pointer: { x: number; y: number }, deltaY: number): CanvasView {
  if (deltaY === 0) return current;
  const scale = Math.min(
    maximumCanvasScale,
    Math.max(minimumCanvasScale, current.scale * Math.exp(-deltaY * wheelZoomSensitivity)),
  );
  if (scale === current.scale) return current;
  const worldX = (pointer.x - current.x) / current.scale;
  const worldY = (pointer.y - current.y) / current.scale;
  return {
    x: pointer.x - worldX * scale,
    y: pointer.y - worldY * scale,
    scale,
  };
}

export function panNodeIntoView(
  current: CanvasView,
  position: { x: number; y: number },
  size: SynapseSize,
  viewport: { width: number; height: number },
  padding = 32,
): CanvasView {
  const availableWidth = Math.max(0, viewport.width - padding * 2);
  const availableHeight = Math.max(0, viewport.height - padding * 2);
  const scaledWidth = size.width * current.scale;
  const scaledHeight = size.height * current.scale;
  const left = position.x * current.scale + current.x;
  const top = position.y * current.scale + current.y;
  const right = left + scaledWidth;
  const bottom = top + scaledHeight;
  let x = current.x;
  let y = current.y;

  if (scaledWidth > availableWidth) x = padding - position.x * current.scale;
  else if (left < padding) x += padding - left;
  else if (right > viewport.width - padding) x -= right - (viewport.width - padding);

  if (scaledHeight > availableHeight) y = padding - position.y * current.scale;
  else if (top < padding) y += padding - top;
  else if (bottom > viewport.height - padding) y -= bottom - (viewport.height - padding);

  return x === current.x && y === current.y ? current : { ...current, x, y };
}

export function fitCanvasView(
  nodes: SynapseNode[],
  viewport: { width: number; height: number },
  padding = 56,
): CanvasView {
  if (nodes.length === 0) return { x: padding, y: padding, scale: 1 };
  const bounds = nodes.reduce(
    (current, node) => {
      const size = sizeForCanvasNode(node);
      return {
        left: Math.min(current.left, node.position.x),
        top: Math.min(current.top, node.position.y),
        right: Math.max(current.right, node.position.x + size.width),
        bottom: Math.max(current.bottom, node.position.y + size.height),
      };
    },
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const scale = Math.min(
    1,
    Math.max(
      minimumCanvasScale,
      Math.min(Math.max(1, viewport.width - padding * 2) / width, Math.max(1, viewport.height - padding * 2) / height),
    ),
  );
  return {
    x: (viewport.width - width * scale) / 2 - bounds.left * scale,
    y: (viewport.height - height * scale) / 2 - bounds.top * scale,
    scale,
  };
}

function initialNodePosition(workspace: SynapseWorkspace, nodeKind: SynapseNode["kind"]): { x: number; y: number } {
  const size = {
    width: nodeWidth,
    height: nodeKind === "provider" ? providerNodeHeight : artifactNodeHeight,
  };
  return findOpenCanvasPosition(workspace, [], { x: 100, y: 120 }, size);
}

function findOpenCanvasPosition(
  workspace: SynapseWorkspace,
  additionalOccupants: CanvasOccupant[],
  preferred: { x: number; y: number },
  size: SynapseSize,
): { x: number; y: number } {
  const occupants: CanvasOccupant[] = [
    ...workspace.nodes.map((node) => ({
      position: node.position,
      ...sizeForCanvasNode(node),
    })),
    ...additionalOccupants,
  ];
  if (canvasPositionIsOpen(occupants, preferred, size)) return preferred;
  const stepX = size.width + nodeHorizontalGap;
  const stepY = size.height + nodeVerticalGap;
  for (let radius = 1; radius <= occupants.length + 2; radius += 1) {
    for (const offset of canvasPlacementOffsets(radius)) {
      const candidate = { x: preferred.x + offset.x * stepX, y: preferred.y + offset.y * stepY };
      if (canvasPositionIsOpen(occupants, candidate, size)) return candidate;
    }
  }
  return { x: preferred.x + (occupants.length + 3) * stepX, y: preferred.y };
}

function canvasPlacementOffsets(radius: number): Array<{ x: number; y: number }> {
  const offsets = [
    { x: 0, y: radius },
    { x: radius, y: 0 },
    { x: 0, y: -radius },
    { x: -radius, y: 0 },
  ];
  for (let step = 1; step <= radius; step += 1) {
    offsets.push(
      { x: radius, y: step },
      { x: radius, y: -step },
      { x: -radius, y: step },
      { x: -radius, y: -step },
      { x: step, y: radius },
      { x: -step, y: radius },
      { x: step, y: -radius },
      { x: -step, y: -radius },
    );
  }
  return offsets;
}

function canvasPositionIsOpen(
  occupants: CanvasOccupant[],
  position: { x: number; y: number },
  size: SynapseSize,
): boolean {
  return occupants.every(
    (occupant) =>
      position.x + size.width + nodeHorizontalGap <= occupant.position.x ||
      occupant.position.x + occupant.width + nodeHorizontalGap <= position.x ||
      position.y + size.height + nodeVerticalGap <= occupant.position.y ||
      occupant.position.y + occupant.height + nodeVerticalGap <= position.y,
  );
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
