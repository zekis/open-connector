export const microsoftTodoProviderScopes = {
  userRead: "User.Read",
  tasksReadWrite: "Tasks.ReadWrite",
  offlineAccess: "offline_access",
} as const;

export const microsoftTodoTaskScopes: string[] = [microsoftTodoProviderScopes.tasksReadWrite];
export const microsoftTodoOAuthScopes: string[] = [
  microsoftTodoProviderScopes.userRead,
  microsoftTodoProviderScopes.tasksReadWrite,
  microsoftTodoProviderScopes.offlineAccess,
];
