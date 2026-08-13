export interface AgentChatMessage {
  role: "user" | "assistant";
  content: string;
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
}

export type AgentChatProgressListener = (progress: AgentChatProgress) => void | Promise<void>;

export interface AgentChatResponse {
  status: "completed" | "waiting_for_approval" | "failed";
  approvalId?: string;
  message: AgentChatMessage & {
    id: string;
    createdAt: string;
  };
  toolActivity: AgentChatToolActivity[];
}

export interface AgentChatApprovalContinuation {
  messages: AgentChatMessage[];
  toolActivity: AgentChatToolActivity[];
  response?: AgentChatResponse;
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
