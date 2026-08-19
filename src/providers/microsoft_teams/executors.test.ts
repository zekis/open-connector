import type { MicrosoftTeamsRuntimeDeps } from "./graph-client.ts";

import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { credentialValidators, microsoftTeamsActionHandlers } from "./executors.ts";

describe("Microsoft Teams executors", () => {
  it("lists channel messages with encoded IDs, replies, and normalized pagination", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        value: [{ id: "message-1", body: { contentType: "html", content: "Status update" } }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/teams/team%201/channels/19%3Achannel%40thread.tacv2/messages?$skiptoken=next",
      }),
    );

    await expect(
      microsoftTeamsActionHandlers.list_channel_messages!(
        {
          teamId: "team 1",
          channelId: "19:channel@thread.tacv2",
          top: 25,
          includeReplies: true,
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      messages: [{ id: "message-1", body: { contentType: "html", content: "Status update" } }],
      nextLink:
        "https://graph.microsoft.com/v1.0/teams/team%201/channels/19%3Achannel%40thread.tacv2/messages?$skiptoken=next",
    });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/teams/team%201/channels/19%3Achannel%40thread.tacv2/messages");
    expect(url.searchParams.get("$top")).toBe("25");
    expect(url.searchParams.get("$expand")).toBe("replies");
  });

  it("sends channel messages and replies using Microsoft Graph message bodies", async () => {
    const fetcher = createFetch(async (request) => {
      const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
      return Response.json({ id: path.endsWith("/replies") ? "reply-1" : "message-1" }, { status: 201 });
    });
    const deps = createDeps(fetcher);

    await expect(
      microsoftTeamsActionHandlers.send_channel_message!(
        {
          teamId: "team 1",
          channelId: "channel 1",
          content: "<strong>Deployment complete</strong>",
          contentType: "html",
          subject: "Release update",
          importance: "high",
        },
        deps,
      ),
    ).resolves.toEqual({ id: "message-1" });
    await expect(
      microsoftTeamsActionHandlers.reply_to_channel_message!(
        {
          teamId: "team 1",
          channelId: "channel 1",
          messageId: "message 1",
          content: "Thanks — acknowledged.",
        },
        deps,
      ),
    ).resolves.toEqual({ id: "reply-1" });

    const [messageRequest, messageInit] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(messageRequest instanceof Request ? messageRequest.url : messageRequest.toString()).pathname).toBe(
      "/v1.0/teams/team%201/channels/channel%201/messages",
    );
    expect(messageInit?.method).toBe("POST");
    expect(JSON.parse(String(messageInit?.body))).toEqual({
      body: { content: "<strong>Deployment complete</strong>", contentType: "html" },
      subject: "Release update",
      importance: "high",
    });

    const [replyRequest, replyInit] = vi.mocked(fetcher).mock.calls[1]!;
    expect(new URL(replyRequest instanceof Request ? replyRequest.url : replyRequest.toString()).pathname).toBe(
      "/v1.0/teams/team%201/channels/channel%201/messages/message%201/replies",
    );
    expect(JSON.parse(String(replyInit?.body))).toEqual({
      body: { content: "Thanks — acknowledged.", contentType: "text" },
    });
  });

  it("lists chats with supported expansion, ordering, and pagination options", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [{ id: "chat-1", chatType: "group" }] }));

    await expect(
      microsoftTeamsActionHandlers.list_chats!(
        {
          top: 50,
          filter: "chatType eq 'group'",
          orderByLastMessage: true,
          includeMembers: true,
          includeLastMessagePreview: true,
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ chats: [{ id: "chat-1", chatType: "group" }], nextLink: null });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/chats");
    expect(url.searchParams.get("$top")).toBe("50");
    expect(url.searchParams.get("$filter")).toBe("chatType eq 'group'");
    expect(url.searchParams.get("$orderby")).toBe("lastMessagePreview/createdDateTime desc");
    expect(url.searchParams.get("$expand")).toBe("members,lastMessagePreview");
  });

  it("sends a message to an existing chat", async () => {
    const fetcher = createFetch(async () => Response.json({ id: "message-1" }, { status: 201 }));

    await expect(
      microsoftTeamsActionHandlers.send_chat_message!(
        {
          chatId: "19:chat@thread.v2",
          content: "Can you review this?",
          importance: "urgent",
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ id: "message-1" });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(request instanceof Request ? request.url : request.toString()).pathname).toBe(
      "/v1.0/chats/19%3Achat%40thread.v2/messages",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      body: { content: "Can you review this?", contentType: "text" },
      importance: "urgent",
    });
  });

  it("rejects pagination URLs outside the expected Teams endpoint", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));

    await expect(
      microsoftTeamsActionHandlers.list_chat_messages!(
        {
          chatId: "chat-1",
          nextLink: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=secret",
        },
        createDeps(fetcher),
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ProviderRequestError>>({ status: 400 }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the connected Microsoft work account as the credential profile", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        id: "user-1",
        displayName: "Zeke Tierney",
        mail: "zeke@example.com",
        userPrincipalName: "zeke@example.com",
      }),
    );

    await expect(
      credentialValidators.oauth2!(
        {
          authType: "oauth2",
          accessToken: "access-token",
          tokenType: "Bearer",
          profile: { accountId: "pending", displayName: "pending", grantedScopes: [] },
          metadata: {},
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({
      profile: { accountId: "user-1", displayName: "zeke@example.com" },
    });
  });
});

function createDeps(fetcher: typeof fetch): MicrosoftTeamsRuntimeDeps {
  return {
    accessToken: "access-token",
    tokenType: "Bearer",
    fetcher,
  };
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
