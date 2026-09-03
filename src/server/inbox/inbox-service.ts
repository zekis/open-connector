import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { IActionRunner } from "../actions/action-runner.ts";
import type { TeamsGatewayService } from "../teams-gateway/teams-gateway-service.ts";
import type {
  TeamsGatewayAgent,
  TeamsGatewayMessage,
  TeamsGatewayThread,
} from "../teams-gateway/teams-gateway-types.ts";
import type {
  InboxAttachment,
  InboxConversation,
  InboxConversationSummary,
  InboxMessage,
  InboxPage,
  InboxParticipant,
  InboxReplyAttachment,
  InboxSource,
} from "./inbox-types.ts";

import { Buffer } from "node:buffer";
import { optionalRecord, optionalString, requiredRecord } from "../../core/cast.ts";

export interface InboxServiceOptions {
  connections: Pick<ConnectionService, "listConnections">;
  actions: IActionRunner;
  teamsGateway: Pick<TeamsGatewayService, "listAgents" | "listThreads" | "sendOperatorReply">;
  getPolicySnapshot(): Promise<ActionPolicySnapshot>;
}

interface OutlookConversationReference {
  provider: "outlook";
  connectionId: string;
  conversationId: string;
  messageId: string;
}

interface TeamsConversationReference {
  provider: "microsoft_teams";
  threadId: string;
}

type InboxConversationReference = OutlookConversationReference | TeamsConversationReference;

interface OutlookMessageAddress {
  name: string;
  address?: string;
}

interface OutlookMessageRecord {
  id: string;
  conversationId: string;
  subject: string;
  preview: string;
  body: string;
  from: OutlookMessageAddress;
  recipients: OutlookMessageAddress[];
  createdAt: string;
  isRead: boolean;
  hasAttachments: boolean;
}

const maxInboxReplyCharacters = 20_000;
const maxInboxAttachments = 10;

/** Combines durable Teams gateway threads and live Outlook mail into one operator inbox. */
export class InboxService {
  private readonly options: InboxServiceOptions;

  constructor(options: InboxServiceOptions) {
    this.options = options;
  }

