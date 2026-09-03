export type InboxProvider = "microsoft_teams" | "outlook";

export interface InboxSource {
  id: string;
  provider: InboxProvider;
  displayName: string;
  accountLabel: string;
  connectionId: string;
  enabled: boolean;
}

export interface InboxParticipant {
  name: string;
  email?: string;
}

export interface InboxAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl?: string;
  error?: string;
}

export interface InboxMessage {
  id: string;
  direction: "inbound" | "outbound";
  sender: InboxParticipant;
  content: string;
  createdAt: string;
  attachments: InboxAttachment[];
}

export interface InboxConversationSummary {
  id: string;
  sourceId: string;
  provider: InboxProvider;
  title: string;
  preview: string;
  participants: InboxParticipant[];
  updatedAt: string;
  unread: boolean;
  status: "open" | "waiting";
  messageCount: number;
  contextLabel?: string;
}

export interface InboxConversation extends InboxConversationSummary {
  messages: InboxMessage[];
}

export interface InboxSourceError {
  sourceId: string;
  message: string;
}

export interface InboxPage {
  sources: InboxSource[];
  conversations: InboxConversationSummary[];
  errors: InboxSourceError[];
}

export interface InboxReplyAttachment {
  fileId: string;
  name?: string;
}
