export type InboxProvider = "microsoft_teams" | "outlook";
export type InboxConversationStatus = "open" | "waiting" | "resolved";
export type InboxPriority = "none" | "low" | "medium" | "high";

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
  kind: "message" | "note";
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
  status: InboxConversationStatus;
  priority: InboxPriority;
  labels: string[];
  noteCount: number;
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

export interface InboxLinkedTask {
  id: string;
  connectionId: string;
  taskListId: string;
  taskListName: string;
  title: string;
  status: string;
  importance: string;
  dueAt?: string;
  sourceUrl?: string;
}

export interface InboxLinkedTasks {
  available: boolean;
  tasks: InboxLinkedTask[];
  errors: string[];
}

export interface InboxReplyAttachment {
  fileId: string;
  name?: string;
}

export interface InboxPrivateNote {
  id: string;
  content: string;
  createdAt: string;
}

export interface InboxConversationMetadata {
  id: string;
  status: "open" | "resolved";
  priority: InboxPriority;
  labels: string[];
  notes: InboxPrivateNote[];
  updatedAt: string;
}

export interface IInboxStore {
  setConversation(metadata: InboxConversationMetadata): Promise<void>;
  getConversation(id: string): Promise<InboxConversationMetadata | undefined>;
  listConversations(limit?: number): Promise<InboxConversationMetadata[]>;
}
