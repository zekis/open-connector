export const azureDevOpsDelegatedScope = "https://app.vssps.visualstudio.com/.default";

export const azureDevOpsOAuthScopes: string[] = [azureDevOpsDelegatedScope, "offline_access"];

export const azureDevOpsPermissions = {
  profileRead: "vso.profile",
  projectRead: "vso.project",
  codeRead: "vso.code",
  codeWrite: "vso.code_write",
  workRead: "vso.work",
  workWrite: "vso.work_write",
};
