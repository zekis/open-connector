import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import {
  outlookProviderScopes,
  outlookReadScopes,
  outlookSendScopes,
  outlookSettingsReadScopes,
  outlookSettingsWriteScopes,
  outlookWriteScopes,
} from "./scopes.ts";

const service = "outlook";

interface OutlookActionSource {
  name: string;
  description: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  followUpActions?: string[];
}

const rawObject = s.record(true, { description: "A generic JSON object returned by Microsoft Graph." });
const nonEmptyString = (description: string): JsonSchema => s.string({ minLength: 1, description });
const stringArray = (description: string): JsonSchema =>
  s.array(nonEmptyString("A string value."), { minItems: 1, description });
const recipient = s.anyOf(
  [
    nonEmptyString("Recipient email address."),
    s.object(
      {
        address: nonEmptyString("Recipient email address."),
        name: s.string({ description: "Recipient display name." }),
      },
      { required: ["address"], description: "Recipient object with optional display name." },
    ),
  ],
  { description: "Recipient email address or recipient object with display name." },
);
const recipientList = (description: string): JsonSchema => s.array(recipient, { description });
const bodyContentType = s.stringEnum(["text", "html"], {
  description: "Preferred Outlook body content type for the response.",
});
const importance = s.stringEnum(["low", "normal", "high"], { description: "Message importance." });
const messageId = nonEmptyString("Outlook message ID.");
const mailFolderId = nonEmptyString("Outlook mail folder ID.");
const nextLink = s.url("Opaque pagination URL returned by a previous Outlook response.");
const outlookUser = s.looseObject(
  {
    id: nonEmptyString("Unique identifier for the current account."),
    displayName: s.string({ description: "Display name of the current account." }),
    mail: s.nullableString("Primary SMTP address for the current account."),
    userPrincipalName: s.string({ description: "User principal name for the current account." }),
  },
  { description: "Current Outlook account profile." },
);
const outlookMessage = s.looseObject(
  {
    id: nonEmptyString("Message ID."),
    subject: s.string({ description: "Message subject." }),
    bodyPreview: s.string({ description: "Preview snippet of the message body." }),
    importance: s.string({ description: "Message importance." }),
    isRead: s.boolean({ description: "Whether the message is marked as read." }),
    isDraft: s.boolean({ description: "Whether the message is a draft." }),
    webLink: s.string({ description: "Web URL for the message in Outlook." }),
    body: rawObject,
    sender: rawObject,
    from: rawObject,
    toRecipients: s.array(rawObject, { description: "Primary recipients." }),
    ccRecipients: s.array(rawObject, { description: "Cc recipients." }),
    bccRecipients: s.array(rawObject, { description: "Bcc recipients." }),
    replyTo: s.array(rawObject, { description: "Reply-to recipients." }),
    flag: rawObject,
  },
  { description: "Outlook message resource." },
);
const outlookAttachment = s.looseObject(
  {
    id: nonEmptyString("Attachment ID."),
    name: s.string({ description: "Attachment file name." }),
    contentType: s.string({ description: "Attachment MIME type." }),
    size: s.integer({ minimum: 0, description: "Attachment size in bytes." }),
    isInline: s.boolean({ description: "Whether the attachment is embedded in the message body." }),
    contentId: s.nullableString("Content ID used by inline message markup."),
    sourceUrl: s.string({ description: "Provider URL for a cloud reference attachment." }),
    lastModifiedDateTime: s.string({ description: "Attachment last-modified timestamp." }),
  },
  { description: "Outlook message attachment metadata without file content." },
);
const listAttachmentsOutput = s.object(
  {
    attachments: s.array(outlookAttachment, { description: "Attachments on the Outlook message." }),
  },
  { required: ["attachments"], description: "Outlook message attachment list response." },
);
const downloadedAttachment = s.object(
  {
    name: nonEmptyString("Downloaded attachment name."),
    mimeType: nonEmptyString("Downloaded attachment MIME type."),
    sizeBytes: s.integer({ minimum: 0, description: "Downloaded attachment size in bytes." }),
    file: s.nullable(
      s.looseObject(
        {
          fileId: nonEmptyString("Local transit file ID."),
          downloadUrl: nonEmptyString("Local transit file download URL."),
          name: nonEmptyString("Transit file name."),
          mimeType: nonEmptyString("Transit file MIME type."),
          sizeBytes: s.integer({ minimum: 0, description: "Transit file size in bytes." }),
        },
        { description: "Local transit file reference when transit storage is enabled." },
      ),
    ),
    contentBase64: s.nullableString("Base64 content returned only when local transit storage is unavailable."),
  },
  {
    required: ["name", "mimeType", "sizeBytes", "file", "contentBase64"],
    description: "Downloaded Outlook attachment.",
  },
);
const mailFolder = s.looseObject(
  {
    id: nonEmptyString("Mail folder ID."),
    displayName: nonEmptyString("Display name for the mail folder."),
    parentFolderId: s.string({ description: "Parent mail folder ID." }),
    childFolderCount: s.integer({ description: "Number of child folders." }),
    unreadItemCount: s.integer({ description: "Unread item count." }),
    totalItemCount: s.integer({ description: "Total item count." }),
    isHidden: s.boolean({ description: "Whether the folder is hidden." }),
  },
  { description: "Outlook mail folder resource." },
);
const mailboxSettings = s.looseObject(
  {
    automaticRepliesSetting: rawObject,
    timeZone: s.string({ description: "Preferred mailbox time zone." }),
    language: rawObject,
    workingHours: rawObject,
    userPurpose: rawObject,
    dateFormat: s.string({ description: "Preferred date format." }),
    timeFormat: s.string({ description: "Preferred time format." }),
    delegateMeetingMessageDeliveryOptions: s.string({ description: "Delegate meeting-message delivery behavior." }),
  },
  { description: "Mailbox settings for the current Outlook account." },
);
const success = s.object(
  {
    success: s.literal(true, { description: "Whether the Outlook operation completed successfully." }),
  },
  { required: ["success"], description: "Successful Outlook mutation acknowledgement." },
);

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Outlook action input.");
}

