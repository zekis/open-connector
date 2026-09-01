import type { AgentProvider } from "../agents/agent-credential-service.ts";
import type { AgentChatMessage, AgentChatToolActivity } from "../chat/agent-chat-types.ts";

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
  watchStartedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsGatewayPlan {
  summary: string;
  steps: string[];
  originalRequest: string;
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
}
