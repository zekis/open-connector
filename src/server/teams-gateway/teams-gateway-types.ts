import type { AgentProvider } from "../agents/agent-credential-service.ts";
import type { AgentChatMessage, AgentChatToolActivity } from "../chat/agent-chat-types.ts";

export interface TeamsGatewayToolGrant {
  connectionId: string;
  actionIds: string[];
}

export type TeamsGatewayPresenceStatus = "online" | "offline" | "error" | "pending";

export interface TeamsGatewayPresence {
  status: TeamsGatewayPresenceStatus;
  lastSetAt?: string;
  lastAttemptAt?: string;
  error?: string;
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
  presence?: TeamsGatewayPresence;
  watchStartedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsGatewayGroupMember {
  userId: string;
  email?: string;
  displayName: string;
}

export interface TeamsGatewayChannel {
  id: string;
  displayName: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
  watchStartedAt: string;
}

export interface TeamsGatewayGroup {
  id: string;
  agentId: string;
  kind: "team" | "group_chat";
  externalId: string;
  displayName: string;
  description?: string;
  tenantId?: string;
  webUrl?: string;
  members: TeamsGatewayGroupMember[];
  channels: TeamsGatewayChannel[];
  discoveredAt: string;
  updatedAt: string;
}

export interface TeamsGatewayPlan {
  summary: string;
  steps: string[];
  originalRequest: string;
  messageId?: string;
  createdAt: string;
}

export interface TeamsGatewayMessage extends AgentChatMessage {
  id: string;
  createdAt: string;
  toolActivity?: AgentChatToolActivity[];
}

export interface TeamsGatewayThread {
  id: string;
  agentId: string;
  chatId: string;
  conversationKind?: "direct" | "group_chat" | "channel";
  conversationName?: string;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
  rootMessageId?: string;
  members?: TeamsGatewayGroupMember[];
  tenantId?: string;
  participantId: string;
  participantEmail: string;
  participantName: string;
  messages: TeamsGatewayMessage[];
  cursorAt: string;
  cursorMessageId?: string;
  pendingPlan?: TeamsGatewayPlan;
  pendingApprovalIds?: string[];
  pendingApprovalMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsGatewayAgentMetrics {
  agentId: string;
  presence: TeamsGatewayPresenceStatus;
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

export interface TeamsGatewayContact {
  id: string;
  agentId: string;
  tenantId?: string;
  userId: string;
  email: string;
  chatId: string;
  firstInboundAt: string;
  lastInboundAt: string;
}

export type TeamsGatewaySubscriptionKind = "chat_messages" | "channel_messages" | "team_channels";

/** Durable mapping between a watched Teams source and its Microsoft Graph subscription. */
export interface TeamsGatewaySubscription {
  sourceKey: string;
  subscriptionId: string;
  agentId: string;
  kind: TeamsGatewaySubscriptionKind;
  resource: string;
  clientState: string;
  expiresAt: string;
  updatedAt: string;
}

export interface ITeamsGatewayStore {
  setAgent(agent: TeamsGatewayAgent): Promise<void>;
  getAgent(id: string): Promise<TeamsGatewayAgent | undefined>;
  listAgents(): Promise<TeamsGatewayAgent[]>;
  deleteAgent(id: string): Promise<boolean>;
  setThread(thread: TeamsGatewayThread): Promise<void>;
  getThread(agentId: string, chatId: string): Promise<TeamsGatewayThread | undefined>;
  listThreads(agentId?: string, limit?: number): Promise<TeamsGatewayThread[]>;
  setContact(contact: TeamsGatewayContact): Promise<void>;
  getContact(agentId: string, email: string): Promise<TeamsGatewayContact | undefined>;
  listContacts(agentId: string): Promise<TeamsGatewayContact[]>;
  setGroup(group: TeamsGatewayGroup): Promise<void>;
  listGroups(agentId?: string): Promise<TeamsGatewayGroup[]>;
  deleteMissingGroups(agentId: string, retainedIds: string[]): Promise<void>;
  setSubscription(subscription: TeamsGatewaySubscription): Promise<void>;
  getSubscriptionById(subscriptionId: string): Promise<TeamsGatewaySubscription | undefined>;
  listSubscriptions(agentId?: string): Promise<TeamsGatewaySubscription[]>;
  deleteSubscription(sourceKey: string): Promise<void>;
}
