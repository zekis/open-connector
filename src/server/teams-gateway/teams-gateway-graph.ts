import type { ConnectionService } from "../../connection-service.ts";
import type { OAuthClientConfigService } from "../../oauth/oauth-client-config-service.ts";
import type { MicrosoftTeamsRuntimeDeps } from "../../providers/microsoft_teams/graph-client.ts";

import { Buffer } from "node:buffer";
import { optionalRecord, optionalString, requiredRecord, requiredString } from "../../core/cast.ts";
import { encodePathSegment, readBoundedResponseBytes } from "../../core/request.ts";
import {
  microsoftTeamsCollectionRequest,
  microsoftTeamsJsonRequest,
  microsoftTeamsRequest,
} from "../../providers/microsoft_teams/graph-client.ts";
import { ProviderRequestError, providerFetch } from "../../providers/provider-runtime.ts";
import { renderTeamsMessageHtml } from "./teams-message-html.ts";

export interface TeamsGatewayGraphMember {
  userId: string;
  tenantId?: string;
  email?: string;
  displayName: string;
}

export interface TeamsGatewayGraphChat {
  id: string;
  chatType: string;
  topic?: string;
  tenantId?: string;
  webUrl?: string;
  members: TeamsGatewayGraphMember[];
  lastMessageAt?: string;
}

export interface TeamsGatewayGraphTeam {
  id: string;
  displayName: string;
  description?: string;
  tenantId?: string;
  webUrl?: string;
}

export interface TeamsGatewayGraphChannel {
  id: string;
  displayName: string;
  description?: string;
  membershipType?: string;
  webUrl?: string;
}

export interface TeamsGatewayGraphMessage {
  id: string;
  createdAt: string;
  senderId?: string;
  senderName: string;
  text: string;
  attachments: TeamsGatewayGraphAttachment[];
  modifiedAt?: string;
}

export interface TeamsGatewayGraphAttachment {
  id: string;
  kind: "reference" | "hosted";
  name: string;
  contentType?: string;
  contentUrl: string;
}

export interface TeamsGatewayGraphFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface TeamsGatewayGraphReaction {
  reactionType: string;
  userId: string;
}

export interface TeamsGatewayGraphChannelThread {
  root: TeamsGatewayGraphMessage;
  replies: TeamsGatewayGraphMessage[];
}

export interface TeamsGatewayGraphContext {
  selfId: string;
  selfEmail: string;
  presenceSessionId?: string;
  deps: MicrosoftTeamsRuntimeDeps;
}

export interface TeamsGatewayGraphSubscriptionInput {
  changeType: string;
  notificationUrl: string;
  resource: string;
  clientState: string;
  expiresAt: string;
}

export interface TeamsGatewayGraphSubscription {
  id: string;
  resource: string;
  expiresAt: string;
}

