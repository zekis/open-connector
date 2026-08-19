import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { MicrosoftTeamsActionHandler, MicrosoftTeamsRuntimeDeps } from "./graph-client.ts";

import { compactObject, optionalString, requiredString } from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import { defineOAuthProviderExecutors } from "../provider-runtime.ts";
import { microsoftTeamsCollectionRequest, microsoftTeamsJsonRequest } from "./graph-client.ts";

export const microsoftTeamsActionHandlers: Record<string, MicrosoftTeamsActionHandler> = {
  get_profile(_input, deps) {
    return getProfile(deps);
  },
  list_joined_teams(input, deps) {
    return listJoinedTeams(input, deps);
  },
  list_channels(input, deps) {
    return listChannels(input, deps);
  },
  list_channel_messages(input, deps) {
    return listChannelMessages(input, deps);
  },
  get_channel_message(input, deps) {
    return getChannelMessage(input, deps);
  },
  list_channel_message_replies(input, deps) {
    return listChannelMessageReplies(input, deps);
  },
  send_channel_message(input, deps) {
    return sendChannelMessage(input, deps);
  },
  reply_to_channel_message(input, deps) {
    return replyToChannelMessage(input, deps);
  },
  list_chats(input, deps) {
    return listChats(input, deps);
  },
  list_chat_messages(input, deps) {
    return listChatMessages(input, deps);
  },
  send_chat_message(input, deps) {
    return sendChatMessage(input, deps);
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(
  "microsoft_teams",
  microsoftTeamsActionHandlers,
);

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const currentAccount = await microsoftTeamsJsonRequest<{
      id?: unknown;
      displayName?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
    }>(
      "me",
      {
        accessToken: input.accessToken,
        tokenType: input.tokenType,
        fetcher,
        signal,
      },
      {
        query: { $select: "id,displayName,mail,userPrincipalName" },
      },
    );
    const accountId = requiredString(currentAccount.id, "Microsoft Teams current account ID");
    return {
      profile: {
        accountId,
        displayName:
          optionalString(currentAccount.mail) ??
          optionalString(currentAccount.userPrincipalName) ??
          optionalString(currentAccount.displayName) ??
          accountId,
      },
      metadata: {
        currentAccount,
      },
    };
  },
};

async function getProfile(deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  return microsoftTeamsJsonRequest("me", deps, {
    query: { $select: "id,displayName,mail,userPrincipalName" },
  });
}

async function listJoinedTeams(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftTeamsCollectionRequest(nextLink ?? "me/joinedTeams", deps, {
    nextLinkKind: "joined_teams",
  });
  return { teams: result.items, nextLink: result.nextLink };
}

async function listChannels(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftTeamsCollectionRequest(
    nextLink ?? `teams/${pathId(input.teamId, "teamId")}/channels`,
    deps,
    {
      nextLinkKind: "channels",
      query: nextLink
        ? undefined
        : compactObject({
            $filter: optionalString(input.filter),
            $select: stringList(input.select),
          }),
    },
  );
  return { channels: result.items, nextLink: result.nextLink };
}

async function listChannelMessages(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftTeamsCollectionRequest(nextLink ?? `${channelPath(input)}/messages`, deps, {
    nextLinkKind: "channel_messages",
    query: nextLink
      ? undefined
      : compactObject({
          $top: typeof input.top === "number" ? input.top : undefined,
          $expand: input.includeReplies === true ? "replies" : undefined,
        }),
  });
  return { messages: result.items, nextLink: result.nextLink };
}

async function getChannelMessage(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  return microsoftTeamsJsonRequest(`${channelPath(input)}/messages/${pathId(input.messageId, "messageId")}`, deps, {
    query: input.includeReplies === true ? { $expand: "replies" } : undefined,
  });
}

async function listChannelMessageReplies(
  input: Record<string, unknown>,
  deps: MicrosoftTeamsRuntimeDeps,
): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftTeamsCollectionRequest(
    nextLink ?? `${channelPath(input)}/messages/${pathId(input.messageId, "messageId")}/replies`,
    deps,
    {
      nextLinkKind: "channel_replies",
      query: nextLink
        ? undefined
        : compactObject({
            $top: typeof input.top === "number" ? input.top : undefined,
          }),
    },
  );
  return { replies: result.items, nextLink: result.nextLink };
}

async function sendChannelMessage(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  return microsoftTeamsJsonRequest(`${channelPath(input)}/messages`, deps, {
    method: "POST",
    body: buildMessagePayload(input, true),
  });
}

async function replyToChannelMessage(
  input: Record<string, unknown>,
  deps: MicrosoftTeamsRuntimeDeps,
): Promise<unknown> {
  return microsoftTeamsJsonRequest(
    `${channelPath(input)}/messages/${pathId(input.messageId, "messageId")}/replies`,
    deps,
    {
      method: "POST",
      body: buildMessagePayload(input, false),
    },
  );
}

async function listChats(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const expansions = [
    input.includeMembers === true ? "members" : undefined,
    input.includeLastMessagePreview === true ? "lastMessagePreview" : undefined,
  ].filter((value): value is string => value !== undefined);
  const result = await microsoftTeamsCollectionRequest(nextLink ?? "chats", deps, {
    nextLinkKind: "chats",
    query: nextLink
      ? undefined
      : compactObject({
          $top: typeof input.top === "number" ? input.top : undefined,
          $filter: optionalString(input.filter),
          $orderby: input.orderByLastMessage === true ? "lastMessagePreview/createdDateTime desc" : undefined,
          $expand: expansions.length > 0 ? expansions.join(",") : undefined,
        }),
  });
  return { chats: result.items, nextLink: result.nextLink };
}

async function listChatMessages(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const result = await microsoftTeamsCollectionRequest(
    nextLink ?? `chats/${pathId(input.chatId, "chatId")}/messages`,
    deps,
    {
      nextLinkKind: "chat_messages",
      query: nextLink
        ? undefined
        : compactObject({
            $top: typeof input.top === "number" ? input.top : undefined,
            $orderby: optionalString(input.orderBy),
            $filter: optionalString(input.filter),
          }),
    },
  );
  return { messages: result.items, nextLink: result.nextLink };
}

async function sendChatMessage(input: Record<string, unknown>, deps: MicrosoftTeamsRuntimeDeps): Promise<unknown> {
  return microsoftTeamsJsonRequest(`chats/${pathId(input.chatId, "chatId")}/messages`, deps, {
    method: "POST",
    body: buildMessagePayload(input, false),
  });
}

function buildMessagePayload(input: Record<string, unknown>, includeSubject: boolean): Record<string, unknown> {
  return compactObject({
    body: {
      content: requiredString(input.content, "content"),
      contentType: optionalString(input.contentType) ?? "text",
    },
    subject: includeSubject ? optionalString(input.subject) : undefined,
    importance: optionalString(input.importance),
  });
}

function channelPath(input: Record<string, unknown>): string {
  return `teams/${pathId(input.teamId, "teamId")}/channels/${pathId(input.channelId, "channelId")}`;
}

function pathId(value: unknown, fieldName: string): string {
  return encodePathSegment(requiredString(value, fieldName));
}

function stringList(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value.map(String) : undefined;
  return values && values.length > 0 ? values.join(",") : undefined;
}