  async list(input: { query?: string; sourceId?: string } = {}): Promise<InboxPage> {
    const [connections, agents, threads] = await Promise.all([
      this.options.connections.listConnections(),
      this.options.teamsGateway.listAgents(),
      this.options.teamsGateway.listThreads(),
    ]);
    const outlookConnections = connections.filter(
      (connection) => connection.service === "outlook" && connection.configured,
    );
    const sources = this.sources(agents, connections);
    const sourceFilter = input.sourceId?.trim();
    const errors: InboxPage["errors"] = [];
    const conversations: InboxConversationSummary[] = threads
      .filter((thread) => !sourceFilter || teamsSourceId(thread.agentId) === sourceFilter)
      .map((thread) => this.teamsSummary(thread, agents));

    await Promise.all(
      outlookConnections
        .filter((connection) => !sourceFilter || outlookSourceId(connection.id) === sourceFilter)
        .map(async (connection) => {
          try {
            conversations.push(...(await this.listOutlookConversations(connection)));
          } catch (error) {
            errors.push({ sourceId: outlookSourceId(connection.id), message: errorMessage(error) });
          }
        }),
    );

    const query = input.query?.trim().toLowerCase();
    const filtered = query
      ? conversations.filter((conversation) =>
          [
            conversation.title,
            conversation.preview,
            conversation.contextLabel,
            ...conversation.participants.flatMap((item) => [item.name, item.email]),
          ]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(query)),
        )
      : conversations;
    filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { sources, conversations: filtered.slice(0, 100), errors };
  }

  async get(conversationId: string): Promise<InboxConversation> {
    const reference = decodeReference(conversationId);
    if (reference.provider === "microsoft_teams") {
      const [agents, threads] = await Promise.all([
        this.options.teamsGateway.listAgents(),
        this.options.teamsGateway.listThreads(),
      ]);
      const thread = threads.find((item) => item.id === reference.threadId);
      if (!thread) throw new InboxError("conversation_not_found", "Teams conversation not found.", 404);
      return this.teamsConversation(thread, agents);
    }
    const connection = await this.requireOutlookConnection(reference.connectionId);
    return this.getOutlookConversation(reference, connection);
  }

  async reply(conversationId: string, input: unknown): Promise<InboxConversation> {
    const value = requiredRecord(input, "inbox reply", invalidInput);
    const text = readReplyText(value.text);
    const attachments = readReplyAttachments(value.attachments);
    if (!text && attachments.length === 0) throw invalidInput("A reply or attachment is required.");
    const reference = decodeReference(conversationId);
    if (reference.provider === "microsoft_teams") {
      await this.options.teamsGateway.sendOperatorReply(reference.threadId, text, attachments);
      return this.get(conversationId);
    }

    await this.requireOutlookConnection(reference.connectionId);
    if (attachments.length === 0) {
      await this.runOutlookAction(reference.connectionId, "outlook.reply_email", {
        messageId: reference.messageId,
        comment: text,
      });
    } else {
      const draft = asRecord(
        await this.runOutlookAction(reference.connectionId, "outlook.create_reply_draft", {
          messageId: reference.messageId,
          comment: text || undefined,
        }),
      );
      const draftId = optionalString(draft.id);
      if (!draftId) throw new InboxError("provider_error", "Outlook did not return a reply draft ID.", 503);
      for (const attachment of attachments) {
        await this.runOutlookAction(reference.connectionId, "outlook.add_attachment", {
          messageId: draftId,
          file: { fileId: attachment.fileId, name: attachment.name },
        });
      }
      await this.runOutlookAction(reference.connectionId, "outlook.send_draft", { messageId: draftId });
    }
    return this.get(conversationId);
  }

  async markRead(conversationId: string): Promise<{ success: true }> {
    const reference = decodeReference(conversationId);
    if (reference.provider === "outlook") {
      await this.requireOutlookConnection(reference.connectionId);
      await this.runOutlookAction(reference.connectionId, "outlook.set_message_read", {
        messageId: reference.messageId,
        isRead: true,
      });
    }
    return { success: true };
  }

  async downloadOutlookAttachment(referenceToken: string): Promise<string> {
    const reference = decodeAttachmentReference(referenceToken);
    await this.requireOutlookConnection(reference.connectionId);
    const output = asRecord(
      await this.runOutlookAction(reference.connectionId, "outlook.download_attachment", {
        messageId: reference.messageId,
        attachmentId: reference.attachmentId,
      }),
    );
    const file = optionalRecord(output.file);
    const downloadUrl = optionalString(file?.downloadUrl);
    if (!downloadUrl) throw new InboxError("attachment_unavailable", "Outlook attachment is unavailable.", 404);
    return downloadUrl;
  }

  private sources(agents: TeamsGatewayAgent[], connections: ConnectionSummary[]): InboxSource[] {
    const outlookConnections = connections.filter(
      (connection) => connection.service === "outlook" && connection.configured,
    );
    return [
      ...agents.map((agent) => ({
        id: teamsSourceId(agent.id),
        provider: "microsoft_teams" as const,
        displayName: agent.name,
        accountLabel:
          connections.find((connection) => connection.id === agent.teamsConnectionId)?.profile.displayName ??
          agent.name,
        connectionId: agent.teamsConnectionId,
        enabled: agent.enabled,
      })),
      ...outlookConnections.map((connection) => ({
        id: outlookSourceId(connection.id),
        provider: "outlook" as const,
        displayName: connection.connectionName === "default" ? "Outlook" : `Outlook · ${connection.connectionName}`,
        accountLabel: connection.profile.displayName,
        connectionId: connection.id,
        enabled: true,
      })),
    ];
  }

  private teamsSummary(thread: TeamsGatewayThread, agents: TeamsGatewayAgent[]): InboxConversationSummary {
    const last = thread.messages.at(-1);
    const title = thread.conversationName ?? thread.participantName ?? thread.participantEmail;
    return {
      id: encodeReference({ provider: "microsoft_teams", threadId: thread.id }),
      sourceId: teamsSourceId(thread.agentId),
      provider: "microsoft_teams",
      title,
      preview: last?.content ?? "",
      participants: teamsParticipants(thread),
      updatedAt: thread.updatedAt,
      unread: false,
      status: thread.pendingPlan || thread.pendingApprovalIds?.length ? "waiting" : "open",
      messageCount: thread.messages.length,
      contextLabel: teamsContextLabel(thread, agents),
    };
  }

  private teamsConversation(thread: TeamsGatewayThread, agents: TeamsGatewayAgent[]): InboxConversation {
    return {
      ...this.teamsSummary(thread, agents),
      messages: thread.messages.map((message) => mapTeamsMessage(message, thread, agents)),
    };
  }

  private async listOutlookConversations(connection: ConnectionSummary): Promise<InboxConversationSummary[]> {
    const output = asRecord(
      await this.runOutlookAction(connection.id, "outlook.list_messages", {
        mailFolderId: "inbox",
        top: 50,
        orderby: "receivedDateTime desc",
        select: [
          "id",
          "conversationId",
          "subject",
          "bodyPreview",
          "receivedDateTime",
          "sentDateTime",
          "from",
          "toRecipients",
          "isRead",
          "hasAttachments",
        ],
      }),
    );
    const grouped = new Map<string, OutlookMessageRecord[]>();
    for (const raw of Array.isArray(output.messages) ? output.messages : []) {
      const message = parseOutlookMessage(raw);
      if (!message) continue;
      const messages = grouped.get(message.conversationId) ?? [];
      messages.push(message);
      grouped.set(message.conversationId, messages);
    }
    return [...grouped.values()].map((messages) => {
      messages.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const latest = messages[0];
      return {
        id: encodeReference({
          provider: "outlook",
          connectionId: connection.id,
          conversationId: latest.conversationId,
          messageId: latest.id,
        }),
        sourceId: outlookSourceId(connection.id),
        provider: "outlook",
        title: latest.subject || "No subject",
        preview: latest.preview,
        participants: [toParticipant(latest.from)],
        updatedAt: latest.createdAt,
        unread: messages.some((message) => !message.isRead),
        status: "open",
        messageCount: messages.length,
        contextLabel: connection.profile.displayName,
      };
    });
  }

  private async getOutlookConversation(
    reference: OutlookConversationReference,
    connection: ConnectionSummary,
  ): Promise<InboxConversation> {
    const output = asRecord(
      await this.runOutlookAction(connection.id, "outlook.list_messages", {
        top: 50,
        filter: `conversationId eq '${reference.conversationId.replaceAll("'", "''")}'`,
        bodyContentType: "text",
        select: [
          "id",
          "conversationId",
          "subject",
          "body",
          "bodyPreview",
          "receivedDateTime",
          "sentDateTime",
          "from",
          "toRecipients",
          "isRead",
          "hasAttachments",
        ],
      }),
    );
    const messages = (Array.isArray(output.messages) ? output.messages : [])
      .map(parseOutlookMessage)
      .filter((message): message is OutlookMessageRecord => Boolean(message));
    messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const mappedMessages = await Promise.all(
      messages.map(async (message) => this.mapOutlookMessage(message, connection)),
    );
    const latest = messages.at(-1);
    if (!latest) throw new InboxError("conversation_not_found", "Outlook conversation not found.", 404);
    const otherParticipants = uniqueParticipants(
      messages
        .flatMap((message) => [message.from, ...message.recipients])
        .filter((participant) => !isSelf(participant, connection)),
    );
    return {
      id: encodeReference({ ...reference, messageId: latest.id }),
      sourceId: outlookSourceId(connection.id),
      provider: "outlook",
      title: latest.subject || "No subject",
      preview: latest.preview,
      participants: otherParticipants.map(toParticipant),
      updatedAt: latest.createdAt,
      unread: messages.some((message) => !message.isRead && !isSelf(message.from, connection)),
      status: "open",
      messageCount: mappedMessages.length,
      contextLabel: connection.profile.displayName,
      messages: mappedMessages,
    };
  }

  private async mapOutlookMessage(message: OutlookMessageRecord, connection: ConnectionSummary): Promise<InboxMessage> {
    let attachments: InboxAttachment[] = [];
    if (message.hasAttachments) {
      const output = asRecord(
        await this.runOutlookAction(connection.id, "outlook.list_attachments", { messageId: message.id }),
      );
      attachments = (Array.isArray(output.attachments) ? output.attachments : []).flatMap((raw) => {
        const attachment = optionalRecord(raw);
        const id = optionalString(attachment?.id);
        if (!attachment || !id || attachment.isInline === true) return [];
        return [
          {
            id,
            name: optionalString(attachment.name) ?? "attachment",
            mimeType: optionalString(attachment.contentType) ?? "application/octet-stream",
            sizeBytes: typeof attachment.size === "number" ? attachment.size : 0,
            downloadUrl: `/api/inbox/attachments/${encodeAttachmentReference({
              connectionId: connection.id,
              messageId: message.id,
              attachmentId: id,
            })}`,
          },
        ];
      });
    }
    return {
      id: message.id,
      direction: isSelf(message.from, connection) ? "outbound" : "inbound",
      sender: toParticipant(message.from),
      content: message.body || message.preview,
      createdAt: message.createdAt,
      attachments,
    };
  }

  private async requireOutlookConnection(connectionId: string): Promise<ConnectionSummary> {
    const connection = (await this.options.connections.listConnections()).find(
      (item) => item.id === connectionId && item.service === "outlook" && item.configured,
    );
    if (!connection) throw new InboxError("source_not_found", "Outlook connection not found.", 404);
    return connection;
  }

  private async runOutlookAction(connectionId: string, actionId: string, input: unknown): Promise<unknown> {
    const run = await this.options.actions.run({
      actionId,
      input,
      caller: "web",
      connectionId,
      policy: await this.options.getPolicySnapshot(),
      approvalPolicy: "bypass",
    });
    if (!run) throw new InboxError("action_not_found", `Required Outlook action is unavailable: ${actionId}.`, 500);
    if (!run.result.ok) {
      throw new InboxError(
        run.result.error?.code ?? "provider_error",
        run.result.error?.message ?? "Outlook request failed.",
        503,
      );
    }
    return run.result.output;
  }
}

