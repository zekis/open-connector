import type { RunLogCaller } from "../storage/runtime-store.ts";

export type ConnectionApprovalMode = "always_allow" | "require_approval";
export type ActionApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface ConnectionActionPermission {
  connectionId: string;
  actionId: string;
  approval: ConnectionApprovalMode;
  updatedAt: string;
}

export interface ActionApproval {
  id: string;
  status: ActionApprovalStatus;
  actionId: string;
  connectionId: string;
  caller: RunLogCaller;
  input: unknown;
  requestHash: string;
  requestedAt: string;
  runtimeTokenId?: string;
  resolvedAt?: string;
  expiresAt?: string;
  consumedAt?: string;
}

export interface IConnectionApprovalStore {
  replacePermissions(connectionId: string, permissions: ConnectionActionPermission[]): Promise<void>;
  listPermissions(connectionId?: string): Promise<ConnectionActionPermission[]>;
  getPermission(connectionId: string, actionId: string): Promise<ConnectionActionPermission | undefined>;
  addActionApproval(approval: ActionApproval): Promise<void>;
  getActionApproval(id: string): Promise<ActionApproval | undefined>;
  listActionApprovals(limit?: number): Promise<ActionApproval[]>;
  findActionApproval(requestHash: string, status: ActionApprovalStatus): Promise<ActionApproval | undefined>;
  updateActionApproval(approval: ActionApproval, expectedStatus: ActionApprovalStatus): Promise<boolean>;
}
