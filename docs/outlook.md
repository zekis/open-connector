# Outlook shared mailbox connections

## Add a separate connection

1. Open **Providers > Outlook > Add connection**.
2. Give it a name such as `support`.
3. Enter `support@example.com` in **Shared mailbox address**.
4. Select **Connect Outlook** and sign in as your own Microsoft 365 user who has
   access to the shared mailbox. Do not sign in as the shared mailbox.

The connection list displays the shared mailbox separately from your personal
connection. Select it in actions or Flows: mail actions automatically use its
saved mailbox, including polling and attachment follow-ups. Leave the address
blank when adding your personal connection.

Setup verifies access to the shared inbox before saving. Shared connections cannot
override their mailbox in action input. `get_profile` identifies the saved mailbox;
mailbox settings actions are available only on personal connections.

## Permissions

Add delegated Microsoft Graph permissions `Mail.ReadWrite.Shared` and
`Mail.Send.Shared` to your Microsoft Entra OAuth application. Reconnect and consent
to the new scopes; existing tokens do not automatically gain these permissions.

An Exchange administrator must grant the signed-in user mailbox access. Sending
through the shared mailbox requires **Full Access** plus **Send As** or
**Send on Behalf**. OAuth consent does not grant Exchange mailbox access. Shared
mailboxes require Microsoft 365 work or school accounts.

## Mail actions

Shared connections support listing folders and messages, reading messages,
attachments, drafts, replies, marking messages read or unread, deletion, and sending.
New messages and drafts use the selected mailbox as `from`. Sent mail is saved in
that mailbox's Sent Items by default; `saveToSentItems` and Exchange administrator
settings can affect this behavior.

Existing personal connections also accept an optional `mailbox` action input:

```json
{
  "mailbox": "support@example.com",
  "mailFolderId": "inbox",
  "top": 25
}
```

Use the mailbox's principal email address, not an alias. For action-level selection,
pass the same mailbox with message IDs and returned `nextLink` pagination URLs.
For saved shared connections, only the `nextLink` is needed. Keep that URL unchanged.
Pagination must target the selected mailbox and the relevant collection.

The catalog's baseline action scopes describe personal mailbox access. Shared
reading and editing require `Mail.ReadWrite.Shared`; sending requires
`Mail.Send.Shared`. Both are included in Outlook's OAuth request.

Microsoft Graph does not provide automatic discovery of accessible shared
mailboxes; enter the address explicitly.

See Microsoft's [shared folder documentation](https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders)
and [sending from another user](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user).
