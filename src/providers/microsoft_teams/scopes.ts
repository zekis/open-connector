export const microsoftTeamsProviderScopes = {
  userRead: "User.Read",
  teamReadBasicAll: "Team.ReadBasic.All",
  channelReadBasicAll: "Channel.ReadBasic.All",
  channelMessageReadAll: "ChannelMessage.Read.All",
  channelMessageSend: "ChannelMessage.Send",
  chatRead: "Chat.Read",
  chatMessageSend: "ChatMessage.Send",
  offlineAccess: "offline_access",
} as const;

export const microsoftTeamsOAuthScopes: string[] = [
  microsoftTeamsProviderScopes.userRead,
  microsoftTeamsProviderScopes.teamReadBasicAll,
  microsoftTeamsProviderScopes.channelReadBasicAll,
  microsoftTeamsProviderScopes.channelMessageReadAll,
  microsoftTeamsProviderScopes.channelMessageSend,
  microsoftTeamsProviderScopes.chatRead,
  microsoftTeamsProviderScopes.chatMessageSend,
  microsoftTeamsProviderScopes.offlineAccess,
];
