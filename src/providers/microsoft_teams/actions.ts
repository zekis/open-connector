import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { microsoftTeamsProviderScopes } from "./scopes.ts";

const service = "microsoft_teams";

interface MicrosoftTeamsActionSource {
  name: string;
  description: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const rawObject = s.record(true, { description: "A Microsoft Graph JSON object." });
const nonEmptyString = (description: string): JsonSchema => s.string({ minLength: 1, description });
const stringArray = (description: string): JsonSchema =>
  s.array(nonEmptyString("A field name."), { minItems: 1, description });
const teamId = nonEmptyString("Microsoft Teams team ID.");
const channelId = nonEmptyString("Microsoft Teams channel ID.");
const chatId = nonEmptyString("Microsoft Teams chat ID.");
const messageId = nonEmptyString("Microsoft Teams message ID.");
const nextLink = s.url("Opaque pagination URL returned by a previous Microsoft Teams response.");
const contentType = s.stringEnum(["text", "html"], {
  description: "Message body content type. Defaults to text.",
});
const importance = s.stringEnum(["normal", "high", "urgent"], {
  description: "Message importance. Defaults to normal.",
});
const team = s.looseObject(
  {
    id: nonEmptyString("Team ID."),
    displayName: s.string({ description: "Team display name." }),
    description: s.nullableString("Team description."),
    webUrl: s.nullableString("URL that opens the team in Microsoft Teams."),
    isArchived: s.boolean({ description: "Whether the team is archived." }),
    tenantId: s.string({ description: "Microsoft Entra tenant ID that owns the team." }),
  },
  { description: "Microsoft Teams team resource." },
);
const channel = s.looseObject(
  {
    id: nonEmptyString("Channel ID."),
    displayName: s.string({ description: "Channel display name." }),
    description: s.nullableString("Channel description."),
    webUrl: s.nullableString("URL that opens the channel in Microsoft Teams."),
    membershipType: s.string({ description: "Channel membership type, such as standard, private, or shared." }),
    email: s.nullableString("Channel email address when available."),
    tenantId: s.string({ description: "Microsoft Entra tenant ID that owns the channel." }),
  },
  { description: "Microsoft Teams channel resource." },
);
const chat = s.looseObject(
  {
    id: nonEmptyString("Chat ID."),
    topic: s.nullableString("Chat topic."),
    chatType: s.string({ description: "Chat type, such as oneOnOne, group, or meeting." }),
    webUrl: s.nullableString("URL that opens the chat in Microsoft Teams."),
    createdDateTime: s.string({ description: "ISO 8601 chat creation timestamp." }),
    lastUpdatedDateTime: s.string({ description: "ISO 8601 timestamp of the latest chat update." }),
    members: s.array(rawObject, { description: "Chat members when requested." }),
    lastMessagePreview: rawObject,
  },
  { description: "Microsoft Teams chat resource." },
);
const chatMessage = s.looseObject(
  {
    id: nonEmptyString("Message ID."),
    replyToId: s.nullableString("Root message ID when this message is a reply."),
    etag: s.string({ description: "Message version identifier." }),
    messageType: s.string({ description: "Message type." }),
    createdDateTime: s.string({ description: "ISO 8601 message creation timestamp." }),
    lastModifiedDateTime: s.nullableString("ISO 8601 timestamp of the latest message change."),
    lastEditedDateTime: s.nullableString("ISO 8601 timestamp of the latest user edit."),
    deletedDateTime: s.nullableString("ISO 8601 message deletion timestamp."),
    subject: s.nullableString("Message subject."),
    summary: s.nullableString("Message summary."),
    importance: s.string({ description: "Message importance." }),
    locale: s.string({ description: "Message locale." }),
    webUrl: s.nullableString("URL that opens the message in Microsoft Teams."),
    from: rawObject,
    body: rawObject,
    channelIdentity: rawObject,
    attachments: s.array(rawObject, { description: "Message attachments." }),
    mentions: s.array(rawObject, { description: "Message mentions." }),
    reactions: s.array(rawObject, { description: "Message reactions." }),
    replies: s.array(rawObject, { description: "Channel message replies when expanded." }),
  },
  { description: "Microsoft Teams chat message resource." },
);
const profile = s.looseObject(
  {
    id: nonEmptyString("Unique identifier for the current Microsoft account."),
    displayName: s.string({ description: "Display name of the current account." }),
    mail: s.nullableString("Primary SMTP address for the current account."),
    userPrincipalName: s.string({ description: "User principal name for the current account." }),
  },
  { description: "Current Microsoft account profile." },
);

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Microsoft Teams action input.");
}

function collectionOutput(key: string, itemSchema: JsonSchema, description: string): JsonSchema {
  return s.object(
    {
      [key]: s.array(itemSchema, { description }),
      nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
    },
    { required: [key, "nextLink"], description },
  );
}