export interface ITeamsGatewayGraphClient {
  context(connectionId: string): Promise<TeamsGatewayGraphContext>;
  listChats(context: TeamsGatewayGraphContext): Promise<TeamsGatewayGraphChat[]>;
  getChat(context: TeamsGatewayGraphContext, chatId: string): Promise<TeamsGatewayGraphChat>;
  listJoinedTeams(context: TeamsGatewayGraphContext): Promise<TeamsGatewayGraphTeam[]>;
  listChannels(context: TeamsGatewayGraphContext, teamId: string): Promise<TeamsGatewayGraphChannel[]>;
  listChannelThreads(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    since: string,
  ): Promise<TeamsGatewayGraphChannelThread[]>;
  listChannelReplies(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    since: string,
  ): Promise<TeamsGatewayGraphMessage[]>;
  listMessages(context: TeamsGatewayGraphContext, chatId: string, since: string): Promise<TeamsGatewayGraphMessage[]>;
  getChatMessage(
    context: TeamsGatewayGraphContext,
    chatId: string,
    messageId: string,
  ): Promise<TeamsGatewayGraphMessage | undefined>;
  getChannelMessage(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    messageId: string,
  ): Promise<TeamsGatewayGraphMessage | undefined>;
  getChannelReply(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    replyId: string,
  ): Promise<TeamsGatewayGraphMessage | undefined>;
  getChatMessageReactions(
    context: TeamsGatewayGraphContext,
    chatId: string,
    messageId: string,
  ): Promise<TeamsGatewayGraphReaction[]>;
  getChannelReplyReactions(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    replyId: string,
  ): Promise<TeamsGatewayGraphReaction[]>;
  setChatMessageReaction(
    context: TeamsGatewayGraphContext,
    chatId: string,
    messageId: string,
    reactionType: string,
  ): Promise<void>;
  setChannelMessageReaction(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    replyId: string | undefined,
    reactionType: string,
  ): Promise<void>;
  downloadAttachment(
    context: TeamsGatewayGraphContext,
    attachment: TeamsGatewayGraphAttachment,
    maxBytes: number,
  ): Promise<TeamsGatewayGraphFile>;
  resolveUser(context: TeamsGatewayGraphContext, userId: string): Promise<TeamsGatewayGraphMember>;
  sendMessage(context: TeamsGatewayGraphContext, chatId: string, text: string): Promise<{ id?: string }>;
  sendChannelReply(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    text: string,
  ): Promise<{ id?: string }>;
  sendChatAttachment(
    context: TeamsGatewayGraphContext,
    chatId: string,
    file: File,
    caption?: string,
  ): Promise<{ id?: string; name: string; webUrl: string }>;
  sendChannelReplyAttachment(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    file: File,
    caption?: string,
  ): Promise<{ id?: string; name: string; webUrl: string }>;
  createOneOnOneChat(context: TeamsGatewayGraphContext, recipientEmail: string): Promise<{ id: string }>;
  createSubscription(
    context: TeamsGatewayGraphContext,
    input: TeamsGatewayGraphSubscriptionInput,
  ): Promise<TeamsGatewayGraphSubscription>;
  renewSubscription(
    context: TeamsGatewayGraphContext,
    subscriptionId: string,
    expiresAt: string,
  ): Promise<TeamsGatewayGraphSubscription>;
  deleteSubscription(context: TeamsGatewayGraphContext, subscriptionId: string): Promise<void>;
  setPresence(context: TeamsGatewayGraphContext): Promise<void>;
  clearPresence(context: TeamsGatewayGraphContext): Promise<void>;
}

/** Delegated Microsoft Graph transport used only by the Teams gateway host. */
export class TeamsGatewayGraphClient implements ITeamsGatewayGraphClient {
  private readonly connections: Pick<ConnectionService, "resolveForExecutionById">;
  private readonly oauthClientConfigs: Pick<OAuthClientConfigService, "getConfig">;

  constructor(
    connections: Pick<ConnectionService, "resolveForExecutionById">,
    oauthClientConfigs: Pick<OAuthClientConfigService, "getConfig">,
  ) {
    this.connections = connections;
    this.oauthClientConfigs = oauthClientConfigs;
  }

  async context(connectionId: string): Promise<TeamsGatewayGraphContext> {
    const execution = await this.connections.resolveForExecutionById("microsoft_teams", connectionId);
    const oauthClientConfig = await this.oauthClientConfigs.getConfig("microsoft_teams");
    const credential = await execution.getCredential("microsoft_teams");
    if (!credential || credential.authType !== "oauth2") {
      throw new Error(`Microsoft Teams connection ${connectionId} does not have a delegated OAuth credential.`);
    }
    const currentAccount = optionalRecord(credential.metadata.currentAccount);
    const selfEmail =
      optionalString(currentAccount?.mail) ??
      optionalString(currentAccount?.userPrincipalName) ??
      execution.summary?.profile.displayName;
    if (!selfEmail) throw new Error(`Microsoft Teams connection ${connectionId} has no account email.`);
    return {
      selfId: credential.profile.accountId,
      selfEmail: selfEmail.toLowerCase(),
      presenceSessionId: oauthClientConfig?.clientId,
      deps: {
        accessToken: credential.accessToken,
        tokenType: credential.tokenType,
        fetcher: providerFetch,
      },
    };
  }

  async listChats(context: TeamsGatewayGraphContext): Promise<TeamsGatewayGraphChat[]> {
    const chats: TeamsGatewayGraphChat[] = [];
    let path: string | null = "me/chats";
    let pages = 0;
    while (path && pages < 10) {
      const result = await microsoftTeamsCollectionRequest(path, context.deps, {
        query: path.startsWith("http") ? undefined : { $top: 50, $expand: "members,lastMessagePreview" },
        nextLinkKind: "chats",
      });
      chats.push(
        ...result.items.flatMap((item) => {
          return optionalString(item.id) ? [readChat(item)] : [];
        }),
      );
      path = result.nextLink;
      pages += 1;
    }
    return chats;
  }

