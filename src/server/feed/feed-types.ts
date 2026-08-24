import type { ActionApprovalStatus } from "../approvals/connection-approval-types.ts";
import type {
  FlowApprovalStatus,
  FlowFeedPost,
  FlowRunStatus,
  FlowStepStatus,
  FlowTriggerType,
} from "../flows/flow-types.ts";
import type { ProviderPreview, ProviderPreviewContent, ProviderPreviewKind } from "../previews/provider-preview.ts";

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

export interface FeedThread {
  id: string;
  flowRunId: string;
  comments: FeedComment[];
  pendingApprovalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IFeedStore {
  setThread(thread: FeedThread): Promise<void>;
  getThread(id: string): Promise<FeedThread | undefined>;
  listThreads(limit?: number): Promise<FeedThread[]>;
}

export interface FeedApprovalSummary {
  id: string;
  kind: "flow" | "action";
  status: FlowApprovalStatus | ActionApprovalStatus;
  actionId: string;
  connectionId: string;
  input: unknown;
  requestedAt: string;
}

export interface FeedActionSummary {
  id: string;
  actionId: string;
  connectionId?: string;
  status: FlowStepStatus;
}

export interface FeedFlowSummary {
  id: string;
  name: string;
  runId: string;
  status: FlowRunStatus;
  trigger: FlowTriggerType;
}

export type FeedPreviewKind = ProviderPreviewKind;

export interface FeedPreview extends ProviderPreview {}

export interface FeedPreviewContent extends ProviderPreviewContent {}

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
  flow?: FeedFlowSummary;
  agentSummary?: string;
  actions: FeedActionSummary[];
  comments: FeedComment[];
  approvals: FeedApprovalSummary[];
  canReply: boolean;
}

export interface FeedPage {
  items: FeedItem[];
}
