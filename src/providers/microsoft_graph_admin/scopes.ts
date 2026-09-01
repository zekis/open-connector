export const microsoftGraphAdminProviderScopes = {
  userRead: "User.Read",
  userReadAll: "User.Read.All",
  userReadWriteAll: "User.ReadWrite.All",
  userEnableDisableAccountAll: "User.EnableDisableAccount.All",
  userPasswordProfileReadWriteAll: "User-PasswordProfile.ReadWrite.All",
  licenseAssignmentReadAll: "LicenseAssignment.Read.All",
  licenseAssignmentReadWriteAll: "LicenseAssignment.ReadWrite.All",
  offlineAccess: "offline_access",
} as const;

export const microsoftGraphAdminOAuthScopes: string[] = [
  microsoftGraphAdminProviderScopes.userRead,
  microsoftGraphAdminProviderScopes.userReadAll,
  microsoftGraphAdminProviderScopes.userReadWriteAll,
  microsoftGraphAdminProviderScopes.userEnableDisableAccountAll,
  microsoftGraphAdminProviderScopes.userPasswordProfileReadWriteAll,
  microsoftGraphAdminProviderScopes.licenseAssignmentReadAll,
  microsoftGraphAdminProviderScopes.licenseAssignmentReadWriteAll,
  microsoftGraphAdminProviderScopes.offlineAccess,
];
