import { describe, expect, it } from "vitest";
import {
  activeChatConversation,
  addChatConversation,
  clearChatHistory,
  createChatHistory,
  deleteChatConversation,
  parseStoredChatHistory,
  renameChatConversation,
  replaceChatConversationSession,
  selectChatConversation,
} from "./chat-history";

const initialTime = new Date("2026-08-20T08:00:00.000Z");
const laterTime = new Date("2026-08-20T08:05:00.000Z");

describe("chat history", () => {
  it("creates, titles, switches, renames, and deletes persistent conversations", () => {
    let history = createChatHistory(initialTime, "chat-1");
    history = replaceChatConversationSession(
      history,
      "chat-1",
      {
        messages: [
          {
            id: "message-1",
            role: "user",
            content: "Summarize all of today's important project updates and list the owners who need to respond",
            createdAt: initialTime.toISOString(),
          },
        ],
      },
      laterTime,
    );

    expect(activeChatConversation(history)).toMatchObject({
      id: "chat-1",
      title: "Summarize all of today's important project updates and list the…",
      updatedAt: laterTime.toISOString(),
    });

    history = addChatConversation(history, laterTime, "chat-2");
    expect(history.activeConversationId).toBe("chat-2");
    expect(history.conversations.map((conversation) => conversation.id)).toEqual(["chat-2", "chat-1"]);

    history = selectChatConversation(history, "chat-1");
    history = renameChatConversation(history, "chat-1", "  Project   pulse  ");
    expect(activeChatConversation(history).title).toBe("Project pulse");

    history = deleteChatConversation(history, "chat-1", laterTime, "replacement");
    expect(history.activeConversationId).toBe("chat-2");
    expect(history.conversations).toHaveLength(1);
  });

  it("migrates the previous single-session browser state", () => {
    const history = parseStoredChatHistory(
      null,
      JSON.stringify({
        messages: [
          {
            id: "user-message",
            role: "user",
            content: "Check the latest email",
            createdAt: "2026-08-20T07:00:00.000Z",
          },
          {
            id: "waiting-message",
            role: "assistant",
            content: "Waiting for approval.",
            createdAt: "2026-08-20T07:01:00.000Z",
          },
        ],
        pendingApproval: { approvalId: "approval-1", assistantMessageId: "waiting-message" },
      }),
      initialTime,
      "migrated-chat",
    );

    expect(history).toMatchObject({
      activeConversationId: "migrated-chat",
      conversations: [
        {
          id: "migrated-chat",
          title: "Check the latest email",
          pendingApproval: { approvalId: "approval-1", assistantMessageId: "waiting-message" },
        },
      ],
    });
  });

  it("recovers safely from corrupt history and always keeps one active chat", () => {
    const recovered = parseStoredChatHistory("not-json", null, initialTime, "fresh-chat");
    expect(recovered).toMatchObject({
      activeConversationId: "fresh-chat",
      conversations: [{ id: "fresh-chat", title: "New chat", messages: [] }],
    });

    const cleared = clearChatHistory(laterTime, "cleared-chat");
    expect(cleared).toMatchObject({
      activeConversationId: "cleared-chat",
      conversations: [{ id: "cleared-chat", messages: [] }],
    });
  });
});
