export const outlookCalendarProviderScopes = {
  userRead: "User.Read",
  calendarsReadWrite: "Calendars.ReadWrite",
  offlineAccess: "offline_access",
} as const;

export const outlookCalendarReadScopes: string[] = [outlookCalendarProviderScopes.calendarsReadWrite];
export const outlookCalendarWriteScopes: string[] = [outlookCalendarProviderScopes.calendarsReadWrite];
export const outlookCalendarOAuthScopes: string[] = [
  outlookCalendarProviderScopes.userRead,
  outlookCalendarProviderScopes.calendarsReadWrite,
  outlookCalendarProviderScopes.offlineAccess,
];