export class InboxError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 500 | 503;

  constructor(code: string, message: string, status: 400 | 403 | 404 | 409 | 500 | 503 = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function teamsSourceId(agentId: string): string {
  return `teams:${agentId}`;
}

function outlookSourceId(connectionId: string): string {
  return `outlook:${connectionId}`;
}

function teamsParticipants(thread: TeamsGatewayThread): InboxParticipant[] {
  if (thread.members?.length) {
    return thread.members.map((member) => ({ name: member.displayName, email: member.email }));
  }
  return [{ name: thread.participantName || thread.participantEmail, email: thread.participantEmail }];
}

function teamsContextLabel(thread: TeamsGatewayThread, agents: TeamsGatewayAgent[]): string {
  const agentName = agents.find((agent) => agent.id === thread.agentId)?.name ?? "Teams";
  if (thread.conversationKind === "channel") {
    return [thread.teamName, thread.channelName].filter(Boolean).join(" · ") || agentName;
  }
  return thread.conversationKind === "group_chat" ? (thread.conversationName ?? agentName) : agentName;
}

function mapTeamsMessage(
  message: TeamsGatewayMessage,
  thread: TeamsGatewayThread,
  agents: TeamsGatewayAgent[],
): InboxMessage {
  const outbound = message.role === "assistant";
  return {
    id: message.id,
    direction: outbound ? "outbound" : "inbound",
    sender: outbound
      ? { name: agents.find((agent) => agent.id === thread.agentId)?.name ?? "Agent" }
      : { name: thread.participantName || thread.participantEmail, email: thread.participantEmail },
    content: message.content,
    createdAt: message.createdAt,
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id ?? attachment.fileId ?? attachment.name,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      downloadUrl: attachment.downloadUrl,
      error: attachment.error,
    })),
  };
}