const messageWriteFields = {
  subject: s.string({ description: "Subject line for the message." }),
  body: s.string({ description: "Body content for the message." }),
  isHtml: s.boolean({ description: "Whether the message body is already HTML content." }),
  toRecipients: recipientList("Primary recipients for the message."),
  ccRecipients: recipientList("Cc recipients for the message."),
  bccRecipients: recipientList("Bcc recipients for the message."),
  replyTo: recipientList("Reply-to recipients for the message."),
  importance,
  categories: stringArray("Categories for the message."),
};
const listMessagesOutput = s.object(
  {
    messages: s.array(outlookMessage, { description: "Messages returned by Outlook." }),
    nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
  },
  { required: ["messages", "nextLink"], description: "Outlook message list response." },
);
const listFoldersOutput = s.object(
  {
    mailFolders: s.array(mailFolder, { description: "Root-level mail folders returned by Outlook." }),
    nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
  },
  { required: ["mailFolders", "nextLink"], description: "Outlook mail folder list response." },
);
const actions: OutlookActionSource[] = [
  action(
    "get_profile",
    "Get the current Outlook account profile from Microsoft Graph so you can identify the connected mailbox.",
    outlookReadScopes,
    [outlookProviderScopes.userRead],
    input({}),
    outlookUser,
  ),
  action(
    "list_mail_folders",
    "List the root-level Outlook mail folders for the connected mailbox, with optional hidden folders and field selection.",
    outlookReadScopes,
    [outlookProviderScopes.mailReadWrite],
    input({
      nextLink,
      includeHiddenFolders: s.boolean({ description: "Whether to include hidden mail folders." }),
      top: s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of mail folders to return." }),
      select: stringArray("Mail folder fields to request from Microsoft Graph."),
    }),
    listFoldersOutput,
  ),
  action(
    "list_messages",
    "List Outlook messages from the mailbox or from a specific mail folder, with support for OData filters, sorting, field selection, and pagination.",
    outlookReadScopes,
    [outlookProviderScopes.mailReadWrite],
    input({
      mailFolderId,
      top: s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of messages to return." }),
      filter: s.string({ description: "OData filter expression for the messages query." }),
      orderby: s.string({ description: "OData orderby expression for the messages query." }),
      select: stringArray("Message fields to request from Microsoft Graph."),
      nextLink,
      bodyContentType,
    }),
    listMessagesOutput,
  ),
  action(
    "get_message",
    "Get a single Outlook message by message ID, including message metadata and optional body formatting.",
    outlookReadScopes,
    [outlookProviderScopes.mailReadWrite],
    input({ messageId, select: stringArray("Message fields to request from Microsoft Graph."), bodyContentType }, [
      "messageId",
    ]),
    outlookMessage,
  ),
  action(
    "list_attachments",
    "List attachment metadata for an Outlook message without downloading attachment content.",
    outlookReadScopes,
    [outlookProviderScopes.mailReadWrite],
    input({ messageId }, ["messageId"]),
    listAttachmentsOutput,
  ),
  action(
    "download_attachment",
    "Download the raw content of one Outlook message attachment.",
    outlookReadScopes,
    [outlookProviderScopes.mailReadWrite],
    input({ messageId, attachmentId: nonEmptyString("Outlook attachment ID.") }, ["messageId", "attachmentId"]),
    downloadedAttachment,
  ),
  action(
    "create_draft",
    "Create a new Outlook draft message with subject, body, recipients, and other writable message properties.",
    outlookWriteScopes,
    [outlookProviderScopes.mailReadWrite],
    input(messageWriteFields, ["subject", "body"]),
    outlookMessage,
  ),
  action(
    "create_reply_draft",
    "Create an editable Outlook reply draft for an existing message without sending it, optionally adding reply content and recipients.",
    outlookWriteScopes,
    [outlookProviderScopes.mailReadWrite],
    input(
      {
        messageId,
        comment: s.string({
          description: "Comment to prepend to the reply. Do not provide body when using comment.",
        }),
        body: s.string({
          description: "Replacement reply body content. Do not provide comment when using body.",
        }),
        isHtml: s.boolean({ description: "Whether the replacement reply body is already HTML content." }),
        toRecipients: recipientList("Additional primary recipients for the reply draft."),
        ccRecipients: recipientList("Additional Cc recipients for the reply draft."),
        bccRecipients: recipientList("Additional Bcc recipients for the reply draft."),
      },
      ["messageId"],
    ),
    outlookMessage,
    ["outlook.update_draft", "outlook.send_draft"],
  ),
  action(
    "update_draft",
    "Update an existing Outlook draft message before sending.",
    outlookWriteScopes,
    [outlookProviderScopes.mailReadWrite],
    input({ messageId, ...messageWriteFields }, ["messageId"]),
    outlookMessage,
  ),
  action(
    "send_draft",
    "Send an existing Outlook draft message by message ID.",
    outlookSendScopes,
    [outlookProviderScopes.mailSend],
    input({ messageId }, ["messageId"]),
    success,
  ),
  action(
    "send_email",
    "Send a new Outlook email in a single operation, without creating a standalone draft first.",
    outlookSendScopes,
    [outlookProviderScopes.mailSend],
    input(
      {
        ...messageWriteFields,
        saveToSentItems: s.boolean({ description: "Whether to save the sent message in Sent Items." }),
      },
      ["subject", "body"],
    ),
    success,
  ),
  action(
    "reply_email",
    "Reply to an existing Outlook message with either a comment or a replacement body, and optionally add more recipients to the reply.",
    outlookSendScopes,
    [outlookProviderScopes.mailSend],
    input(
      {
        messageId,
        comment: s.string({ description: "Comment to include with the reply." }),
        body: s.string({ description: "Reply body content." }),
        isHtml: s.boolean({ description: "Whether the reply body is already HTML content." }),
        toRecipients: recipientList("Additional primary recipients for the reply."),
        ccRecipients: recipientList("Additional Cc recipients for the reply."),
        bccRecipients: recipientList("Additional Bcc recipients for the reply."),
      },
      ["messageId"],
    ),
    success,
  ),
  action(
    "get_mailbox_settings",
    "Get the current Outlook mailbox settings, including automatic replies, locale, time zone, and working hours.",
    outlookSettingsReadScopes,
    [outlookProviderScopes.mailboxSettingsReadWrite],
    input({}),
    mailboxSettings,
  ),
  action(
    "update_mailbox_settings",
    "Update Outlook mailbox settings such as automatic replies, locale, time zone, working hours, and date or time formatting.",
    outlookSettingsWriteScopes,
    [outlookProviderScopes.mailboxSettingsReadWrite],
    input({
      automaticRepliesSetting: rawObject,
      dateFormat: s.string({ description: "Updated date format." }),
      delegateMeetingMessageDeliveryOptions: s.stringEnum(
        ["sendToDelegateAndInformationToPrincipal", "sendToDelegateAndPrincipal", "sendToDelegateOnly"],
        { description: "Updated delegate meeting-message delivery behavior." },
      ),
      language: rawObject,
      timeFormat: s.string({ description: "Updated time format." }),
      timeZone: s.string({ description: "Updated mailbox time zone." }),
      workingHours: rawObject,
    }),
    mailboxSettings,
  ),
];

export const outlookActions: ActionDefinition[] = actions.map((item) => defineProviderAction(service, item));

function action(
  name: string,
  description: string,
  requiredScopes: string[],
  providerPermissions: string[],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
  followUpActions?: string[],
): OutlookActionSource {
  return { name, description, requiredScopes, providerPermissions, inputSchema, outputSchema, followUpActions };
}