  async getChat(context: TeamsGatewayGraphContext, chatId: string): Promise<TeamsGatewayGraphChat> {
    const item = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(`chats/${encodePathSegment(chatId)}`, context.deps, {
        query: { $expand: "members" },
      }),
      "Microsoft Teams chat",
    );
    return readChat(item);
  }

  async listJoinedTeams(context: TeamsGatewayGraphContext): Promise<TeamsGatewayGraphTeam[]> {
    const teams: TeamsGatewayGraphTeam[] = [];
    let path: string | null = "me/joinedTeams";
    let pages = 0;
    while (path && pages < 10) {
      const result = await microsoftTeamsCollectionRequest(path, context.deps, {
        nextLinkKind: "joined_teams",
      });
      teams.push(
        ...result.items.flatMap((item) => {
          const id = optionalString(item.id);
          if (!id) return [];
          return [
            {
              id,
              displayName: optionalString(item.displayName) ?? id,
              description: optionalString(item.description),
              tenantId: optionalString(item.tenantId),
              webUrl: optionalString(item.webUrl),
            },
          ];
        }),
      );
      path = result.nextLink;
      pages += 1;
    }
    return teams;
  }

  async listChannels(context: TeamsGatewayGraphContext, teamId: string): Promise<TeamsGatewayGraphChannel[]> {
    const channels: TeamsGatewayGraphChannel[] = [];
    let path: string | null = `teams/${encodePathSegment(teamId)}/channels`;
    let pages = 0;
    while (path && pages < 10) {
      const result = await microsoftTeamsCollectionRequest(path, context.deps, {
        nextLinkKind: "channels",
      });
      channels.push(
        ...result.items.flatMap((item) => {
          const id = optionalString(item.id);
          if (!id) return [];
          return [
            {
              id,
              displayName: optionalString(item.displayName) ?? id,
              description: optionalString(item.description),
              membershipType: optionalString(item.membershipType),
              webUrl: optionalString(item.webUrl),
            },
          ];
        }),
      );
      path = result.nextLink;
      pages += 1;
    }
    return channels;
  }

  async listChannelThreads(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    since: string,
  ): Promise<TeamsGatewayGraphChannelThread[]> {
    const threads: TeamsGatewayGraphChannelThread[] = [];
    let path: string | null = `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}/messages`;
    let pages = 0;
    const floor = Date.parse(since);
    while (path && pages < 10) {
      const result = await microsoftTeamsCollectionRequest(path, context.deps, {
        query: path.startsWith("http") ? undefined : { $top: 50 },
        nextLinkKind: "channel_messages",
      });
      let oldestCreatedAt = Number.POSITIVE_INFINITY;
      for (const item of result.items) {
        const root = readMessage(item)[0];
        if (!root) continue;
        const createdAt = Date.parse(root.createdAt);
        oldestCreatedAt = Math.min(oldestCreatedAt, createdAt);
        if (createdAt < floor) continue;
        threads.push({ root, replies: [] });
      }
      path = result.nextLink;
      pages += 1;
      if (oldestCreatedAt < floor) break;
    }
    return threads;
  }

  async listChannelReplies(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    since: string,
  ): Promise<TeamsGatewayGraphMessage[]> {
    const replies: TeamsGatewayGraphMessage[] = [];
    let path: string | null =
      `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}` +
      `/messages/${encodePathSegment(rootMessageId)}/replies`;
    let pages = 0;
    const floor = Date.parse(since);
    while (path && pages < 10) {
      const result = await microsoftTeamsCollectionRequest(path, context.deps, {
        query: path.startsWith("http") ? undefined : { $top: 50 },
        nextLinkKind: "channel_replies",
      });
      let oldestCreatedAt = Number.POSITIVE_INFINITY;
      for (const item of result.items) {
        const message = readMessage(item)[0];
        if (!message) continue;
        const createdAt = Date.parse(message.createdAt);
        oldestCreatedAt = Math.min(oldestCreatedAt, createdAt);
        if (createdAt >= floor) replies.push(message);
      }
      path = result.nextLink;
      pages += 1;
      if (oldestCreatedAt < floor) break;
    }
    return replies.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  async listMessages(
    context: TeamsGatewayGraphContext,
    chatId: string,
    since: string,
  ): Promise<TeamsGatewayGraphMessage[]> {
    const messages: TeamsGatewayGraphMessage[] = [];
    let path: string | null = `me/chats/${encodePathSegment(chatId)}/messages`;
    let pages = 0;
    while (path && pages < 5) {
      const result = await microsoftTeamsCollectionRequest(path, context.deps, {
        query: path.startsWith("http") ? undefined : { $top: 50 },
        nextLinkKind: "chat_messages",
      });
      for (const item of result.items) {
        const createdAt = optionalString(item.createdDateTime);
        const id = optionalString(item.id);
        if (!createdAt || !id || Date.parse(createdAt) < Date.parse(since)) continue;
        if ((optionalString(item.messageType) ?? "message") !== "message") continue;
        messages.push(...readMessage(item));
      }
      path = result.nextLink;
      pages += 1;
      const oldest = messages.reduce(
        (value, item) => Math.min(value, Date.parse(item.createdAt)),
        Number.POSITIVE_INFINITY,
      );
      if (oldest <= Date.parse(since)) break;
    }
    return messages.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  async getChatMessage(
    context: TeamsGatewayGraphContext,
    chatId: string,
    messageId: string,
  ): Promise<TeamsGatewayGraphMessage | undefined> {
    const value = await microsoftTeamsJsonRequest<unknown>(
      `chats/${encodePathSegment(chatId)}/messages/${encodePathSegment(messageId)}`,
      context.deps,
    );
    return readMessage(value)[0];
  }

  async getChannelMessage(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    messageId: string,
  ): Promise<TeamsGatewayGraphMessage | undefined> {
    const value = await microsoftTeamsJsonRequest<unknown>(
      `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}` +
        `/messages/${encodePathSegment(messageId)}`,
      context.deps,
    );
    return readMessage(value)[0];
  }

  async getChannelReply(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    replyId: string,
  ): Promise<TeamsGatewayGraphMessage | undefined> {
    const value = await microsoftTeamsJsonRequest<unknown>(
      `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}` +
        `/messages/${encodePathSegment(rootMessageId)}/replies/${encodePathSegment(replyId)}`,
      context.deps,
    );
    return readMessage(value)[0];
  }

  async getChatMessageReactions(
    context: TeamsGatewayGraphContext,
    chatId: string,
    messageId: string,
  ): Promise<TeamsGatewayGraphReaction[]> {
    const message = await microsoftTeamsJsonRequest<unknown>(
      `chats/${encodePathSegment(chatId)}/messages/${encodePathSegment(messageId)}`,
      context.deps,
    );
    return readReactions(message);
  }

  async getChannelReplyReactions(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    replyId: string,
  ): Promise<TeamsGatewayGraphReaction[]> {
    const message = await microsoftTeamsJsonRequest<unknown>(
      `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}` +
        `/messages/${encodePathSegment(rootMessageId)}/replies/${encodePathSegment(replyId)}`,
      context.deps,
    );
    return readReactions(message);
  }

  async setChatMessageReaction(
    context: TeamsGatewayGraphContext,
    chatId: string,
    messageId: string,
    reactionType: string,
  ): Promise<void> {
    await microsoftTeamsRequest(
      `chats/${encodePathSegment(chatId)}/messages/${encodePathSegment(messageId)}/setReaction`,
      context.deps,
      { method: "POST", body: { reactionType } },
    );
  }

  async setChannelMessageReaction(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    replyId: string | undefined,
    reactionType: string,
  ): Promise<void> {
    const messagePath =
      `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}` +
      `/messages/${encodePathSegment(rootMessageId)}`;
    const targetPath = replyId ? `${messagePath}/replies/${encodePathSegment(replyId)}` : messagePath;
    await microsoftTeamsRequest(`${targetPath}/setReaction`, context.deps, {
      method: "POST",
      body: { reactionType },
    });
  }

  async downloadAttachment(
    context: TeamsGatewayGraphContext,
    attachment: TeamsGatewayGraphAttachment,
    maxBytes: number,
  ): Promise<TeamsGatewayGraphFile> {
    const response =
      attachment.kind === "reference"
        ? await microsoftTeamsRequest(
            `shares/u!${Buffer.from(attachment.contentUrl, "utf8").toString("base64url")}/driveItem/content`,
            context.deps,
          )
        : await microsoftTeamsRequest(hostedContentPath(attachment.contentUrl), context.deps);
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes,
      fieldName: `Microsoft Teams attachment ${attachment.name}`,
      createError: (message) => new ProviderRequestError(413, message),
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream";
    return {
      name: attachment.kind === "hosted" ? ensureImageExtension(attachment.name, contentType) : attachment.name,
      contentType,
      bytes,
    };
  }

  async resolveUser(context: TeamsGatewayGraphContext, userId: string): Promise<TeamsGatewayGraphMember> {
    const value = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(`users/${encodePathSegment(userId)}`, context.deps, {
        query: { $select: "id,displayName,mail,userPrincipalName" },
      }),
      "Microsoft Teams user",
    );
    return {
      userId: requiredString(value.id, "Microsoft Teams user id"),
      email: (optionalString(value.mail) ?? optionalString(value.userPrincipalName))?.toLowerCase(),
      displayName: optionalString(value.displayName) ?? userId,
    };
  }

  async sendMessage(context: TeamsGatewayGraphContext, chatId: string, text: string): Promise<{ id?: string }> {
    const value = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(`chats/${encodePathSegment(chatId)}/messages`, context.deps, {
        method: "POST",
        body: { body: { contentType: "html", content: renderTeamsMessageHtml(text) } },
      }),
      "Microsoft Teams sent message",
    );
    return { id: optionalString(value.id) };
  }

  async sendChannelReply(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    text: string,
  ): Promise<{ id?: string }> {
    const value = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(
        `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}/messages/${encodePathSegment(rootMessageId)}/replies`,
        context.deps,
        { method: "POST", body: { body: { contentType: "html", content: renderTeamsMessageHtml(text) } } },
      ),
      "Microsoft Teams channel reply",
    );
    return { id: optionalString(value.id) };
  }

  async sendChatAttachment(
    context: TeamsGatewayGraphContext,
    chatId: string,
    file: File,
    caption = "",
  ): Promise<{ id?: string; name: string; webUrl: string }> {
    const item = await uploadOneDriveFile(context, file);
    const driveId = requiredString(optionalRecord(item.parentReference)?.driveId, "OneDrive item drive ID");
    const itemId = requiredString(item.id, "OneDrive item ID");
    const shareLink = optionalRecord(
      await microsoftTeamsJsonRequest<unknown>(
        `drives/${encodePathSegment(driveId)}/items/${encodePathSegment(itemId)}/createLink`,
        context.deps,
        { method: "POST", body: { type: "view", scope: "organization" } },
      ),
    );
    const webUrl = optionalString(optionalRecord(shareLink?.link)?.webUrl) ?? optionalString(item.webUrl);
    if (!webUrl) throw new ProviderRequestError(502, "Microsoft Teams file share link is missing.");
    const sent = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(`chats/${encodePathSegment(chatId)}/messages`, context.deps, {
        method: "POST",
        body: {
          body: {
            contentType: "html",
            content: `${caption ? renderTeamsMessageHtml(caption) : ""}<p>📎 <a href="${escapeHtml(webUrl)}">${escapeHtml(file.name)}</a></p>`,
          },
        },
      }),
      "Microsoft Teams sent file message",
    );
    return { id: optionalString(sent.id), name: optionalString(item.name) ?? file.name, webUrl };
  }

  async sendChannelReplyAttachment(
    context: TeamsGatewayGraphContext,
    teamId: string,
    channelId: string,
    rootMessageId: string,
    file: File,
    caption = "",
  ): Promise<{ id?: string; name: string; webUrl: string }> {
    const folder = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(
        `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}/filesFolder`,
        context.deps,
      ),
      "Microsoft Teams channel files folder",
    );
    const driveId = requiredString(optionalRecord(folder.parentReference)?.driveId, "Channel files drive ID");
    const folderId = requiredString(folder.id, "Channel files folder ID");
    const item = await uploadDriveFile(context, driveId, folderId, file);
    const webUrl = requiredString(item.webUrl, "Channel file web URL");
    const name = optionalString(item.name) ?? file.name;
    const attachmentId = driveItemAttachmentId(item);
    const sent = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(
        `teams/${encodePathSegment(teamId)}/channels/${encodePathSegment(channelId)}` +
          `/messages/${encodePathSegment(rootMessageId)}/replies`,
        context.deps,
        {
          method: "POST",
          body: {
            body: {
              contentType: "html",
              content: `${caption ? renderTeamsMessageHtml(caption) : ""}<attachment id="${escapeHtml(attachmentId)}"></attachment>`,
            },
            attachments: [{ id: attachmentId, contentType: "reference", contentUrl: webUrl, name }],
          },
        },
      ),
      "Microsoft Teams sent channel file reply",
    );
    return { id: optionalString(sent.id), name, webUrl };
  }

  async createOneOnOneChat(context: TeamsGatewayGraphContext, recipientEmail: string): Promise<{ id: string }> {
    const members = [context.selfEmail, recipientEmail].map((email) => ({
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${email.replaceAll("'", "''")}')`,
    }));
    const value = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>("chats", context.deps, {
        method: "POST",
        body: { chatType: "oneOnOne", members },
      }),
      "Microsoft Teams chat",
    );
    return { id: requiredString(value.id, "Microsoft Teams chat id") };
  }

  async createSubscription(
    context: TeamsGatewayGraphContext,
    input: TeamsGatewayGraphSubscriptionInput,
  ): Promise<TeamsGatewayGraphSubscription> {
    const value = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>("subscriptions", context.deps, {
        method: "POST",
        body: {
          changeType: input.changeType,
          notificationUrl: input.notificationUrl,
          resource: input.resource,
          clientState: input.clientState,
          expirationDateTime: input.expiresAt,
        },
      }),
      "Microsoft Graph subscription",
    );
    return readGraphSubscription(value, input.resource);
  }

  async renewSubscription(
    context: TeamsGatewayGraphContext,
    subscriptionId: string,
    expiresAt: string,
  ): Promise<TeamsGatewayGraphSubscription> {
    const value = requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(`subscriptions/${encodePathSegment(subscriptionId)}`, context.deps, {
        method: "PATCH",
        body: { expirationDateTime: expiresAt },
      }),
      "Microsoft Graph subscription",
    );
    return readGraphSubscription(value, "");
  }

  async deleteSubscription(context: TeamsGatewayGraphContext, subscriptionId: string): Promise<void> {
    await microsoftTeamsRequest(`subscriptions/${encodePathSegment(subscriptionId)}`, context.deps, {
      method: "DELETE",
    });
  }

  async setPresence(context: TeamsGatewayGraphContext): Promise<void> {
    if (!context.presenceSessionId) return;
    try {
      await microsoftTeamsRequest(`users/${encodePathSegment(context.selfId)}/presence/setPresence`, context.deps, {
        method: "POST",
        body: {
          sessionId: context.presenceSessionId,
          availability: "Available",
          activity: "Available",
          expirationDuration: "PT4H",
        },
      });
    } catch (error) {
      if (error instanceof ProviderRequestError && error.status === 403) {
        throw new Error(
          "Microsoft Teams denied presence publishing. Reconnect this account with Presence.ReadWrite and confirm the user has a Teams license.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async clearPresence(context: TeamsGatewayGraphContext): Promise<void> {
    if (!context.presenceSessionId) return;
    await microsoftTeamsRequest(`users/${encodePathSegment(context.selfId)}/presence/clearPresence`, context.deps, {
      method: "POST",
      body: { sessionId: context.presenceSessionId },
    });
  }
}

function readGraphSubscription(
  value: Record<string, unknown>,
  fallbackResource: string,
): TeamsGatewayGraphSubscription {
  return {
    id: requiredString(value.id, "Microsoft Graph subscription id"),
    resource: optionalString(value.resource) ?? fallbackResource,
    expiresAt: requiredString(value.expirationDateTime, "Microsoft Graph subscription expiration"),
  };
}

function readChat(value: Record<string, unknown>): TeamsGatewayGraphChat {
  const id = requiredString(value.id, "Microsoft Teams chat id");
  return {
    id,
    chatType: optionalString(value.chatType) ?? "unknown",
    topic: optionalString(value.topic),
    tenantId: optionalString(value.tenantId),
    webUrl: optionalString(value.webUrl),
    members: Array.isArray(value.members) ? value.members.flatMap(readMember) : [],
    lastMessageAt: optionalString(optionalRecord(value.lastMessagePreview)?.createdDateTime),
  };
}

function readMessage(value: unknown): TeamsGatewayGraphMessage[] {
  const item = optionalRecord(value);
  const createdAt = optionalString(item?.createdDateTime);
  const id = optionalString(item?.id);
  if (!item || !createdAt || !id || (optionalString(item.messageType) ?? "message") !== "message") return [];
  const from = optionalRecord(optionalRecord(item.from)?.user);
  const body = optionalRecord(item.body);
  const bodyContent = optionalString(body?.content) ?? "";
  const text = htmlToText(bodyContent);
  const attachments = readAttachments(item.attachments, bodyContent);
  if (!text && attachments.length === 0) return [];
  return [
    {
      id,
      createdAt,
      modifiedAt: optionalString(item.lastModifiedDateTime),
      senderId: optionalString(from?.id),
      senderName: optionalString(from?.displayName) ?? "Unknown",
      text,
      attachments,
    },
  ];
}

function readAttachments(value: unknown, bodyContent: string): TeamsGatewayGraphAttachment[] {
  const attachments = Array.isArray(value)
    ? value.flatMap((entry, index): TeamsGatewayGraphAttachment[] => {
        const attachment = optionalRecord(entry);
        if (optionalString(attachment?.contentType)?.toLowerCase() !== "reference") return [];
        const contentUrl = optionalString(attachment?.contentUrl);
        if (!attachment || !contentUrl) return [];
        return [
          {
            id: optionalString(attachment.id) ?? `reference-${index + 1}`,
            kind: "reference",
            name: optionalString(attachment.name) ?? `attachment-${index + 1}`,
            contentType: "reference",
            contentUrl,
          },
        ];
      })
    : [];
  const hostedPattern =
    /<img[^>]+src=["'](https:\/\/graph\.microsoft\.com\/[^"']+\/hostedContents\/[^"']+\/\$value)["']/giu;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = hostedPattern.exec(bodyContent))) {
    index += 1;
    attachments.push({
      id: `hosted-${index}`,
      kind: "hosted",
      name: `image-${index}`,
      contentUrl: match[1]!.replaceAll("&amp;", "&"),
    });
  }
  return attachments;
}

function readMember(value: unknown): TeamsGatewayGraphMember[] {
  const member = optionalRecord(value);
  const userId = optionalString(member?.userId);
  if (!member || !userId) return [];
  const email = optionalString(member.email) ?? optionalString(member.userPrincipalName);
  return [
    {
      userId,
      tenantId: optionalString(member.tenantId),
      email: email?.toLowerCase(),
      displayName: optionalString(member.displayName) ?? email ?? userId,
    },
  ];
}

function readReactions(value: unknown): TeamsGatewayGraphReaction[] {
  const reactions = optionalRecord(value)?.reactions;
  if (!Array.isArray(reactions)) return [];
  return reactions.flatMap((value) => {
    const reaction = optionalRecord(value);
    const reactionType = optionalString(reaction?.reactionType);
    const user = optionalRecord(optionalRecord(reaction?.user)?.user);
    const userId = optionalString(user?.id);
    return reactionType && userId ? [{ reactionType, userId }] : [];
  });
}

const simpleUploadMaxBytes = 4 * 1024 * 1024;
const uploadChunkBytes = 5 * 320 * 1024;
const uploadResponseMaxBytes = 8 * 1024 * 1024;

async function uploadOneDriveFile(context: TeamsGatewayGraphContext, file: File): Promise<Record<string, unknown>> {
  const folder = await ensureOneDriveFolder(context);
  const driveId = requiredString(optionalRecord(folder.parentReference)?.driveId, "OneDrive folder drive ID");
  const folderId = requiredString(folder.id, "OneDrive folder ID");
  return uploadDriveFile(context, driveId, folderId, file);
}

async function ensureOneDriveFolder(context: TeamsGatewayGraphContext): Promise<Record<string, unknown>> {
  try {
    return requiredRecord(
      await microsoftTeamsJsonRequest<unknown>("me/drive/root:/OpenConnector", context.deps),
      "OpenConnector OneDrive folder",
    );
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || error.status !== 404) throw error;
  }
  try {
    return requiredRecord(
      await microsoftTeamsJsonRequest<unknown>("me/drive/root/children", context.deps, {
        method: "POST",
        body: {
          name: "OpenConnector",
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        },
      }),
      "OpenConnector OneDrive folder",
    );
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || error.status !== 409) throw error;
    return requiredRecord(
      await microsoftTeamsJsonRequest<unknown>("me/drive/root:/OpenConnector", context.deps),
      "OpenConnector OneDrive folder",
    );
  }
}

