export interface AgentChatAttachment {
  id?: string;
  fileId?: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl?: string;
  error?: string;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: AgentChatAttachment[];
}

export interface AgentChatToolActivity {
  id: string;
  type: "search" | "action";
  label: string;
  ok: boolean;
  actionId?: string;
  connectionId?: string;
  connectionDisplayName?: string;
  approvalId?: string;
  input: unknown;
  output: unknown;
}

export interface AgentChatProgress {
  id: string;
  phase: "tool_started" | "tool_completed";
  message: string;
  speech: string;
  tool?: AgentChatProgressTool;
}

export interface AgentChatProgressTool {
  id: string;
  name: string;
  type: AgentChatToolActivity["type"];
  label: string;
  actionId?: string;
  connectionId?: string;
  connectionDisplayName?: string;
  input: unknown;
  activity?: AgentChatToolActivity;
}

export type AgentChatProgressListener = (progress: AgentChatProgress) => void | Promise<void>;

export interface AgentChatResponse {
  status: "completed" | "waiting_for_approval" | "failed";
  approvalId?: string;
  approvalIds?: string[];
  message: AgentChatMessage & {
    id: string;
    createdAt: string;
  };
  toolActivity: AgentChatToolActivity[];
}

export interface AgentChatApprovalContinuation {
  messages: AgentChatMessage[];
  toolActivity: AgentChatToolActivity[];
  batchApprovalIds?: string[];
  voiceMode?: boolean;
  timeZone?: string;
  agentProvider?: AgentProvider;
  response?: AgentChatResponse;
}

export interface AgentChatInterruptionDecision {
  cancelCurrentTask: boolean;
  reason: string;
}

export interface AgentChatApprovalResult {
  approvalId: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  response?: AgentChatResponse;
}

export type AgentChatStreamEvent =
  | { type: "progress"; progress: AgentChatProgress }
  | { type: "response"; response: AgentChatResponse }
  | { type: "error"; error: { code: string; message: string } };
import type { AgentProvider } from "../agents/agent-credential-service.ts";
