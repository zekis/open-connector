import type { ConnectionService } from "../../connection-service.ts";
import type { MicrosoftTeamsRuntimeDeps } from "../../providers/microsoft_teams/graph-client.ts";

import { optionalRecord, optionalString, requiredRecord, requiredString } from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import {
  microsoftTeamsCollectionRequest,
  microsoftTeamsJsonRequest,
} from "../../providers/microsoft_teams/graph-client.ts";
import { providerFetch } from "../../providers/provider-runtime.ts";

export interface TeamsGatewayGraphMember {
  userId: string;
  tenantId?: string;
  email?: string;
  displayName: string;
}

export interface TeamsGatewayGraphChat {
  id: string;
  chatType: string;
  members: TeamsGatewayGraphMember[];
  lastMessageAt?: string;
}

export interface TeamsGatewayGraphMessage {
  id: string;
  createdAt: string;
  senderId?: string;
  senderName: string;
  text: string;
}

export interface TeamsGatewayGraphContext {
  selfId: string;
  selfEmail: string;
  deps: MicrosoftTeamsRuntimeDeps;
}

export interface ITeamsGatewayGraphClient {
  context(connectionId: string): Promise<TeamsGatewayGraphContext>;
  listChats(context: TeamsGatewayGraphContext): Promise<TeamsGatewayGraphChat[]>;
  listMessages(context: TeamsGatewayGraphContext, chatId: string, since: string): Promise<TeamsGatewayGraphMessage[]>;
  resolveUser(context: TeamsGatewayGraphContext, userId: string): Promise<TeamsGatewayGraphMember>;
  sendMessage(context: TeamsGatewayGraphContext, chatId: string, text: string): Promise<{ id?: string }>;
  createOneOnOneChat(context: TeamsGatewayGraphContext, recipientEmail: string): Promise<{ id: string }>;
}

/** Delegated Microsoft Graph transport used only by the Teams gateway host. */
export class TeamsGatewayGraphClient implements ITeamsGatewayGraphClient {
  private readonly connections: Pick<ConnectionService, "resolveForExecutionById">;

  constructor(connections: Pick<ConnectionService, "resolveForExecutionById">) {
    this.connections = connections;
  }

  async context(connectionId: string): Promise<TeamsGatewayGraphContext> {
    const execution = await this.connections.resolveForExecutionById("microsoft_teams", connectionId);
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
          const id = optionalString(item.id);
          if (!id) return [];
          return [
            {
              id,
              chatType: optionalString(item.chatType) ?? "unknown",
              members: Array.isArray(item.members) ? item.members.flatMap(readMember) : [],
              lastMessageAt: optionalString(optionalRecord(item.lastMessagePreview)?.createdDateTime),
            },
          ];
        }),
      );
      path = result.nextLink;
      pages += 1;
    }
    return chats;
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
        const from = optionalRecord(optionalRecord(item.from)?.user);
        const body = optionalRecord(item.body);
        const text = htmlToText(optionalString(body?.content) ?? "");
        if (!text) continue;
        messages.push({
          id,
          createdAt,
          senderId: optionalString(from?.id),
          senderName: optionalString(from?.displayName) ?? "Unknown",
          text,
        });
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
        body: { body: { contentType: "text", content: text } },
      }),
      "Microsoft Teams sent message",
    );
    return { id: optionalString(value.id) };
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
    .replace(/[ \t]+/gu, " ")
    .replace(/\n\s+/gu, "\n")
    .trim();
}
