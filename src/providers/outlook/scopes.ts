export const outlookProviderScopes = {
  userRead: "User.Read",
  mailReadWrite: "Mail.ReadWrite",
  mailSend: "Mail.Send",
  mailReadWriteShared: "Mail.ReadWrite.Shared",
  mailSendShared: "Mail.Send.Shared",
  mailboxSettingsReadWrite: "MailboxSettings.ReadWrite",
  mailRead: "Mail.Read",
  mailReadBasic: "Mail.ReadBasic",
  mailboxSettingsRead: "MailboxSettings.Read",
  offlineAccess: "offline_access",
} as const;

export const outlookReadScopes: string[] = [outlookProviderScopes.userRead, outlookProviderScopes.mailReadWrite];
export const outlookWriteScopes: string[] = [outlookProviderScopes.mailReadWrite];
export const outlookSendScopes: string[] = [outlookProviderScopes.mailSend];
export const outlookSettingsReadScopes: string[] = [outlookProviderScopes.mailboxSettingsReadWrite];
export const outlookSettingsWriteScopes: string[] = [outlookProviderScopes.mailboxSettingsReadWrite];
export const outlookOAuthScopes: string[] = [
  outlookProviderScopes.userRead,
  outlookProviderScopes.mailReadWrite,
  outlookProviderScopes.mailSend,
  outlookProviderScopes.mailboxSettingsReadWrite,
  outlookProviderScopes.mailReadWriteShared,
  outlookProviderScopes.mailSendShared,
  outlookProviderScopes.offlineAccess,
];