function parseOutlookMessage(value: unknown): OutlookMessageRecord | undefined {
  const message = optionalRecord(value);
  const id = optionalString(message?.id);
  if (!message || !id) return undefined;
  const conversationId = optionalString(message.conversationId) ?? id;
  const from = readOutlookAddress(message.from) ?? readOutlookAddress(message.sender) ?? { name: "Unknown sender" };
  const body = optionalRecord(message.body);
  const bodyContent = optionalString(body?.content) ?? "";
  return {
    id,
    conversationId,
    subject: optionalString(message.subject) ?? "",
    preview: optionalString(message.bodyPreview) ?? "",
    body: optionalString(body?.contentType)?.toLowerCase() === "html" ? stripHtml(bodyContent) : bodyContent.trim(),
    from,
    recipients: Array.isArray(message.toRecipients)
      ? message.toRecipients.flatMap((recipient) => {
          const address = readOutlookAddress(recipient);
          return address ? [address] : [];
        })
      : [],
    createdAt:
      optionalString(message.receivedDateTime) ?? optionalString(message.sentDateTime) ?? new Date(0).toISOString(),
    isRead: message.isRead === true,
    hasAttachments: message.hasAttachments === true,
  };
}

function readOutlookAddress(value: unknown): OutlookMessageAddress | undefined {
  const envelope = optionalRecord(value);
  const emailAddress = optionalRecord(envelope?.emailAddress) ?? envelope;
  if (!emailAddress) return undefined;
  const address = optionalString(emailAddress.address);
  const name = optionalString(emailAddress.name) ?? address;
  return name ? { name, address } : undefined;
}

