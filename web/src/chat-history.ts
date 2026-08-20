import type { AgentChatMessage, AgentChatToolActivity } from "./model";

export interface ChatDisplayMessage extends AgentChatMessage {
  id: string;
  createdAt: string;
  toolActivity?: AgentChatToolActivity[];
}

export interface PendingChatApproval {
  approvalId: string;
  assistantMessageId: string;
}

export interface ChatSession {
  messages: ChatDisplayMessage[];
  pendingApproval?: PendingChatApproval;
}

export interface ChatConversation extends ChatSession {
  id: string;
  title: string;
  customTitle: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatHistoryState {
  activeConversationId: string;
  conversations: ChatConversation[];
}

export const chatHistoryStorageKey = "open-connector.agent-chat-history.v2";
export const legacyChatSessionStorageKey = "open-connector.agent-chat-session.v1";

const defaultConversationTitle = "New chat";
const maximumConversations = 100;
const maximumTitleCharacters = 64;

export function createChatHistory(now: Date = new Date(), id: string = crypto.randomUUID()): ChatHistoryState {
  const conversation = createConversation(now, id);
  return { activeConversationId: conversation.id, conversations: [conversation] };
}

export function activeChatConversation(history: ChatHistoryState): ChatConversation {
  return (
    history.conversations.find((conversation) => conversation.id === history.activeConversationId) ??
    history.conversations[0]!
  );
}

export function addChatConversation(
  history: ChatHistoryState,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): ChatHistoryState {
  const active = activeChatConversation(history);
  if (active.messages.length === 0 && !active.pendingApproval) return history;
  const conversation = createConversation(now, id);
  return {
    activeConversationId: conversation.id,
    conversations: [conversation, ...history.conversations].slice(0, maximumConversations),
  };
}

export function selectChatConversation(history: ChatHistoryState, id: string): ChatHistoryState {
  if (id === history.activeConversationId || !history.conversations.some((conversation) => conversation.id === id)) {
    return history;
  }
  return { ...history, activeConversationId: id };
}

export function replaceChatConversationSession(
  history: ChatHistoryState,
  id: string,
  next: ChatSession | ((current: ChatSession) => ChatSession),
  now: Date = new Date(),
): ChatHistoryState {
  const index = history.conversations.findIndex((conversation) => conversation.id === id);
  if (index < 0) return history;
  const current = history.conversations[index]!;
  const currentSession: ChatSession = { messages: current.messages, pendingApproval: current.pendingApproval };
  const updatedSession = typeof next === "function" ? next(currentSession) : next;
  if (updatedSession === currentSession) return history;
  const updated: ChatConversation = {
    ...current,
    messages: updatedSession.messages,
    pendingApproval: updatedSession.pendingApproval,
    title: current.customTitle ? current.title : deriveConversationTitle(updatedSession.messages),
    updatedAt: now.toISOString(),
  };
  return {
    activeConversationId: history.activeConversationId,
    conversations: [updated, ...history.conversations.filter((conversation) => conversation.id !== id)],
  };
}

export function renameChatConversation(history: ChatHistoryState, id: string, title: string): ChatHistoryState {
  const normalized = normalizeTitle(title);
  if (!normalized) return history;
  let changed = false;
  const conversations = history.conversations.map((conversation) => {
    if (conversation.id !== id || conversation.title === normalized) return conversation;
    changed = true;
    return { ...conversation, title: normalized, customTitle: true };
  });
  return changed ? { ...history, conversations } : history;
}

export function deleteChatConversation(
  history: ChatHistoryState,
  id: string,
  now: Date = new Date(),
  replacementId: string = crypto.randomUUID(),
): ChatHistoryState {
  const conversations = history.conversations.filter((conversation) => conversation.id !== id);
  if (conversations.length === history.conversations.length) return history;
  if (conversations.length === 0) return createChatHistory(now, replacementId);
  return {
    activeConversationId: history.activeConversationId === id ? conversations[0]!.id : history.activeConversationId,
    conversations,
  };
}

export function clearChatHistory(
  now: Date = new Date(),
  replacementId: string = crypto.randomUUID(),
): ChatHistoryState {
  return createChatHistory(now, replacementId);
}

export function parseStoredChatHistory(
  raw: string | null,
  legacyRaw: string | null = null,
  now: Date = new Date(),
  id: string = crypto.randomUUID(),
): ChatHistoryState {
  const parsed = parseJson(raw);
  if (isRecord(parsed) && Array.isArray(parsed.conversations)) {
    const ids = new Set<string>();
    const conversations = parsed.conversations
      .filter(isChatConversation)
      .filter((conversation) => {
        if (ids.has(conversation.id)) return false;
        ids.add(conversation.id);
        return true;
      })
      .slice(0, maximumConversations);
    if (conversations.length > 0) {
      const conversationIds = new Set(conversations.map((conversation) => conversation.id));
      const activeConversationId =
        typeof parsed.activeConversationId === "string" && conversationIds.has(parsed.activeConversationId)
          ? parsed.activeConversationId
          : conversations[0]!.id;
      return { activeConversationId, conversations };
    }
  }

  const legacy = parseJson(legacyRaw);
  if (isRecord(legacy) && Array.isArray(legacy.messages)) {
    const messages = legacy.messages.filter(isChatDisplayMessage);
    const pendingApproval = validPendingApproval(legacy.pendingApproval, messages);
    if (messages.length > 0 || pendingApproval) {
      const createdAt = messages[0]?.createdAt ?? now.toISOString();
      const updatedAt = messages.at(-1)?.createdAt ?? createdAt;
      return {
        activeConversationId: id,
        conversations: [
          {
            id,
            title: deriveConversationTitle(messages),
            customTitle: false,
            createdAt,
            updatedAt,
            messages,
            pendingApproval,
          },
        ],
      };
    }
  }

  return createChatHistory(now, id);
}

export function readStoredChatHistory(): ChatHistoryState {
  if (typeof window === "undefined") return createChatHistory();
  try {
    return parseStoredChatHistory(
      window.localStorage.getItem(chatHistoryStorageKey),
      window.sessionStorage.getItem(legacyChatSessionStorageKey),
    );
  } catch {
    return createChatHistory();
  }
}

export function storeChatHistory(history: ChatHistoryState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(chatHistoryStorageKey, JSON.stringify(history));
  } catch {
    // Chat remains usable when browser storage is disabled or full.
  }
}

