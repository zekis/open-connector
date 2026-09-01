import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { AgentCredentialService, AgentProvider } from "../agents/agent-credential-service.ts";
import type { ConnectionApprovalService } from "../approvals/connection-approval-service.ts";
import type { AgentChatExtension, AgentChatService, AgentChatToolActivity } from "../chat/agent-chat-service.ts";
import type { Logger } from "../logger.ts";
import type { ITeamsGatewayGraphClient, TeamsGatewayGraphContext } from "./teams-gateway-graph.ts";
import type {
  ITeamsGatewayStore,
  TeamsGatewayAgent,
  TeamsGatewayContact,
  TeamsGatewayMessage,
  TeamsGatewayPlan,
  TeamsGatewayThread,
  TeamsGatewayToolGrant,
} from "./teams-gateway-types.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import { microsoftTeamsProviderScopes } from "../../providers/microsoft_teams/scopes.ts";
import { approvalCode, evaluateTeamsOutboundRecipient, isTeamsRecipientAuthorized } from "./teams-gateway-policy.ts";

export interface TeamsGatewayServiceOptions {
  catalog: CatalogStore;
  connections: Pick<ConnectionService, "getConnectionSummaryById" | "listConnections">;
  agents: Pick<AgentCredentialService, "list">;
  agentChat: Pick<AgentChatService, "respondWithExtension" | "resumeWithExtension">;
  approvals: Pick<ConnectionApprovalService, "approve" | "deny" | "getActionApproval">;
  graph: ITeamsGatewayGraphClient;
  store: ITeamsGatewayStore;
  logger?: Logger;
  now?(): Date;
  timeZone?: string;
}

export interface TeamsGatewayPollResult {
  agents: number;
  chats: number;
  messages: number;
  errors: number;
}

interface PlanCapture {
  summary: string;
  steps: string[];
}

interface ApprovalCommand {
  decision: "approve" | "deny";
  ids: string[];
}

const teamsService = "microsoft_teams";
const sendChatActionId = "microsoft_teams.send_chat_message";
const requiredTeamsGatewayScopes = [
  microsoftTeamsProviderScopes.userReadBasicAll,
  microsoftTeamsProviderScopes.chatRead,
  microsoftTeamsProviderScopes.chatCreate,
  microsoftTeamsProviderScopes.chatMessageSend,
];
const maxThreadMessages = 40;
const maxConcurrentChats = 4;
const defaultPollIntervalMs = 30_000;

/** Owns Teams 1:1 account bindings, contact policy, durable conversations, and agent turns. */
export class TeamsGatewayService {
  private readonly options: TeamsGatewayServiceOptions;
  private readonly threadLocks = new Map<string, Promise<void>>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(options: TeamsGatewayServiceOptions) {
    this.options = options;
  }

  listAgents(): Promise<TeamsGatewayAgent[]> {
    return this.options.store.listAgents();
  }

  listThreads(agentId?: string): Promise<TeamsGatewayThread[]> {
    return this.options.store.listThreads(agentId, 100);
  }

  listContacts(agentId: string): Promise<TeamsGatewayContact[]> {
    return this.options.store.listContacts(agentId);
  }

  async ownsApproval(id: string): Promise<boolean> {
    return (await this.options.store.listThreads(undefined, 500)).some((thread) =>
      thread.pendingApprovalIds?.includes(id),
    );
  }