async function uploadDriveFile(
  context: TeamsGatewayGraphContext,
  driveId: string,
  parentItemId: string,
  file: File,
): Promise<Record<string, unknown>> {
  const itemPath =
    `drives/${encodePathSegment(driveId)}/items/${encodePathSegment(parentItemId)}` +
    `:/${encodePathSegment(file.name)}:`;
  if (file.size <= simpleUploadMaxBytes) {
    return requiredRecord(
      await microsoftTeamsJsonRequest<unknown>(`${itemPath}/content`, context.deps, {
        method: "PUT",
        headers: { "content-type": file.type || "application/octet-stream" },
        rawBody: file,
      }),
      "Microsoft Teams uploaded file",
    );
  }
  const session = requiredRecord(
    await microsoftTeamsJsonRequest<unknown>(`${itemPath}/createUploadSession`, context.deps, {
      method: "POST",
      body: { item: { "@microsoft.graph.conflictBehavior": "replace", name: file.name } },
    }),
    "Microsoft Teams upload session",
  );
  const uploadUrl = requiredString(session.uploadUrl, "Microsoft Teams upload URL");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let finalItem: Record<string, unknown> | undefined;
  for (let start = 0; start < bytes.byteLength; start += uploadChunkBytes) {
    const end = Math.min(start + uploadChunkBytes, bytes.byteLength);
    const chunk = bytes.slice(start, end);
    const response = await context.deps.fetcher(uploadUrl, {
      method: "PUT",
      headers: {
        "content-length": String(chunk.byteLength),
        "content-range": `bytes ${start}-${end - 1}/${bytes.byteLength}`,
      },
      body: chunk,
      signal: context.deps.signal,
    });
    if (!response.ok) {
      throw new ProviderRequestError(
        response.status,
        `Microsoft Teams file upload failed with HTTP ${response.status}.`,
      );
    }
    const payload = await readBoundedResponseBytes(response, {
      maxBytes: uploadResponseMaxBytes,
      fieldName: "Microsoft Teams upload response",
      createError: (message) => new ProviderRequestError(502, message),
    });
    if (response.status !== 202 && payload.byteLength > 0) {
      try {
        finalItem = requiredRecord(JSON.parse(new TextDecoder().decode(payload)), "Microsoft Teams uploaded file");
      } catch (error) {
        if (error instanceof ProviderRequestError) throw error;
        throw new ProviderRequestError(502, "Microsoft Teams returned an invalid upload response.", error);
      }
    }
  }
  if (!finalItem) throw new ProviderRequestError(502, "Microsoft Teams upload session returned no drive item.");
  return finalItem;
}

