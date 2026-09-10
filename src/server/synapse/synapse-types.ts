import type { AgentChatProgress, AgentChatToolActivity } from "../chat/agent-chat-types.ts";
import type { ProviderPreview } from "../previews/provider-preview.ts";

export type SynapseNodeKind = "provider" | "artifact";
export type SynapseRelationshipKind =
  | "related_to"
  | "calculated_from"
  | "attached_to"
  | "saved_in"
  | "sent_to"
  | "uses"
  | "produced";
export type SynapseRelationshipState = "proposed" | "confirmed";
export type SynapseInstructionStatus = "running" | "waiting_for_approval" | "completed" | "failed";
export type SynapseRunStatus = SynapseInstructionStatus;
export type SynapseRecipePeriod = "day" | "week" | "month" | "quarter" | "year";
export type SynapseRecipeDateFormat = "iso_date" | "iso_datetime";
export type SynapseRecipeExpression =
  | {
      $synapse: "now";
      format?: SynapseRecipeDateFormat;
    }
  | {
      $synapse: "period";
      period: SynapseRecipePeriod;
      edge: "start" | "end";
      offset?: number;
      format?: SynapseRecipeDateFormat;
    };

export interface SynapseRecipeLastRun {
  runId: string;
  status: "completed" | "failed";
  resolvedInput: Record<string, unknown>;
  completedAt: string;
  error?: string;
}

export interface SynapseObjectRecipe {
  version: 1;
  actionId: string;
  connectionId: string;
  input: Record<string, unknown>;
  result: {
    mode: "replace";
    match: "source_identity" | "first";
  };
  lastRun?: SynapseRecipeLastRun;
}
export type SynapseArtifactKind =
  | "question"
  | "email"
  | "draft"
  | "document"
  | "search_result"
  | "note"
  | "task"
  | "generic";

export type SynapseArtifactDisplay =
  | SynapseListDisplay
  | SynapseTableDisplay
  | SynapseKanbanDisplay
  | SynapseCanvasDisplay
  | SynapseChartDisplay
  | SynapseGraphDisplay;

export interface SynapseListDisplay {
  type: "list";
  items: Array<{ title: string; detail?: string; status?: string }>;
}

export interface SynapseTableDisplay {
  type: "table";
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export interface SynapseKanbanDisplay {
  type: "kanban";
  columns: Array<{
    title: string;
    items: Array<{ title: string; detail?: string }>;
  }>;
}

export interface SynapseCanvasDisplay {
  type: "canvas";
  items: Array<{ title: string; content?: string; x: number; y: number }>;
}

export interface SynapseChartDisplay {
  type: "chart";
  chartType: "bar" | "line" | "pie";
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
}

export interface SynapseGraphDisplay {
  type: "graph";
  nodes: Array<{ id: string; label: string; group?: string }>;
  edges: Array<{ source: string; target: string; label?: string }>;
}

export interface SynapsePosition {
  x: number;
  y: number;
}

export interface SynapseSize {
  width: number;
  height: number;
}

interface SynapseNodeBase {
  id: string;
  kind: SynapseNodeKind;
  title: string;
  position: SynapsePosition;
  size?: SynapseSize;
  autoSize?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SynapseProviderNode extends SynapseNodeBase {
  kind: "provider";
  connectionId: string;
  service: string;
  instructions?: string;
}

export interface SynapseArtifactNode extends SynapseNodeBase {
  kind: "artifact";
  artifactKind: SynapseArtifactKind;
  summary?: string;
  content?: string;
  display?: SynapseArtifactDisplay;
  externalUrl?: string;
  sourceActionId?: string;
  sourceConnectionId?: string;
  sourceActivityId?: string;
  sourceInput?: Record<string, unknown>;
  itemIdentity?: string;
  approvalIds?: string[];
  groupId?: string;
  groupOrder?: number;
  ungrouped?: boolean;
  previews?: ProviderPreview[];
  data?: unknown;
  recipe?: SynapseObjectRecipe;
}

export type SynapseNode = SynapseProviderNode | SynapseArtifactNode;

export interface SynapseEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  relationshipKind?: SynapseRelationshipKind;
  state?: SynapseRelationshipState;
  createdAt: string;
}

export interface SynapseInstruction {
  id: string;
  content: string;
  targetObjectIds: string[];
  status: SynapseInstructionStatus;
  runId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SynapseRunAction {
  actionId: string;
  connectionId?: string;
  status: "waiting_for_approval" | "completed" | "failed";
}

export interface SynapseRun {
  id: string;
  instructionId: string;
  status: SynapseRunStatus;
  inputObjectIds: string[];
  outputObjectIds: string[];
  actions: SynapseRunAction[];
  summary?: string;
  attention?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SynapseMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolActivity?: AgentChatToolActivity[];
}

export interface SynapseThread {
  nodeId: string;
  messages: SynapseMessage[];
  pendingApprovalId?: string;
  pendingApprovalIds?: string[];
  pendingMessageId?: string;
  updatedAt: string;
}

export interface SynapseWorkspace {
  id: string;
  name: string;
  schemaVersion?: 2;
  nodes: SynapseNode[];
  edges: SynapseEdge[];
  threads: SynapseThread[];
  instructions?: SynapseInstruction[];
  runs?: SynapseRun[];
  createdAt: string;
  updatedAt: string;
}

export interface SynapseWorkspaceSummary {
  id: string;
  name: string;
  nodeCount: number;
  attentionCount?: number;
  updatedAt: string;
}

export interface SynapseSelectionResult {
  workspace: SynapseWorkspace;
  resultNodeId: string;
}

export type SynapseChatStreamEvent =
  | { type: "progress"; progress: AgentChatProgress }
  | { type: "workspace"; workspace: SynapseWorkspace }
  | { type: "error"; error: { code: string; message: string } };

export interface ISynapseStore {
  setWorkspace(workspace: SynapseWorkspace): Promise<void>;
  getWorkspace(id: string): Promise<SynapseWorkspace | undefined>;
  listWorkspaces(limit?: number): Promise<SynapseWorkspace[]>;
  deleteWorkspace(id: string): Promise<boolean>;
}