  async upsertAgent(id: string | undefined, input: unknown): Promise<TeamsGatewayAgent> {
    const value = requireRecord(input, "Teams gateway agent");
    const existing = id ? await this.options.store.getAgent(id) : undefined;
    if (id && !existing) throw new TeamsGatewayError("agent_not_found", `Teams gateway agent not found: ${id}.`, 404);
    const now = this.now().toISOString();
    const teamsConnectionId = requireText(value.teamsConnectionId, "teamsConnectionId", 300);
    if (existing && existing.teamsConnectionId !== teamsConnectionId) {
      throw new TeamsGatewayError(
        "teams_identity_immutable",
        "A Teams agent identity cannot be changed after its conversation state is created. Create a new agent instead.",
        409,
      );
    }
    const teamsConnection = await this.options.connections.getConnectionSummaryById(teamsConnectionId);
    if (!teamsConnection || teamsConnection.service !== teamsService) {
      throw new TeamsGatewayError(
        "invalid_teams_connection",
        "teamsConnectionId must identify a configured Microsoft Teams connection.",
      );
    }
    const grantedScopes = new Set(teamsConnection.profile.grantedScopes.map((scope) => scope.toLowerCase()));
    const missingScopes = requiredTeamsGatewayScopes.filter((scope) => !grantedScopes.has(scope.toLowerCase()));
    if (missingScopes.length > 0) {
      throw new TeamsGatewayError(
        "teams_scopes_missing",
        `Reconnect the Microsoft Teams account to grant the gateway scopes: ${missingScopes.join(", ")}.`,
      );
    }
    const agentProvider = readAgentProvider(value.agentProvider);
    const allowedDomains = readDomains(value.allowedDomains, "allowedDomains");
    const enabled = readBoolean(value.enabled, existing?.enabled ?? true);
    if (enabled && allowedDomains.length === 0) {
      throw new TeamsGatewayError(
        "domain_policy_required",
        "At least one internal domain is required before a Teams gateway agent can be enabled.",
      );
    }
    if (enabled && !(await this.options.agents.list()).some((connection) => connection.provider === agentProvider)) {
      throw new TeamsGatewayError(
        "agent_connection_not_found",
        `Connect ${agentProvider === "openai_codex" ? "a ChatGPT" : "a Claude"} subscription before enabling this Teams agent.`,
      );
    }
    if (
      (await this.options.store.listAgents()).some(
        (agent) => agent.id !== existing?.id && agent.teamsConnectionId === teamsConnectionId,
      )
    ) {
      throw new TeamsGatewayError(
        "teams_connection_in_use",
        "That Microsoft Teams account is already assigned to another gateway agent.",
        409,
      );
    }
    const connections = await this.options.connections.listConnections();
    const toolGrants = this.readToolGrants(value, connections);
    const agent: TeamsGatewayAgent = {
      id: existing?.id ?? crypto.randomUUID(),
      name: requireText(value.name, "name", 100),
      enabled,
      teamsConnectionId,
      agentProvider,
      instructions: readOptionalText(value.instructions, "instructions", 10_000),
      allowedDomains,
      allowedExternalUsers: readEmails(value.allowedExternalUsers, "allowedExternalUsers"),
      proactiveDmUsers: readEmails(value.proactiveDmUsers, "proactiveDmUsers"),
      confirmBeforeTools: readBoolean(value.confirmBeforeTools, existing?.confirmBeforeTools ?? true),
      threadWindowHours: readInteger(value.threadWindowHours, "threadWindowHours", 1, 168, 12),
      toolGrants,
      watchStartedAt: existing?.watchStartedAt ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.options.store.setAgent(agent);
    return agent;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const threads = await this.options.store.listThreads(id, 500);
    const approvalIds = uniqueStrings(threads.flatMap((thread) => thread.pendingApprovalIds ?? []));
    for (const approvalId of approvalIds) {
      const approval = await this.options.approvals.getActionApproval(approvalId);
      if (approval?.status === "pending") await this.options.approvals.deny(approvalId);
    }
    return this.options.store.deleteAgent(id);
  }

  start(intervalMs: number = defaultPollIntervalMs): void {
    if (this.pollTimer) return;
    void this.pollNow().catch((error) => this.logError(error, "initial Teams gateway poll failed"));
    this.pollTimer = setInterval(
      () => {
        void this.pollNow().catch((error) => this.logError(error, "Teams gateway poll failed"));
      },
      Math.max(10_000, intervalMs),
    );
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async pollNow(): Promise<TeamsGatewayPollResult> {
    if (this.polling) return { agents: 0, chats: 0, messages: 0, errors: 0 };
    this.polling = true;
    const result: TeamsGatewayPollResult = { agents: 0, chats: 0, messages: 0, errors: 0 };
    try {
      const agents = (await this.options.store.listAgents()).filter((agent) => agent.enabled);
      result.agents = agents.length;
      for (const agent of agents) {
        try {
          const agentResult = await this.pollAgent(agent);
          result.chats += agentResult.chats;
          result.messages += agentResult.messages;
          result.errors += agentResult.errors;
        } catch (error) {
          result.errors += 1;
          this.logError(error, "Teams gateway agent poll failed", { agentId: agent.id });
        }
      }
      return result;
    } finally {
      this.polling = false;
    }
  }

  async sendProactiveMessage(
    agentId: string,
    recipientEmail: string,
    text: string,
  ): Promise<{ chatId: string; messageId?: string }> {
    const agent = await this.requiredAgent(agentId);
    const email = normalizeEmail(recipientEmail, "recipientEmail");
    const message = requireText(text, "text", 20_000);
    const contact = await this.options.store.getContact(agent.id, email);
    const decision = evaluateTeamsOutboundRecipient(agent, email, Boolean(contact));
    if (!decision.allowed) {
      const explanation =
        decision.reason === "external_not_authorized"
          ? `${email} is outside this agent's authorized domains and external-user list.`
          : `${email} has not messaged this agent and is not on its proactive-DM whitelist.`;
      throw new TeamsGatewayError("dm_not_allowed", explanation, 403);
    }
    const graphContext = await this.options.graph.context(agent.teamsConnectionId);
    const chat = await this.options.graph.createOneOnOneChat(graphContext, email);
    const sent = await this.options.graph.sendMessage(graphContext, chat.id, message);
    return { chatId: chat.id, messageId: sent.id };
  }

  private async pollAgent(
    agent: TeamsGatewayAgent,
  ): Promise<Pick<TeamsGatewayPollResult, "chats" | "messages" | "errors">> {
    const result = { chats: 0, messages: 0, errors: 0 };
    const graphContext = await this.options.graph.context(agent.teamsConnectionId);
    await this.resumeResolvedApprovals(agent, graphContext);
    const chats = (await this.options.graph.listChats(graphContext)).filter((chat) => chat.chatType === "oneOnOne");
    result.chats = chats.length;
    await runWithConcurrency(chats, maxConcurrentChats, async (chat) => {
      try {
        let participant = chat.members.find((member) => member.userId !== graphContext.selfId);
        if (!participant) return;
        if (!participant.email)
          participant = { ...participant, ...(await this.options.graph.resolveUser(graphContext, participant.userId)) };
        if (!participant.email) return;
        const existing = await this.options.store.getThread(agent.id, chat.id);
        const floor = existing?.cursorAt ?? agent.watchStartedAt;
        if (chat.lastMessageAt && Date.parse(chat.lastMessageAt) < Date.parse(floor)) return;
        const messages = await this.options.graph.listMessages(graphContext, chat.id, floor);
        for (const message of messages) {
          if (message.senderId === graphContext.selfId) {
            await this.advanceCursor(agent, chat.id, participant, message.createdAt, message.id);
            continue;
          }
          const key = threadId(agent.id, chat.id);
          await this.withThreadLock(key, async () => {
            const handled = await this.handleInboundMessage(agent, graphContext, chat.id, participant!, message);
            if (handled) result.messages += 1;
          });
        }
      } catch (error) {
        result.errors += 1;
        this.logError(error, "Teams gateway chat poll failed", { agentId: agent.id, chatId: chat.id });
      }
    });
    return result;
  }

  private async handleInboundMessage(
    agent: TeamsGatewayAgent,
    graphContext: TeamsGatewayGraphContext,
    chatId: string,
    participant: { userId: string; tenantId?: string; email?: string; displayName: string },
    message: { id: string; createdAt: string; senderId?: string; senderName: string; text: string },
  ): Promise<boolean> {
    const email = participant.email!;
    let thread = await this.options.store.getThread(agent.id, chatId);
    thread = this.freshThread(agent, chatId, participant, thread);
    if (thread.messages.some((item) => item.id === message.id)) {
      return false;
    }
    thread.cursorAt = message.createdAt;
    thread.cursorMessageId = message.id;
    thread.updatedAt = this.now().toISOString();
    if (!isTeamsRecipientAuthorized(agent, email)) {
      await this.options.store.setThread(thread);
      this.options.logger?.warn(
        { agentId: agent.id, chatId, participantEmail: email },
        "Teams gateway blocked an unauthorized external sender",
      );
      return false;
    }
    await this.recordContact(agent, thread, participant, message.createdAt);
    thread.messages = appendMessage(thread.messages, {
      id: message.id,
      role: "user",
      content: message.text,
      createdAt: message.createdAt,
    });
    await this.options.store.setThread(thread);

    if (thread.pendingApprovalIds?.length) {
      await this.handleApprovalReply(agent, graphContext, thread, message.text);
      return true;
    }
    if (thread.pendingPlan) {
      const decision = planReply(message.text);
      if (decision === "cancel") {
        thread.pendingPlan = undefined;
        await this.reply(graphContext, thread, "No problem — I’ve cancelled that plan.");
        return true;
      }
      if (decision === "proceed") {
        thread.pendingPlan = undefined;
        await this.runAgentTurn(agent, graphContext, thread, false);
        return true;
      }
      const revisedRequest = `${thread.pendingPlan.originalRequest}\n\nCorrection from the user: ${message.text}`;
      thread.pendingPlan = undefined;
      thread.messages = appendMessage(thread.messages, {
        id: crypto.randomUUID(),
        role: "user",
        content: revisedRequest,
        createdAt: this.now().toISOString(),
      });
      await this.runAgentTurn(agent, graphContext, thread, agent.confirmBeforeTools);
      return true;
    }
    await this.runAgentTurn(agent, graphContext, thread, agent.confirmBeforeTools);
    return true;
  }

  private async runAgentTurn(
    agent: TeamsGatewayAgent,
    graphContext: TeamsGatewayGraphContext,
    thread: TeamsGatewayThread,
    requirePlan: boolean,
  ): Promise<void> {
    let proposedPlan: PlanCapture | undefined;
    const extension = this.createExtension(agent, graphContext, requirePlan, (plan) => {
      proposedPlan = plan;
    });
    const response = await this.options.agentChat.respondWithExtension(
      {
        messages: thread.messages.map(({ role, content }) => ({ role, content })),
        voiceMode: false,
        timeZone: this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        agentProvider: agent.agentProvider,
      },
      extension,
    );
    if (proposedPlan || (requirePlan && response.toolActivity.some(isPlanRequiredActivity))) {
      const plan: TeamsGatewayPlan = {
        summary: proposedPlan?.summary ?? thread.messages.at(-1)?.content ?? "Complete the requested work",
        steps: proposedPlan?.steps.length
          ? proposedPlan.steps
          : ["Use the enabled provider connections to complete the request."],
        originalRequest: thread.messages.filter((item) => item.role === "user").at(-1)?.content ?? "",
        createdAt: this.now().toISOString(),
      };
      thread.pendingPlan = plan;
      await this.reply(graphContext, thread, formatPlan(plan));
      return;
    }
    await this.applyAgentResponse(graphContext, thread, response);
  }

  private createExtension(
    agent: TeamsGatewayAgent,
    graphContext: TeamsGatewayGraphContext,
    requirePlan: boolean,
    capturePlan: (plan: PlanCapture) => void,
  ): AgentChatExtension {
    return {
      systemPrompt: createTeamsSystemPrompt(agent, requirePlan),
      context: { channel: "Microsoft Teams 1:1 DM", agentName: agent.name },
      connectorGrants: agent.toolGrants.map((grant) => ({
        connectionId: grant.connectionId,
        actionIds: new Set(grant.actionIds),
      })),
      connectorApprovalPolicy: "enforce",
      includeFlowTools: false,
      tools: [
        ...(requirePlan
          ? [
              {
                name: "propose_teams_plan",
                description:
                  "Propose a concise plan before using any connected provider. The host pauses until the person confirms it.",
                inputSchema: {
                  type: "object",
                  properties: {
                    summary: { type: "string" },
                    steps: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
                  },
                  required: ["summary", "steps"],
                  additionalProperties: false,
                },
              },
            ]
          : []),
        {
          name: "send_teams_dm",
          description:
            "Send a proactive Teams DM as this agent. The host enforces domain authorization and prior-contact/whitelist policy.",
          inputSchema: {
            type: "object",
            properties: { recipientEmail: { type: "string" }, text: { type: "string" } },
            required: ["recipientEmail", "text"],
            additionalProperties: false,
          },
        },
      ],
      beforeConnectorAction: async (actionId, connectionId, input) =>
        requirePlan ? planRequiredActivity(actionId, connectionId, input) : undefined,
      runTool: async (toolName, input) => {
        if (toolName === "propose_teams_plan" && requirePlan) {
          const plan = {
            summary: requireText(input.summary, "summary", 1_000),
            steps: readTextArray(input.steps, "steps", 1, 8, 500),
          };
          capturePlan(plan);
          return completedGatewayActivity(toolName, "Propose a plan", input, { plan });
        }
        if (toolName === "send_teams_dm") {
          if (requirePlan) return planRequiredActivity(toolName, undefined, input);
          try {
            const output = await this.sendProactiveMessage(
              agent.id,
              requireText(input.recipientEmail, "recipientEmail", 320),
              requireText(input.text, "text", 20_000),
            );
            return completedGatewayActivity(toolName, "Send Teams DM", input, output);
          } catch (error) {
            return failedGatewayActivity(toolName, "Send Teams DM", input, error);
          }
        }
        return undefined;
      },
    };
  }

  private async handleApprovalReply(
    agent: TeamsGatewayAgent,
    graphContext: TeamsGatewayGraphContext,
    thread: TeamsGatewayThread,
    text: string,
  ): Promise<void> {
    const ids = thread.pendingApprovalIds ?? [];
    const command = parseApprovalCommand(text, ids);
    if (!command) {
      await this.reply(graphContext, thread, approvalInstructions(ids));
      return;
    }
    for (const id of command.ids) {
      if (command.decision === "approve") await this.options.approvals.approve(id);
      else await this.options.approvals.deny(id);
    }
    const remaining = (await Promise.all(ids.map((id) => this.options.approvals.getActionApproval(id)))).flatMap(
      (approval) => (approval?.status === "pending" ? [approval.id] : []),
    );
    if (remaining.length > 0) {
      thread.pendingApprovalIds = remaining;
      await this.reply(graphContext, thread, approvalInstructions(remaining));
      return;
    }
    const response = await this.options.agentChat.resumeWithExtension(
      ids[0]!,
      this.createExtension(agent, graphContext, false, () => {}),
    );
    await this.applyAgentResponse(graphContext, thread, response);
  }

  private async resumeResolvedApprovals(
    agent: TeamsGatewayAgent,
    graphContext: TeamsGatewayGraphContext,
  ): Promise<void> {
    const threads = (await this.options.store.listThreads(agent.id, 100)).filter(
      (thread) => thread.pendingApprovalIds?.length,
    );
    for (const thread of threads) {
      const approvals = await Promise.all(
        thread.pendingApprovalIds!.map((id) => this.options.approvals.getActionApproval(id)),
      );
      if (approvals.some((approval) => !approval)) {
        thread.pendingApprovalIds = undefined;
        thread.pendingApprovalMessageId = undefined;
        await this.reply(
          graphContext,
          thread,
          "The pending approval is no longer available. Please ask me to try again.",
        );
        continue;
      }
      if (approvals.some((approval) => approval?.status === "pending")) continue;
      try {
        const response = await this.options.agentChat.resumeWithExtension(
          thread.pendingApprovalIds![0]!,
          this.createExtension(agent, graphContext, false, () => {}),
        );
        await this.applyAgentResponse(graphContext, thread, response);
      } catch (error) {
        this.logError(error, "Teams gateway approval resume failed", { agentId: agent.id, threadId: thread.id });
      }
    }
  }

  private async applyAgentResponse(
    graphContext: TeamsGatewayGraphContext,
    thread: TeamsGatewayThread,
    response: Awaited<ReturnType<AgentChatService["respondWithExtension"]>>,
  ): Promise<void> {
    thread.messages = appendMessage(thread.messages, {
      ...response.message,
      toolActivity: response.toolActivity,
    });
    thread.pendingApprovalIds =
      response.status === "waiting_for_approval"
        ? (response.approvalIds ?? (response.approvalId ? [response.approvalId] : []))
        : undefined;
    thread.updatedAt = this.now().toISOString();
    await this.options.store.setThread(thread);
    const approvalSuffix = thread.pendingApprovalIds?.length
      ? `\n\n${await this.describeApprovals(thread.pendingApprovalIds)}`
      : "";
    const sent = await this.options.graph.sendMessage(
      graphContext,
      thread.chatId,
      `${response.message.content}${approvalSuffix}`.trim(),
    );
    thread.pendingApprovalMessageId = thread.pendingApprovalIds?.length ? sent.id : undefined;
    await this.options.store.setThread(thread);
  }

  private async describeApprovals(ids: string[]): Promise<string> {
    const lines = await Promise.all(
      ids.map(async (id) => {
        const approval = await this.options.approvals.getActionApproval(id);
        return `- ${approvalCode(id)}: ${approval?.actionId ?? "connector action"}`;
      }),
    );
    return `Approval required:\n${lines.join("\n")}\nReply “approve CODE” or “reject CODE”. Use “approve all” or “reject all” for the full batch.`;
  }

  private async reply(graphContext: TeamsGatewayGraphContext, thread: TeamsGatewayThread, text: string): Promise<void> {
    const sent = await this.options.graph.sendMessage(graphContext, thread.chatId, text);
    thread.messages = appendMessage(thread.messages, {
      id: sent.id ?? crypto.randomUUID(),
      role: "assistant",
      content: text,
      createdAt: this.now().toISOString(),
    });
    thread.updatedAt = this.now().toISOString();
    await this.options.store.setThread(thread);
  }

  private freshThread(
    agent: TeamsGatewayAgent,
    chatId: string,
    participant: { userId: string; tenantId?: string; email?: string; displayName: string },
    existing?: TeamsGatewayThread,
  ): TeamsGatewayThread {
    const now = this.now();
    const expired =
      existing && now.getTime() - Date.parse(existing.updatedAt) > agent.threadWindowHours * 60 * 60 * 1_000;
    if (existing && !expired) {
      return {
        ...existing,
        participantId: participant.userId,
        participantEmail: participant.email!,
        participantName: participant.displayName,
        tenantId: participant.tenantId,
      };
    }
    const timestamp = now.toISOString();
    return {
      id: threadId(agent.id, chatId),
      agentId: agent.id,
      chatId,
      tenantId: participant.tenantId,
      participantId: participant.userId,
      participantEmail: participant.email!,
      participantName: participant.displayName,
      messages: [],
      cursorAt: existing?.cursorAt ?? agent.watchStartedAt,
      cursorMessageId: existing?.cursorMessageId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private async advanceCursor(
    agent: TeamsGatewayAgent,
    chatId: string,
    participant: { userId: string; tenantId?: string; email?: string; displayName: string },
    cursorAt: string,
    cursorMessageId: string,
  ): Promise<void> {
    const thread = this.freshThread(agent, chatId, participant, await this.options.store.getThread(agent.id, chatId));
    thread.cursorAt = cursorAt;
    thread.cursorMessageId = cursorMessageId;
    thread.updatedAt = this.now().toISOString();
    await this.options.store.setThread(thread);
  }

  private async recordContact(
    agent: TeamsGatewayAgent,
    thread: TeamsGatewayThread,
    participant: { userId: string; tenantId?: string; email?: string },
    inboundAt: string,
  ): Promise<void> {
    const previous = await this.options.store.getContact(agent.id, participant.email!);
    await this.options.store.setContact({
      id: contactId(agent.id, participant.email!),
      agentId: agent.id,
      tenantId: participant.tenantId,
      userId: participant.userId,
      email: participant.email!,
      chatId: thread.chatId,
      firstInboundAt: previous?.firstInboundAt ?? inboundAt,
      lastInboundAt: inboundAt,
    });
  }

  private async requiredAgent(id: string): Promise<TeamsGatewayAgent> {
    const agent = await this.options.store.getAgent(id);
    if (!agent) throw new TeamsGatewayError("agent_not_found", `Teams gateway agent not found: ${id}.`, 404);
    if (!agent.enabled) throw new TeamsGatewayError("agent_disabled", `Teams gateway agent is disabled: ${id}.`, 409);
    return agent;
  }

  private readToolGrants(value: Record<string, unknown>, connections: ConnectionSummary[]): TeamsGatewayToolGrant[] {
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const rawGrants = Array.isArray(value.toolGrants) ? value.toolGrants : [];
    const seen = new Set<string>();
    return rawGrants.map((raw, index) => {
      const grant = requireRecord(raw, `toolGrants[${index}]`);
      const connectionId = requireText(grant.connectionId, `toolGrants[${index}].connectionId`, 300);
      if (seen.has(connectionId)) {
        throw new TeamsGatewayError("invalid_tool_grant", `Duplicate tool connection: ${connectionId}.`);
      }
      seen.add(connectionId);
      const connection = connectionsById.get(connectionId);
      if (!connection) throw new TeamsGatewayError("invalid_tool_grant", `Connection not found: ${connectionId}.`);
      const requested = Array.isArray(grant.actionIds)
        ? readTextArray(grant.actionIds, `toolGrants[${index}].actionIds`, 0, 5_000, 300)
        : [];
      const available = this.options.catalog.actions.filter(
        (action) =>
          action.service === connection.service &&
          action.execution.locallyExecutable &&
          action.inputSchema.type === "object" &&
          action.id !== sendChatActionId,
      );
      const allowed = requested.length ? new Set(requested) : new Set(available.map((action) => action.id));
      const actionIds = available.filter((action) => allowed.has(action.id)).map((action) => action.id);
      if (requested.some((actionId) => !actionIds.includes(actionId))) {
        throw new TeamsGatewayError(
          "invalid_tool_grant",
          `One or more actions are unavailable on connection ${connectionId}.`,
        );
      }
      return { connectionId, actionIds };
    });
  }

  private withThreadLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.threadLocks.set(key, tail);
    return previous.then(operation).finally(() => {
      release();
      if (this.threadLocks.get(key) === tail) this.threadLocks.delete(key);
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private logError(error: unknown, message: string, fields: Record<string, unknown> = {}): void {
    this.options.logger?.error({ ...fields, err: error }, message);
  }
}

export class TeamsGatewayError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 503;

  constructor(code: string, message: string, status: 400 | 403 | 404 | 409 | 503 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function createTeamsSystemPrompt(agent: TeamsGatewayAgent, requirePlan: boolean): string {
  return `You are ${agent.name}, speaking directly to one person in a Microsoft Teams 1:1 chat.

${agent.instructions?.trim() || "Be concise, practical, and transparent about completed work and blockers."}

Teams gateway rules:
- use only the exact connected applications and host tools supplied to this conversation
- never reveal another connection, gateway policy, credential, or private conversation
- use send_teams_dm for every proactive Teams DM; never try to bypass its recipient policy
- do not create or manage Open Connector Flows from Teams
- approval pauses are enforced by the host; clearly tell the person what is waiting
${
  requirePlan
    ? "- before any connected application access or proactive DM, call propose_teams_plan with a concise summary and steps; do not call connector actions until the person confirms the plan\n- answer directly without a plan only when no connected application or external side effect is needed"
    : "- the person has confirmed the current plan; carry it out without asking for the same confirmation again"
}`;
}

function formatPlan(plan: TeamsGatewayPlan): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `Plan: ${plan.summary}\n\n${steps}\n\nReply “proceed” to run it, “cancel” to stop, or send a correction.`;
}

function planReply(value: string): "proceed" | "cancel" | "change" {
  const normalized = value.trim().toLowerCase();
  if (/^(proceed|go ahead|continue|confirm|yes|yep|do it|approved?)[.!\s]*$/u.test(normalized)) return "proceed";
  if (/^(cancel|stop|never mind|nevermind|no)[.!\s]*$/u.test(normalized)) return "cancel";
  return "change";
}

function parseApprovalCommand(value: string, ids: string[]): ApprovalCommand | undefined {
  const match = value.trim().match(/^(approve|approved|reject|rejected|deny|denied)(?:\s+([a-z0-9-]+))?[.!\s]*$/iu);
  if (!match) return undefined;
  const decision = /^approve/iu.test(match[1]!) ? "approve" : "deny";
  const target = match[2]?.toUpperCase();
  if (target === "ALL") return { decision, ids };
  if (!target) return ids.length === 1 ? { decision, ids } : undefined;
  const matches = ids.filter((id) => approvalCode(id) === target);
  return matches.length === 1 ? { decision, ids: matches } : undefined;
}

function approvalInstructions(ids: string[]): string {
  if (ids.length === 1) {
    return `I’m waiting for approval ${approvalCode(ids[0]!)}. Reply “approve” or “reject”.`;
  }
  return `I’m waiting for ${ids.length} approvals. Reply with “approve CODE”, “reject CODE”, “approve all”, or “reject all”.`;
}

function planRequiredActivity(
  actionId: string,
  connectionId: string | undefined,
  input: Record<string, unknown>,
): AgentChatToolActivity {
  return {
    id: crypto.randomUUID(),
    type: "action",
    label: actionId,
    ok: false,
    actionId,
    connectionId,
    input,
    output: {
      error: {
        code: "teams_plan_confirmation_required",
        message: "Propose the Teams plan and wait for the person to confirm it before using tools.",
      },
    },
  };
}

function isPlanRequiredActivity(activity: AgentChatToolActivity): boolean {
  return (
    optionalString(optionalRecord(optionalRecord(activity.output)?.error)?.code) === "teams_plan_confirmation_required"
  );
}

function completedGatewayActivity(
  actionId: string,
  label: string,
  input: Record<string, unknown>,
  output: unknown,
): AgentChatToolActivity {
  return { id: crypto.randomUUID(), type: "action", label, ok: true, actionId, input, output };
}

function failedGatewayActivity(
  actionId: string,
  label: string,
  input: Record<string, unknown>,
  error: unknown,
): AgentChatToolActivity {
  return {
    id: crypto.randomUUID(),
    type: "action",
    label,
    ok: false,
    actionId,
    input,
    output: {
      error: {
        code: error instanceof TeamsGatewayError ? error.code : "teams_gateway_error",
        message: error instanceof Error ? error.message : "Teams gateway action failed.",
      },
    },
  };
}

function appendMessage(messages: TeamsGatewayMessage[], message: TeamsGatewayMessage): TeamsGatewayMessage[] {
  return [...messages, message].slice(-maxThreadMessages);
}

function threadId(agentId: string, chatId: string): string {
  return `${agentId}:${chatId}`;
}

function contactId(agentId: string, email: string): string {
  return `${agentId}:${email.toLowerCase()}`;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TeamsGatewayError("invalid_input", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TeamsGatewayError("invalid_input", `${field} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new TeamsGatewayError("invalid_input", `${field} must be at most ${maximum} characters.`);
  }
  return normalized;
}

function readOptionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value == null || value === "") return undefined;
  return requireText(value, field, maximum);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, field: string, minimum: number, maximum: number, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TeamsGatewayError("invalid_input", `${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function readAgentProvider(value: unknown): AgentProvider {
  if (value === "claude_code" || value === "openai_codex") return value;
  throw new TeamsGatewayError("invalid_input", "agentProvider must be claude_code or openai_codex.");
}

function readTextArray(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  maximumCharacters: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TeamsGatewayError("invalid_input", `${field} must contain ${minimum} to ${maximum} entries.`);
  }
  return value.map((item, index) => requireText(item, `${field}[${index}]`, maximumCharacters));
}

function readDomains(value: unknown, field: string): string[] {
  return uniqueStrings(
    readTextArray(value ?? [], field, 0, 100, 253).map((item) => item.replace(/^@/u, "").toLowerCase()),
  );
}

function readEmails(value: unknown, field: string): string[] {
  return uniqueStrings(readTextArray(value ?? [], field, 0, 500, 320).map((item) => normalizeEmail(item, field)));
}

function normalizeEmail(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new TeamsGatewayError("invalid_input", `${field} contains an invalid email address.`);
  }
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function runWithConcurrency<T>(
  values: readonly T[],
  maximum: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const value = values[nextIndex++];
      if (value !== undefined) await operation(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(maximum, values.length) }, worker));
}