function driveItemAttachmentId(item: Record<string, unknown>): string {
  const tag = optionalString(item.eTag) ?? optionalString(item.cTag) ?? "";
  return (
    tag.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu)?.[0] ??
    requiredString(item.id, "Microsoft Teams drive item ID")
  );
}

function hostedContentPath(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderRequestError(400, "Microsoft Teams hosted content URL is invalid.");
  }
  const pattern =
    /^\/v1\.0\/(?:chats\/[^/]+\/messages\/[^/]+|teams\/[^/]+\/channels\/[^/]+\/messages\/[^/]+(?:\/replies\/[^/]+)?)\/hostedContents\/[^/]+\/\$value$/u;
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || !pattern.test(url.pathname)) {
    throw new ProviderRequestError(400, "Microsoft Teams hosted content URL is outside Microsoft Graph.");
  }
  return `${url.pathname.slice("/v1.0/".length)}${url.search}`;
}

function ensureImageExtension(name: string, contentType: string): string {
  if (/\.[a-z0-9]{1,10}$/iu.test(name)) return name;
  const extension: Record<string, string> = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  return `${name}.${extension[contentType] ?? "img"}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, decodeNumericHtmlEntity)
    .replace(/[ \t]+/gu, " ")
    .replace(/\n\s+/gu, "\n")
    .trim();
}

function decodeNumericHtmlEntity(match: string, hexadecimal: string | undefined, decimal: string | undefined): string {
  const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal ? 16 : 10);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return match;
  return String.fromCodePoint(codePoint);
}