function createConversation(now: Date, id: string): ChatConversation {
  const timestamp = now.toISOString();
  return {
    id,
    title: defaultConversationTitle,
    customTitle: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  };
}

function deriveConversationTitle(messages: ChatDisplayMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content;
  return normalizeTitle(firstUserMessage ?? "") || defaultConversationTitle;
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximumTitleCharacters) return normalized;
  return `${normalized.slice(0, maximumTitleCharacters - 1).trimEnd()}…`;
}

function isChatConversation(value: unknown): value is ChatConversation {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  const messages = value.messages.filter(isChatDisplayMessage);
  if (messages.length !== value.messages.length) return false;
  const pendingApproval = validPendingApproval(value.pendingApproval, messages);
  if (value.pendingApproval !== undefined && !pendingApproval) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.customTitle === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function validPendingApproval(value: unknown, messages: ChatDisplayMessage[]): PendingChatApproval | undefined {
  if (!isPendingChatApproval(value)) return undefined;
  return messages.some((message) => message.id === value.assistantMessageId) ? value : undefined;
}

function isChatDisplayMessage(value: unknown): value is ChatDisplayMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" &&
    (value.toolActivity === undefined || Array.isArray(value.toolActivity))
  );
}

function isPendingChatApproval(value: unknown): value is PendingChatApproval {
  return isRecord(value) && typeof value.approvalId === "string" && typeof value.assistantMessageId === "string";
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
