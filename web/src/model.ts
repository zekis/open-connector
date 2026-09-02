export type AuthDefinition =
  | { type: "no_auth" }
  | {
      type: "api_key";
      label?: string;
      placeholder?: string;
      description?: string;
      extraFields?: CredentialField[];
    }
  | { type: "custom_credential"; fields: CredentialField[] }
  | {
      type: "oauth2";
      scopes: string[];
      clientConfigFields?: CredentialField[];
    };

export interface CredentialField {
  key: string;
  label: string;
  inputType: "text" | "password" | "textarea" | "json";
  required: boolean;
  secret: boolean;
  placeholder?: string;
  description?: string;
}

export type JsonSchema = Record<string, unknown>;

/**
 * Action as returned by `/api/providers`, which omits the JSON schemas to keep
 * the catalog listing small. Use {@link FullActionDefinition} where schemas are
 * required; load it from `/api/actions/:actionId`.
 */
export interface ActionDefinition {
  id: string;
  service: string;
  name: string;
  description: string;
  requiredScopes: string[];
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  execution: {
    locallyExecutable: boolean;
    catalogOnly: boolean;
    requiredAuthTypes: string[];
    noAuthRunnable: boolean;
    needsCredential: boolean;
  };
}

/** Action with schemas, as returned by `/api/actions/:actionId`. */
export interface FullActionDefinition extends ActionDefinition {
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

export interface ProviderDefinition {
  service: string;
  displayName: string;
  description?: string;
  categories: string[];
  authTypes: string[];
  auth: AuthDefinition[];
  homepageUrl?: string;
  iconUrl?: string;
  events?: ProviderEventDefinition[];
  actions: ActionDefinition[];
}

export interface ProviderEventDefinition {
  id: string;
  displayName: string;
  description: string;
  polling: ProviderEventPollingDefinition;
}

export interface ProviderEventPollingDefinition {
  actionId: string;
  input: Record<string, unknown>;
  result: ProviderEventPollingResult;
}

export interface ProviderEventItemFilter {
  field: string;
  exists?: boolean;
  equals?: string;
}

export interface ProviderEventRecordResult {
  kind: "records";
  collectionField: string;
  idFields: string[];
  include?: ProviderEventItemFilter;
}

export interface ProviderEventStringResult {
  kind: "strings";
  collectionField: string;
  payloadField: string;
}

export type ProviderEventPollingResult = ProviderEventRecordResult | ProviderEventStringResult;

export interface ConnectionRecord {
  id?: string;
  service: string;
  connectionName?: string;
  authType: string;
  configured?: boolean;
  virtual?: boolean;
  default?: boolean;
  profile?: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export interface OAuthConfig {
  service: string;
  configured: boolean;
  clientId: string | null;
  expectedRedirectUri?: string;
  auth?: Extract<AuthDefinition, { type: "oauth2" }>;
}

export interface RuntimeTokenSummary {
  id: string;
  name: string;
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  createdAt: string;
  lastUsedAt?: string;
}

export interface PolicyRules {
  allowedActions: string[];
  blockedActions: string[];
  allowedProxies: string[];
  blockedProxies: string[];
}

export interface RuntimePolicyState {
  deployment: PolicyRules;
  runtime: PolicyRules;
  updatedAt?: string;
}

export interface PolicyCheck {
  source: "deployment" | "runtime" | "token";
  outcome: "allow_match" | "block_match" | "allow_miss";
  rule?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  code?: string;
  message?: string;
  checks: PolicyCheck[];
}

export interface RuntimeTokenCreation {
  token: string;
  record: RuntimeTokenSummary;
}

export interface RunLog {
  id: string;
  service: string;
  actionId: string;
  caller: "http" | "mcp" | "web" | "flow" | "chat" | "trigger";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  ok: boolean;
  connectionId?: string;
  runtimeTokenId?: string;
  flowId?: string;
  flowRunId?: string;
  flowStepId?: string;
  policy?: PolicyDecision;
  connectionProfile?: {
    displayName?: string;
  };
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface RunLogPage {
  items: RunLog[];
  nextCursor?: string;
}

export interface ExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface RuntimeActionResponse {
  success: boolean;
  message?: string;
  data?: unknown;
  errorCode?: string;
}

export type FlowApprovalMode = "always_allow" | "require_approval";
export type FlowApprovalSetting = FlowApprovalMode | "inherit";
export type FlowRunStatus = "running" | "waiting_for_approval" | "completed" | "failed" | "cancelled";
export type FlowFeedImageMotif =
  | "automation"
  | "calendar"
  | "chart"
  | "document"
  | "files"
  | "message"
  | "people"
  | "success"
  | "warning";
export type FlowFeedImagePalette = "amber" | "blue" | "rose" | "slate" | "teal" | "violet";

export interface FlowFeedPost {
  text: string;
  image: {
    alt: string;
    headline: string;
    motif: FlowFeedImageMotif;
    palette: FlowFeedImagePalette;
  };
}
export type FlowTriggerType = "manual" | "api" | "schedule" | "event" | "new_email" | "file_created";

export type FlowTrigger =
  | { type: "manual" }
  | { type: "api" }
  | { type: "schedule"; cron: string; timeZone: string }
  | { type: "event"; connectionId: string; eventId: string; pollIntervalSeconds: number }
  | { type: "new_email"; connectionId: string; pollIntervalSeconds: number; query?: string }
  | {
      type: "file_created";
      connectionId: string;
      pollIntervalSeconds: number;
      folder?: string;
      extension?: string;
    };

export interface FlowTriggerEvent {
  type: FlowTriggerType;
  occurredAt: string;
  payload?: unknown;
}

export interface FlowToolGrant {
  actionId: string;
  connectionId: string;
  role?: "source" | "destination";
  approval: FlowApprovalSetting;
}

export interface ConnectionActionPermission {
  connectionId: string;
  actionId: string;
  approval: FlowApprovalMode;
  updatedAt: string;
}

export interface ActionApproval {
  id: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  actionId: string;
  connectionId: string;
  caller: RunLog["caller"];
  input: unknown;
  requestedAt: string;
  runtimeTokenId?: string;
  resolvedAt?: string;
  expiresAt?: string;
  consumedAt?: string;
  execution?: {
    executionId: string;
    auditPersisted: boolean;
    result: {
      ok: boolean;
      output?: unknown;
      error?: { code: string; message: string; details?: unknown };
    };
    completedAt: string;
  };
}

export interface FlowDefinition {
  id: string;
  revision: string;
  name: string;
  status: "active" | "paused";
  sourceConnectionIds?: string[];
  /** Legacy field returned only by runtimes that predate multi-source Flows. */
  sourceConnectionId?: string;
  destinationConnectionId?: string;
  destinationSynapseId?: string;
  instructions: string;
  trigger: FlowTrigger;
  agent: {
    provider?: AgentProvider;
    connectionId: string;
    model: string;
    reasoningEffort: "none" | "low" | "medium" | "high";
  };
  tools: FlowToolGrant[];
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
}

export function flowSourceConnectionIds(
  flow: Pick<FlowDefinition, "sourceConnectionIds" | "sourceConnectionId">,
): string[] {
  if (flow.sourceConnectionIds?.length) return [...flow.sourceConnectionIds];
  return flow.sourceConnectionId ? [flow.sourceConnectionId] : [];
}

export interface AgentConnectionSummary {
  id: string;
  provider: AgentProvider;
  authType: "subscription_oauth" | "chatgpt_subscription";
  configured: true;
  displayName: string;
  updatedAt?: string;
}

export interface AgentRuntimeSettings {
  provider: AgentProvider;
  model: string;
}

export interface AgentModelOption {
  id: string;
  displayName: string;
}

export type AgentProvider = "claude_code" | "openai_codex";

export interface TeamsGatewayToolGrant {
  connectionId: string;
  actionIds: string[];
}

export interface TeamsGatewayAgent {
  id: string;
  name: string;
  enabled: boolean;
  teamsConnectionId: string;
  agentProvider: AgentProvider;
  instructions?: string;
  allowedDomains: string[];
  allowedExternalUsers: string[];
  proactiveDmUsers: string[];
  confirmBeforeTools: boolean;
  threadWindowHours: number;
  toolGrants: TeamsGatewayToolGrant[];
  presence?: {
    status: "online" | "offline" | "error" | "pending";
    lastSetAt?: string;
    lastAttemptAt?: string;
    error?: string;
  };
  watchStartedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsGatewayThread {
  id: string;
  agentId: string;
  chatId: string;
  participantEmail: string;
  participantName: string;
  pendingPlan?: { summary: string };
  pendingApprovalIds?: string[];
  updatedAt: string;
}

export interface TeamsGatewayGroupMember {
  userId: string;
  email?: string;
  displayName: string;
}

export interface TeamsGatewayGroup {
  id: string;
  agentId: string;
  kind: "team" | "group_chat";
  enabled: boolean;
  externalId: string;
  displayName: string;
  description?: string;
  webUrl?: string;
  members: TeamsGatewayGroupMember[];
  channels: Array<{
    id: string;
    displayName: string;
    description?: string;
    webUrl?: string;
  }>;
  updatedAt: string;
}

export interface TeamsGatewayAgentMetrics {
  agentId: string;
  presence: "online" | "offline" | "error" | "pending";
  teamCount: number;
  channelCount: number;
  groupChatCount: number;
  directChatCount: number;
  activeThreadCount: number;
  handledMessageCount: number;
  replyCount: number;
  pendingPlanCount: number;
  pendingApprovalCount: number;
}

export interface FlowRun {
  id: string;
  flowId: string;
  status: FlowRunStatus;
  trigger: FlowTriggerType;
  triggerEvent?: FlowTriggerEvent;
  stepCount: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  finalOutput?: string;
  feedPost?: FlowFeedPost;
  errorCode?: string;
  errorMessage?: string;
}

export interface FlowStep {
  id: string;
  runId: string;
  sequence: number;
  kind: "agent" | "action";
  status: "pending" | "completed" | "failed" | "denied";
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
  status: "pending" | "approved" | "denied";
  actionId: string;
  connectionId: string;
  input: unknown;
  requestedAt: string;
  resolvedAt?: string;
}

export interface FlowRunDetail {
  run: FlowRun;
  steps: FlowStep[];
  approvals: FlowApproval[];
}

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

export interface AgentChatApprovalResult {
  approvalId: string;
  status: ActionApproval["status"];
  response?: AgentChatResponse;
}

export interface AgentChatInterruptionDecision {
  cancelCurrentTask: boolean;
  reason: string;
}

export interface FeedCommentToolActivity {
  id: string;
  type: "search" | "action";
  label: string;
  ok: boolean;
  actionId?: string;
  connectionDisplayName?: string;
  approvalId?: string;
}

export interface FeedComment {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  toolActivity?: FeedCommentToolActivity[];
  approvalId?: string;
}

export interface FeedApprovalSummary {
  id: string;
  kind: "flow" | "action";
  status: FlowApproval["status"] | ActionApproval["status"];
  actionId: string;
  connectionId: string;
  input: unknown;
  requestedAt: string;
}

export interface FeedActionSummary {
  id: string;
  actionId: string;
  connectionId?: string;
  status: "pending" | "completed" | "failed" | "denied";
}

export type FeedPreviewKind = "email" | "web" | "image" | "pdf" | "document" | "file";

export interface FeedPreview {
  id: string;
  kind: FeedPreviewKind;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  summary?: string;
  contentUrl?: string;
  externalUrl?: string;
}

export interface FeedItem {
  id: string;
  kind: "trigger" | "approval";
  createdAt: string;
  updatedAt: string;
  title: string;
  summary?: string;
  author?: string;
  providerService?: string;
  post: FlowFeedPost;
  previews: FeedPreview[];
  flow?: {
    id: string;
    name: string;
    runId: string;
    status: FlowRun["status"];
    trigger: FlowRun["trigger"];
  };
  agentSummary?: string;
  actions: FeedActionSummary[];
  comments: FeedComment[];
  approvals: FeedApprovalSummary[];
  canReply: boolean;
}

export interface FeedPage {
  items: FeedItem[];
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
  previews?: FeedPreview[];
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

export interface SynapseMessage extends AgentChatMessage {
  id: string;
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

export type AgentChatStreamEvent =
  | { type: "progress"; progress: AgentChatProgress }
  | { type: "response"; response: AgentChatResponse }
  | { type: "error"; error: { code: string; message: string } };

export interface SaynaVoiceConfiguration {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  provider: "sayna";
  speechProvider: "elevenlabs";
  voiceId: string;
  websocketPath?: string;
  ttsSampleRate?: number;
}

export interface AppData {
  providers: ProviderDefinition[];
  connections: ConnectionRecord[];
  oauthConfigs: OAuthConfig[];
  runtimeTokens: RuntimeTokenSummary[];
  runtimePolicy?: RuntimePolicyState;
  runs: RunLog[];
  runsNextCursor?: string;
  flows?: FlowDefinition[];
  flowRuns?: FlowRun[];
  flowApprovals?: FlowApproval[];
  connectionPermissions?: ConnectionActionPermission[];
  actionApprovals?: ActionApproval[];
  agentConnections?: AgentConnectionSummary[];
  agentSettings?: AgentRuntimeSettings[];
  agentModels?: Record<AgentProvider, AgentModelOption[]>;
}

export type KanbanScalar = string | number | boolean | null;

export interface KanbanColumn {
  id: string;
  label: string;
  value: KanbanScalar;
  color?: string;
}

export interface KanbanCardMapping {
  id: string;
  title: string;
  column: string;
  description?: string;
  priority?: string;
  labels?: string;
  assignee?: string;
  dueDate?: string;
  url?: string;
  revision?: string;
}

export interface KanbanWriteBack {
  actionId: string;
  inputTemplate: Record<string, unknown>;
}

export interface KanbanSource {
  id: string;
  name: string;
  connectionId: string;
  actionId: string;
  input: Record<string, unknown>;
  itemsPath: string;
  mapping: KanbanCardMapping;
  writeBack?: KanbanWriteBack;
}

export interface KanbanBoardDefinitionInput {
  name: string;
  cardLimit?: number;
  columns: KanbanColumn[];
  sources: KanbanSource[];
}

export interface KanbanBoardDefinition extends KanbanBoardDefinitionInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanBoardSummary {
  id: string;
  name: string;
  columnCount: number;
  sourceCount: number;
  editableSourceCount: number;
  updatedAt: string;
}

export interface KanbanCard {
  key: string;
  sourceId: string;
  connectionId: string;
  providerService: string;
  externalId: string;
  title: string;
  columnId: string;
  editable: boolean;
  description?: string;
  priority?: KanbanScalar;
  labels?: string[];
  assignee?: string;
  dueDate?: string;
  url?: string;
  revision?: KanbanScalar;
  pending?: {
    columnId: string;
    approvalId: string;
    status: "waiting_for_approval";
  };
}

export interface KanbanSourceResult {
  sourceId: string;
  status: "completed" | "failed" | "waiting_for_approval";
  itemCount: number;
  skippedCount: number;
  limited?: boolean;
  approvalId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface KanbanBoardSnapshot {
  board: KanbanBoardDefinition;
  cards: KanbanCard[];
  sources: KanbanSourceResult[];
  refreshedAt: string;
}

export interface KanbanMoveResult {
  status: "completed" | "waiting_for_approval";
  snapshot: KanbanBoardSnapshot;
  approvalId?: string;
}

export interface KanbanPreset {
  id: string;
  service: string;
  name: string;
  description: string;
  boardName: string;
  columns: KanbanColumn[];
  source: Omit<KanbanSource, "connectionId">;
}

export interface OverviewSummary {
  providerCount: number;
  actionCount: number;
  locallyExecutableActionCount: number;
  connectedCount: number;
  activeTokenCount: number;
  failedRunCount: number;
  failedRuns: RunLog[];
}

export interface ProviderConnectionStatus {
  noSetupRequired: boolean;
  connected: boolean;
  oauthClientRequired: boolean;
  connections: ConnectionRecord[];
  connection?: ConnectionRecord;
}

const firstProviderService = "fusion-api";
const recommendedProviderServices = [
  "googlesheets",
  "gmail",
  "slack",
  "googlecalendar",
  "googledrive",
  "github",
  "azure_devops",
  "notion",
  "hubspot",
  "googleforms",
  "airtable",
  "trello",
  "asana",
  "jira",
  "linear",
  "clickup",
  "monday",
  "googledocs",
  "googleslides",
  "dropbox",
  "box",
  "confluence",
  "outlook",
  "outlook_calendar",
  "microsoft_todo",
  "sharepoint",
  "discord",
  "telegram",
  "twilio",
  "sendgrid",
  "mailchimp",
  "shopify",
  "stripe",
  "googleanalytics",
  "googlesearchconsole",
  "facebookleadads",
  "metaads",
  "linkedin",
  "salesforce",
  "pipedrive",
  "zendesk",
  "intercom",
  "openai",
  "anthropic",
  "gemini",
  "perplexity",
  "deepseek",
  "gitlab",
  "dockerhub",
  "vercel",
  "cloudflareworker",
  "awss3",
  "cloudflarer2",
  "googlebigquery",
] as const;
const recommendedProviderServiceRank = new Map(
  recommendedProviderServices.map((service, index) => [compactProviderService(service), index]),
);

export const emptyData: AppData = {
  providers: [],
  connections: [],
  oauthConfigs: [],
  runtimeTokens: [],
  runtimePolicy: {
    deployment: emptyPolicyRules(),
    runtime: emptyPolicyRules(),
  },
  runs: [],
  flows: [],
  flowRuns: [],
  flowApprovals: [],
  connectionPermissions: [],
  actionApprovals: [],
  agentConnections: [],
  agentSettings: [],
  agentModels: { claude_code: [], openai_codex: [] },
};

function emptyPolicyRules(): PolicyRules {
  return {
    allowedActions: [],
    blockedActions: [],
    allowedProxies: [],
    blockedProxies: [],
  };
}

export function createOverviewSummary(data: AppData): OverviewSummary {
  const actions = data.providers.flatMap((provider) => provider.actions);
  const failedRuns = data.runs.filter((run) => !run.ok);
  return {
    providerCount: data.providers.length,
    actionCount: actions.length,
    locallyExecutableActionCount: actions.filter((action) => action.execution.locallyExecutable).length,
    connectedCount: data.connections.filter(isUsableCredentialConnection).length,
    activeTokenCount: data.runtimeTokens.length,
    failedRunCount: failedRuns.length,
    failedRuns: failedRuns.slice(0, 5),
  };
}

export function resolveProviderConnectionStatus(
  provider: ProviderDefinition,
  connections: ConnectionRecord[],
  oauthConfigs: OAuthConfig[],
): ProviderConnectionStatus {
  const noSetupRequired = isNoAuthOnlyProvider(provider);
  const serviceConnections = noSetupRequired ? [] : usableConnectionsForService(connections, provider.service);
  const connection = pickUsableCredentialConnection(serviceConnections);
  return {
    noSetupRequired,
    connected: connection != null,
    oauthClientRequired:
      connection == null && providerRequiresOAuth(provider) && !oauthClientConfigured(provider.service, oauthConfigs),
    connections: serviceConnections,
    connection,
  };
}

export function usableConnectionsForService(connections: ConnectionRecord[], service: string): ConnectionRecord[] {
  return connections.filter((connection) => connection.service === service && isUsableCredentialConnection(connection));
}

export function isNoAuthOnlyProvider(provider: ProviderDefinition): boolean {
  const authTypes = provider.auth.length > 0 ? provider.auth.map((auth) => auth.type) : provider.authTypes;
  return authTypes.length === 0 || authTypes.every((authType) => authType === "no_auth");
}

function pickUsableCredentialConnection(connections: ConnectionRecord[]): ConnectionRecord | undefined {
  const usableConnections = connections.filter(isUsableCredentialConnection);
  return usableConnections.find((connection) => connection.default) ?? usableConnections[0];
}

function isUsableCredentialConnection(connection: ConnectionRecord | undefined): connection is ConnectionRecord {
  return (
    connection != null &&
    connection.authType !== "no_auth" &&
    connection.virtual !== true &&
    connection.configured !== false
  );
}

function providerRequiresOAuth(provider: ProviderDefinition): boolean {
  const authTypes = provider.auth.length > 0 ? provider.auth.map((auth) => auth.type) : provider.authTypes;
  return authTypes.includes("oauth2") && authTypes.every((authType) => authType === "oauth2");
}

function oauthClientConfigured(service: string, oauthConfigs: OAuthConfig[]): boolean {
  return oauthConfigs.some((config) => config.service === service && config.configured);
}

export function credentialFieldsFor(auth: AuthDefinition): CredentialField[] {
  if (auth.type === "api_key") {
    return [
      {
        key: "apiKey",
        label: auth.label ?? "API key",
        inputType: "password",
        required: true,
        secret: true,
        placeholder: auth.placeholder,
        description: auth.description,
      },
      ...(auth.extraFields ?? []),
    ];
  }
  if (auth.type === "custom_credential") return auth.fields;
  return [];
}

export function filterProviders(providers: ProviderDefinition[], query: string): ProviderDefinition[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return providers;
  return providers.filter((provider) =>
    [provider.displayName, provider.service, provider.categories.join(" "), provider.authTypes.join(" ")]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
}

export function sortProviders(
  providers: ProviderDefinition[],
  connectionsByService: Map<string, ConnectionRecord>,
): ProviderDefinition[] {
  return [...providers].sort((left, right) => {
    const leftConnected = isUsableCredentialConnection(connectionsByService.get(left.service));
    const rightConnected = isUsableCredentialConnection(connectionsByService.get(right.service));
    if (leftConnected !== rightConnected) {
      return leftConnected ? -1 : 1;
    }

    const leftPinned = left.service === firstProviderService;
    const rightPinned = right.service === firstProviderService;
    if (leftPinned !== rightPinned) {
      return leftPinned ? -1 : 1;
    }

    const recommendedRank =
      getRecommendedProviderServiceRank(left.service) - getRecommendedProviderServiceRank(right.service);
    if (recommendedRank !== 0) return recommendedRank;

    return left.displayName.localeCompare(right.displayName);
  });
}

function getRecommendedProviderServiceRank(service: string): number {
  return recommendedProviderServiceRank.get(compactProviderService(service)) ?? Number.MAX_SAFE_INTEGER;
}

function compactProviderService(service: string): string {
  return service
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "");
}

export function firstProviderByConnectionStatus(
  providers: ProviderDefinition[],
  connections: ConnectionRecord[],
): ProviderDefinition | undefined {
  return sortProviders(providers, new Map(connections.map((connection) => [connection.service, connection])))[0];
}

export function filterActions(actions: ActionDefinition[], query: string, service: string | null): ActionDefinition[] {
  const normalized = query.trim().toLowerCase();
  return actions.filter((action) => {
    if (service && action.service !== service) return false;
    if (!normalized) return true;
    return [action.id, action.name, action.description, action.requiredScopes.join(" ")]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

export function exampleInput(schema: JsonSchema): string {
  const properties = readProperties(schema);
  const required = readRequired(schema);
  const value: Record<string, unknown> = {};
  for (const key of required) {
    value[key] = exampleValue(properties[key]);
  }
  return JSON.stringify(value, null, 2);
}

export function parameterSummaries(
  schema: JsonSchema,
): Array<{ name: string; required: boolean; type: string; description: string }> {
  const required = new Set(readRequired(schema));
  return Object.entries(readProperties(schema)).map(([name, property]) => ({
    name,
    required: required.has(name),
    type: describeSchemaType(property),
    description: typeof property.description === "string" ? property.description : "",
  }));
}

export function buildActionExamples(action: FullActionDefinition): { curl: string; typescript: string } {
  const body = { input: JSON.parse(exampleInput(action.inputSchema)) as unknown };
  const bodyText = JSON.stringify(body, null, 2);
  return {
    curl: [
      `curl -s http://localhost:3000/v1/actions/${action.id} \\`,
      "  -H 'content-type: application/json' \\",
      `  -d '${JSON.stringify(body)}'`,
    ].join("\n"),
    typescript: [
      `const response = await fetch("http://localhost:3000/v1/actions/${action.id}", {`,
      `  method: "POST",`,
      `  headers: { "content-type": "application/json" },`,
      `  body: JSON.stringify(${bodyText}),`,
      `});`,
      `const result = await response.json();`,
    ].join("\n"),
  };
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatDuration(run: RunLog): string {
  const ms =
    typeof run.durationMs === "number"
      ? run.durationMs
      : Math.max(0, new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime());
  return `${ms} ms`;
}

export function compactJson(value: unknown): string {
  if (value == null) {
    return "";
  }

  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function readProperties(schema: JsonSchema): Record<string, JsonSchema> {
  return schema.properties && typeof schema.properties === "object"
    ? (schema.properties as Record<string, JsonSchema>)
    : {};
}

function readRequired(schema: JsonSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function describeSchemaType(schema: JsonSchema | undefined): string {
  if (!schema) return "unknown";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.map((value) => describeSchemaType(value as JsonSchema)).join(" | ");
  return typeof schema.type === "string" ? schema.type : "unknown";
}

function exampleValue(schema: JsonSchema | undefined): unknown {
  if (!schema) return "";
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return "";
}