function toParticipant(value: OutlookMessageAddress): InboxParticipant {
  return { name: value.name, email: value.address };
}

function uniqueParticipants(values: OutlookMessageAddress[]): OutlookMessageAddress[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = (value.address ?? value.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSelf(address: OutlookMessageAddress, connection: ConnectionSummary): boolean {
  return Boolean(address.address && address.address.toLowerCase() === connection.profile.displayName.toLowerCase());
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readReplyText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalidInput("text must be a string.");
  const text = value.trim();
  if (text.length > maxInboxReplyCharacters) {
    throw invalidInput(`text must be at most ${maxInboxReplyCharacters} characters.`);
  }
  return text;
}

function readReplyAttachments(value: unknown): InboxReplyAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidInput("attachments must be an array.");
  if (value.length > maxInboxAttachments) {
    throw invalidInput(`A reply can include at most ${maxInboxAttachments} attachments.`);
  }
  return value.map((item, index) => {
    const attachment = requiredRecord(item, `attachments[${index}]`, invalidInput);
    const fileId = optionalString(attachment.fileId);
    if (!fileId) throw invalidInput(`attachments[${index}].fileId is required.`);
    return { fileId, name: optionalString(attachment.name) };
  });
}

function encodeReference(reference: InboxConversationReference): string {
  return Buffer.from(JSON.stringify(reference), "utf8").toString("base64url");
}

function decodeReference(value: string): InboxConversationReference {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const reference = requiredRecord(parsed, "conversation reference", invalidConversation);
    if (reference.provider === "microsoft_teams") {
      const threadId = optionalString(reference.threadId);
      if (threadId) return { provider: "microsoft_teams", threadId };
    }
    if (reference.provider === "outlook") {
      const connectionId = optionalString(reference.connectionId);
      const conversationId = optionalString(reference.conversationId);
      const messageId = optionalString(reference.messageId);
      if (connectionId && conversationId && messageId) {
        return { provider: "outlook", connectionId, conversationId, messageId };
      }
    }
  } catch (error) {
    if (error instanceof InboxError) throw error;
  }
  throw invalidConversation("Invalid inbox conversation reference.");
}

interface OutlookAttachmentReference {
  connectionId: string;
  messageId: string;
  attachmentId: string;
}

function encodeAttachmentReference(reference: OutlookAttachmentReference): string {
  return Buffer.from(JSON.stringify(reference), "utf8").toString("base64url");
}

function decodeAttachmentReference(value: string): OutlookAttachmentReference {
  try {
    const parsed = requiredRecord(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      "attachment reference",
      invalidConversation,
    );
    const connectionId = optionalString(parsed.connectionId);
    const messageId = optionalString(parsed.messageId);
    const attachmentId = optionalString(parsed.attachmentId);
    if (connectionId && messageId && attachmentId) return { connectionId, messageId, attachmentId };
  } catch (error) {
    if (error instanceof InboxError) throw error;
  }
  throw invalidConversation("Invalid inbox attachment reference.");
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) throw new InboxError("provider_error", "Outlook returned an invalid response.", 503);
  return record;
}

function invalidInput(message: string): InboxError {
  return new InboxError("invalid_input", message, 400);
}

function invalidConversation(message: string): InboxError {
  return new InboxError("invalid_conversation", message, 400);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Inbox source could not be loaded.";
}