const actions: MicrosoftTeamsActionSource[] = [
  action(
    "get_profile",
    "Get the connected Microsoft work or school account profile.",
    [microsoftTeamsProviderScopes.userRead],
    input({}),
    profile,
  ),
  action(
    "list_joined_teams",
    "List the Microsoft Teams teams that the connected account has joined directly.",
    [microsoftTeamsProviderScopes.teamReadBasicAll],
    input({ nextLink }),
    collectionOutput("teams", team, "Teams joined by the connected account."),
  ),
  action(
    "list_channels",
    "List channels in a Microsoft Teams team, including standard, private, and shared channels visible to the account.",
    [microsoftTeamsProviderScopes.channelReadBasicAll],
    input(
      {
        teamId,
        filter: s.string({ description: "Optional Microsoft Graph OData filter for channels." }),
        select: stringArray("Channel fields to request from Microsoft Graph."),
        nextLink,
      },
      ["teamId"],
    ),
    collectionOutput("channels", channel, "Channels returned by Microsoft Teams."),
  ),
  action(
    "list_channel_messages",
    "List root messages in a Microsoft Teams channel, optionally including replies.",
    [microsoftTeamsProviderScopes.channelMessageReadAll],
    input(
      {
        teamId,
        channelId,
        top: s.integer({ minimum: 1, maximum: 50, description: "Maximum root messages to return per page." }),
        includeReplies: s.boolean({ description: "Expand replies into each root message. Defaults to false." }),
        nextLink,
      },
      ["teamId", "channelId"],
    ),
    collectionOutput("messages", chatMessage, "Root channel messages returned by Microsoft Teams."),
  ),
  action(
    "get_channel_message",
    "Get one root message from a Microsoft Teams channel, optionally including its replies.",
    [microsoftTeamsProviderScopes.channelMessageReadAll],
    input(
      {
        teamId,
        channelId,
        messageId,
        includeReplies: s.boolean({ description: "Expand replies into the root message. Defaults to false." }),
      },
      ["teamId", "channelId", "messageId"],
    ),
    chatMessage,
  ),
  action(
    "list_channel_message_replies",
    "List replies to a root message in a Microsoft Teams channel.",
    [microsoftTeamsProviderScopes.channelMessageReadAll],
    input(
      {
        teamId,
        channelId,
        messageId,
        top: s.integer({ minimum: 1, maximum: 50, description: "Maximum replies to return per page." }),
        nextLink,
      },
      ["teamId", "channelId", "messageId"],
    ),
    collectionOutput("replies", chatMessage, "Channel message replies returned by Microsoft Teams."),
  ),
  action(
    "send_channel_message",
    "Send a new root message to a Microsoft Teams channel.",
    [microsoftTeamsProviderScopes.channelMessageSend],
    input(
      {
        teamId,
        channelId,
        content: nonEmptyString("Message body content."),
        contentType,
        subject: s.string({ description: "Optional message subject." }),
        importance,
      },
      ["teamId", "channelId", "content"],
    ),
    chatMessage,
  ),
  action(
    "reply_to_channel_message",
    "Reply to an existing root message in a Microsoft Teams channel.",
    [microsoftTeamsProviderScopes.channelMessageSend],
    input(
      {
        teamId,
        channelId,
        messageId,
        content: nonEmptyString("Reply body content."),
        contentType,
        importance,
      },
      ["teamId", "channelId", "messageId", "content"],
    ),
    chatMessage,
  ),
  action(
    "list_chats",
    "List chats that the connected Microsoft Teams account participates in.",
    [microsoftTeamsProviderScopes.chatRead],
    input({
      top: s.integer({ minimum: 1, maximum: 50, description: "Maximum chats to return per page." }),
      filter: s.string({ description: "Optional Microsoft Graph OData filter for chats." }),
      orderByLastMessage: s.boolean({
        description: "Order chats by latest message time descending. Defaults to false.",
      }),
      includeMembers: s.boolean({ description: "Include chat members. Defaults to false." }),
      includeLastMessagePreview: s.boolean({
        description: "Include each chat's latest message preview. Defaults to false.",
      }),
      nextLink,
    }),
    collectionOutput("chats", chat, "Chats returned by Microsoft Teams."),
  ),
  action(
    "list_chat_messages",
    "List messages in an existing Microsoft Teams chat.",
    [microsoftTeamsProviderScopes.chatRead],
    input(
      {
        chatId,
        top: s.integer({ minimum: 1, maximum: 50, description: "Maximum messages to return per page." }),
        orderBy: s.stringEnum(["lastModifiedDateTime desc", "createdDateTime desc"], {
          description: "Message ordering supported by Microsoft Graph.",
        }),
        filter: s.string({
          description: "Optional date-range OData filter matching the selected orderBy field.",
        }),
        nextLink,
      },
      ["chatId"],
    ),
    collectionOutput("messages", chatMessage, "Chat messages returned by Microsoft Teams."),
  ),
  action(
    "send_chat_message",
    "Send a message to an existing Microsoft Teams one-to-one, group, or meeting chat.",
    [microsoftTeamsProviderScopes.chatMessageSend],
    input(
      {
        chatId,
        content: nonEmptyString("Message body content."),
        contentType,
        importance,
      },
      ["chatId", "content"],
    ),
    chatMessage,
  ),
];

export const microsoftTeamsActions: ActionDefinition[] = actions.map((item) => defineProviderAction(service, item));

function action(
  name: string,
  description: string,
  scopes: string[],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): MicrosoftTeamsActionSource {
  return {
    name,
    description,
    requiredScopes: scopes,
    providerPermissions: scopes,
    inputSchema,
    outputSchema,
  };
}
