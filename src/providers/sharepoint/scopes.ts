export const sharePointProviderScopes = {
  userRead: "User.Read",
  sitesReadAll: "Sites.Read.All",
  sitesReadWriteAll: "Sites.ReadWrite.All",
  offlineAccess: "offline_access",
} as const;

export const sharePointReadScopes: string[] = [sharePointProviderScopes.sitesReadAll];
export const sharePointWriteScopes: string[] = [sharePointProviderScopes.sitesReadWriteAll];
export const sharePointOAuthScopes: string[] = [
  sharePointProviderScopes.userRead,
  sharePointProviderScopes.sitesReadWriteAll,
  sharePointProviderScopes.offlineAccess,
];
