export type FlowStatus = "active" | "paused";
export type FlowApprovalMode = "always_allow" | "require_approval";
export type FlowApprovalSetting = FlowApprovalMode | "inherit";
export type FlowConnectionRole = "source" | "destination";
export type FlowReasoningEffort = "none" | "low" | "medium" | "high";
export type FlowRunStatus = "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";
export type FlowStepStatus = "pending" | "completed" | "failed" | "denied";
export type FlowApprovalStatus = "pending" | "approved" | "denied";
export type FlowAgentProvider = "claude_code";
export type FlowTriggerType = "manual" | "api" | "schedule" | "event" | "new_email" | "file_created";

export interface ManualFlowTrigger {
  type: "manual";
}

export interface ApiFlowTrigger {
  type: "api";
}

export interface ScheduleFlowTrigger {
  type: "schedule";
  cron: string;
  timeZone: string;
}

export interface ProviderEventFlowTrigger {
  type: "event";
  connectionId: string;
  eventId: string;
  pollIntervalSeconds: number;
}

export interface NewEmailFlowTrigger {
  type: "new_email";
  connectionId: string;
  pollIntervalSeconds: number;
  query?: string;
}

export interface FileCreatedFlowTrigger {
  type: "file_created";
  connectionId: string;
  pollIntervalSeconds: number;
  folder?: string;
  extension?: string;
}

export type FlowTrigger =
  | ManualFlowTrigger
  | ApiFlowTrigger
  | ScheduleFlowTrigger
  | ProviderEventFlowTrigger
  | NewEmailFlowTrigger
  | FileCreatedFlowTrigger;

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
  /** Omitted only on definitions stored before role-specific grants were introduced. */
  role?: FlowConnectionRole;
  approval: FlowApprovalSetting;
}

export const defaultFlowMaxSteps = 20;
export const maximumFlowMaxSteps = 50;
export const maximumFlowSourceConnections = 16;

/** Durable definition for one directional agent flow into a connector or Synapse canvas. */
export interface FlowDefinition {
  id: string;
  revision: string;
  name: string;
  status: FlowStatus;
  /** Source connections available to the Flow agent. Present on all newly saved definitions. */
  sourceConnectionIds?: string[];
  /** Legacy single-source field retained only while reading definitions saved before multi-source Flows. */
  sourceConnectionId?: string;
  destinationConnectionId?: string;
  destinationSynapseId?: string;
  instructions: string;
  trigger: FlowTrigger;
  agent: FlowAgentConfig;
  tools: FlowToolGrant[];
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
}

export interface FlowDefinitionInput {
  name: string;
  status?: FlowStatus;
  sourceConnectionIds?: string[];
  /** Legacy input accepted for backward compatibility. Prefer sourceConnectionIds. */
  sourceConnectionId?: string;
  destinationConnectionId?: string;
  destinationSynapseId?: string;
  /** Creates a Synapse canvas and stores its resolved ID on the Flow. */
  destinationSynapseName?: string;
  instructions: string;
  trigger?: FlowTrigger;
  agent: Pick<FlowAgentConfig, "connectionId"> & Partial<Pick<FlowAgentConfig, "provider" | "reasoningEffort">>;
  tools: FlowToolGrant[];
  maxSteps?: number;
}

/** Resolve the canonical source list while retaining compatibility with legacy stored definitions. */
export function flowSourceConnectionIds(
  flow: Pick<FlowDefinition, "sourceConnectionIds" | "sourceConnectionId">,
): string[] {
  if (flow.sourceConnectionIds?.length) return [...flow.sourceConnectionIds];
  return flow.sourceConnectionId ? [flow.sourceConnectionId] : [];
}

/** Trigger configuration projected with the Flow fields needed by trigger-management clients. */
export interface FlowTriggerBinding {
  flowId: string;
  flowName: string;
  flowStatus: FlowStatus;
  trigger: Exclude<FlowTrigger, ManualFlowTrigger>;
  updatedAt: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowRevision: string;
  flowSnapshot: FlowDefinition;
  trigger: FlowTriggerType;
  triggerEvent?: FlowTriggerEvent;
  status: FlowRunStatus;
  stepCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  finalOutput?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface FlowTriggerEvent {
  type: FlowTriggerType;
  occurredAt: string;
  payload?: unknown;
}

export interface FlowTriggerState {
  flowId: string;
  flowRevision: string;
  initialized: boolean;
  seenIds: string[];
  lastScheduleKey?: string;
  lastCheckedAt?: string;
  lastTriggeredAt?: string;
  errorCode?: string;
  errorMessage?: string;
  updatedAt: string;
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
  setTriggerState(state: FlowTriggerState): Promise<void>;
  getTriggerState(flowId: string): Promise<FlowTriggerState | undefined>;
  deleteTriggerState(flowId: string): Promise<void>;
}
