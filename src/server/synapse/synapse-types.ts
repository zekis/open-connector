import type { AgentChatProgress, AgentChatToolActivity } from "../chat/agent-chat-types.ts";
import type { ProviderPreview } from "../previews/provider-preview.ts";

export type SynapseNodeKind = "provider" | "artifact";
export type SynapseArtifactKind = "email" | "draft" | "document" | "search_result" | "note" | "task" | "generic";

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
}

export type SynapseNode = SynapseProviderNode | SynapseArtifactNode;

export interface SynapseEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  createdAt: string;
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
  nodes: SynapseNode[];
  edges: SynapseEdge[];
  threads: SynapseThread[];
  createdAt: string;
  updatedAt: string;
}

export interface SynapseWorkspaceSummary {
  id: string;
  name: string;
  nodeCount: number;
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
