export type FlowStatus = "active" | "paused";
export type FlowApprovalMode = "always_allow" | "require_approval";
export type FlowReasoningEffort = "none" | "low" | "medium" | "high";
export type FlowRunStatus = "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";
export type FlowStepStatus = "pending" | "completed" | "failed" | "denied";
export type FlowApprovalStatus = "pending" | "approved" | "denied";
export type FlowAgentProvider = "claude_code";

export interface FlowAgentConfig {
  /** Omitted on definitions created before Claude-only agent support. */
  provider?: FlowAgentProvider;
  connectionId: string;
  model: string;
  reasoningEffort: FlowReasoningEffort;
}

export interface FlowToolGrant {
  actionId: string;
  connectionId: string;
  approval: FlowApprovalMode;
}

/**
 * Durable definition for one directional, two-connection agent flow.
 */
export interface FlowDefinition {
  id: string;
  revision: string;
  name: string;
  status: FlowStatus;
  sourceConnectionId: string;
  destinationConnectionId: string;
  instructions: string;
  agent: FlowAgentConfig;
  tools: FlowToolGrant[];
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
}

export interface FlowDefinitionInput {
  name: string;
  status?: FlowStatus;
  sourceConnectionId: string;
  destinationConnectionId: string;
  instructions: string;
  agent: Pick<FlowAgentConfig, "connectionId"> & Partial<Pick<FlowAgentConfig, "provider" | "reasoningEffort">>;
  tools: FlowToolGrant[];
  maxSteps?: number;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowRevision: string;
  flowSnapshot: FlowDefinition;
  trigger: "manual";
  status: FlowRunStatus;
  stepCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  finalOutput?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface FlowStep {
  id: string;
  runId: string;
  sequence: number;
  kind: "agent" | "action";
  status: FlowStepStatus;
  startedAt: string;
  completedAt?: string;
  actionId?: string;
  connectionId?: string;
  approvalId?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface FlowApproval {
  id: string;
  flowId: string;
  runId: string;
  stepId: string;
  status: FlowApprovalStatus;
  actionId: string;
  connectionId: string;
  input: unknown;
  inputHash: string;
  modelResponseId: string;
  modelCallId: string;
  modelToolName: string;
  requestedAt: string;
  resolvedAt?: string;
}

/**
 * Storage boundary shared by the SQLite and D1 flow implementations.
 */
export interface IFlowStore {
  setFlow(flow: FlowDefinition): Promise<void>;
  getFlow(id: string): Promise<FlowDefinition | undefined>;
  listFlows(): Promise<FlowDefinition[]>;
  deleteFlow(id: string): Promise<boolean>;
  addRun(run: FlowRun): Promise<void>;
  updateRun(run: FlowRun): Promise<void>;
  getRun(id: string): Promise<FlowRun | undefined>;
  listRuns(flowId?: string, limit?: number): Promise<FlowRun[]>;
  addStep(step: FlowStep): Promise<void>;
  updateStep(step: FlowStep): Promise<void>;
  listSteps(runId: string): Promise<FlowStep[]>;
  addApproval(approval: FlowApproval): Promise<void>;
  getApproval(id: string): Promise<FlowApproval | undefined>;
  listApprovals(status?: FlowApprovalStatus): Promise<FlowApproval[]>;
  updateApproval(approval: FlowApproval, expectedStatus: FlowApprovalStatus): Promise<boolean>;
}
