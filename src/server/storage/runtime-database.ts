import type { IConnectionStore } from "../../connection-service.ts";
import type { IOAuthClientConfigStore } from "../../oauth/oauth-client-config-service.ts";
import type { IOAuthStateStore } from "../../oauth/oauth-flow-service.ts";
import type { IConnectionApprovalStore } from "../approvals/connection-approval-types.ts";
import type { IMobileAuthStore } from "../auth/mobile-auth-service.ts";
import type { IFeedStore } from "../feed/feed-types.ts";
import type { IFlowStore } from "../flows/flow-types.ts";
import type { IKanbanStore } from "../kanban/kanban-types.ts";
import type { ISynapseStore } from "../synapse/synapse-types.ts";
import type { IIdempotencyStore } from "./idempotency-store.ts";
import type { IRuntimePolicyStore } from "./runtime-policy-store.ts";
import type { IRunLogStore } from "./runtime-store.ts";
import type { IRuntimeTokenStore } from "./runtime-token-service.ts";

export interface RuntimeDatabase {
  connectionStore: IConnectionStore;
  oauthClientConfigStore: IOAuthClientConfigStore;
  oauthStateStore: IOAuthStateStore;
  runtimeTokenStore: IRuntimeTokenStore;
  mobileAuthStore: IMobileAuthStore;
  runtimePolicyStore: IRuntimePolicyStore;
  runLogStore: IRunLogStore;
  idempotencyStore: IIdempotencyStore;
  flowStore: IFlowStore;
  feedStore: IFeedStore;
  connectionApprovalStore: IConnectionApprovalStore;
  synapseStore: ISynapseStore;
  kanbanStore: IKanbanStore;
}
