import type { TeamsGatewayGraphContext } from "./teams-gateway-graph.ts";

import { describe, expect, it } from "vitest";
import { TeamsGatewayGraphClient } from "./teams-gateway-graph.ts";

describe("TeamsGatewayGraphClient presence", () => {
  it("addresses presence sessions through the current user ID", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const client = createClient();
    const context = createContext(async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(null, { status: 200 });
    });

    await client.setPresence(context);
    await client.clearPresence(context);

    expect(requests).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/users/agent-user-id/presence/setPresence",
        body: {
          sessionId: "teams-app-id",
          availability: "Available",
          activity: "Available",
          expirationDuration: "PT4H",
        },
      },
      {
        url: "https://graph.microsoft.com/v1.0/users/agent-user-id/presence/clearPresence",
        body: { sessionId: "teams-app-id" },
      },
    ]);
  });

  it("turns a forbidden presence response into setup guidance", async () => {
    const client = createClient();
    const context = createContext(
      async () =>
        new Response(JSON.stringify({ error: { code: "Forbidden", message: "" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(client.setPresence(context)).rejects.toThrow("Reconnect this account with Presence.ReadWrite");
  });
});

describe("TeamsGatewayGraphClient subscriptions", () => {
  it("creates, renews, and deletes change notification subscriptions", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createClient();
    const context = createContext(async (input, init) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url: String(input), method, body });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({
        id: "subscription-1",
        resource: "/users/agent-user-id/chats/getAllMessages",
        expirationDateTime: body.expirationDateTime,
      });
    });
    const expiresAt = "2026-09-01T02:55:00.000Z";

    await client.createSubscription(context, {
      changeType: "created",
      notificationUrl: "https://connect.example.test/api/teams-gateway/webhook",
      resource: "/users/agent-user-id/chats/getAllMessages",
      clientState: "secret-state",
      expiresAt,
    });
    await client.renewSubscription(context, "subscription-1", expiresAt);
    await client.deleteSubscription(context, "subscription-1");

    expect(requests).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/subscriptions",
        method: "POST",
        body: {
          changeType: "created",
          notificationUrl: "https://connect.example.test/api/teams-gateway/webhook",
          resource: "/users/agent-user-id/chats/getAllMessages",
          clientState: "secret-state",
          expirationDateTime: expiresAt,
        },
      },
      {
        url: "https://graph.microsoft.com/v1.0/subscriptions/subscription-1",
        method: "PATCH",
        body: { expirationDateTime: expiresAt },
      },
      {
        url: "https://graph.microsoft.com/v1.0/subscriptions/subscription-1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });
});

describe("TeamsGatewayGraphClient reactions", () => {
  it("reads reactions from chat messages and channel replies", async () => {
    const requests: string[] = [];
    const client = createClient();
    const context = createContext(async (input) => {
      requests.push(String(input));
      return Response.json({
        reactions: [
          {
            reactionType: "like",
            user: { user: { id: "person-user-id" } },
          },
          { reactionType: "heart", user: { user: {} } },
        ],
      });
    });

    await expect(client.getChatMessageReactions(context, "chat 1", "message/1")).resolves.toEqual([
      { reactionType: "like", userId: "person-user-id" },
    ]);
    await expect(client.getChannelReplyReactions(context, "team 1", "channel/1", "root 1", "reply/1")).resolves.toEqual(
      [{ reactionType: "like", userId: "person-user-id" }],
    );

    expect(requests).toEqual([
      "https://graph.microsoft.com/v1.0/chats/chat%201/messages/message%2F1",
      "https://graph.microsoft.com/v1.0/teams/team%201/channels/channel%2F1/messages/root%201/replies/reply%2F1",
    ]);
  });

  it("sets thumbs-up reactions on chat messages and channel replies", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createClient();
    const context = createContext(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(null, { status: 204 });
    });

    await client.setChatMessageReaction(context, "chat 1", "message/1", "👍");
    await client.setChannelMessageReaction(context, "team 1", "channel/1", "root 1", "reply/1", "👍");

    expect(requests).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/chats/chat%201/messages/message%2F1/setReaction",
        method: "POST",
        body: { reactionType: "👍" },
      },
      {
        url: "https://graph.microsoft.com/v1.0/teams/team%201/channels/channel%2F1/messages/root%201/replies/reply%2F1/setReaction",
        method: "POST",
        body: { reactionType: "👍" },
      },
    ]);
  });
});

describe("TeamsGatewayGraphClient messages", () => {
  it("sends agent Markdown as structured Teams HTML in chats and channel threads", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const client = createClient();
    const context = createContext(async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(init?.body as string) });
      return Response.json({ id: `sent-${requests.length}` });
    });
    const message = "**Blocked**\n\n1. Retry shortly\n2. Escalate to Zeke";

    await client.sendMessage(context, "chat-1", message);
    await client.sendChannelReply(context, "team-1", "channel-1", "root-1", message);

    expect(requests).toMatchObject([
      {
        url: "https://graph.microsoft.com/v1.0/chats/chat-1/messages",
        body: {
          body: {
            contentType: "html",
            content: "<p><strong>Blocked</strong></p><ol><li>Retry shortly</li><li>Escalate to Zeke</li></ol>",
          },
        },
      },
      {
        url: "https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/root-1/replies",
        body: { body: { contentType: "html" } },
      },
    ]);
  });
});

describe("TeamsGatewayGraphClient attachments", () => {
  it("discovers SharePoint references and inline hosted images", async () => {
    const client = createClient();
    const context = createContext(async () =>
      Response.json({
        value: [
          {
            id: "message-1",
            messageType: "message",
            createdDateTime: "2026-09-01T01:00:00.000Z",
            from: { user: { id: "person-1", displayName: "Person" } },
            body: {
              contentType: "html",
              content:
                '<p>Please&#x20;review these.</p><img src="https://graph.microsoft.com/v1.0/chats/chat-1/messages/message-1/hostedContents/image-1/$value">',
            },
            attachments: [
              {
                id: "reference-1",
                contentType: "reference",
                contentUrl: "https://tenant.sharepoint.com/sites/Team/Shared%20Documents/report.pdf",
                name: "report.pdf",
              },
            ],
          },
        ],
      }),
    );

    await expect(client.listMessages(context, "chat-1", "2026-09-01T00:00:00.000Z")).resolves.toMatchObject([
      {
        id: "message-1",
        text: "Please review these.",
        attachments: [
          { id: "reference-1", kind: "reference", name: "report.pdf" },
          { id: "hosted-1", kind: "hosted", name: "image-1" },
        ],
      },
    ]);
  });

  it("downloads SharePoint references through the Graph shares API", async () => {
    const requests: string[] = [];
    const client = createClient();
    const context = createContext(async (input) => {
      requests.push(String(input));
      return new Response("file contents", { headers: { "content-type": "text/plain; charset=utf-8" } });
    });

    const file = await client.downloadAttachment(
      context,
      {
        id: "reference-1",
        kind: "reference",
        name: "notes.txt",
        contentUrl: "https://tenant.sharepoint.com/sites/Team/notes.txt",
      },
      1024,
    );

    expect(requests[0]).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/shares\/u![^/]+\/driveItem\/content$/u);
    expect(file).toMatchObject({ name: "notes.txt", contentType: "text/plain" });
    expect(new TextDecoder().decode(file.bytes)).toBe("file contents");
  });

  it("uploads channel files to SharePoint and replies in the current post thread", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createClient();
    const context = createContext(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body });
      if (url.endsWith("/filesFolder")) {
        return Response.json({ id: "folder-1", parentReference: { driveId: "drive-1" } });
      }
      if (method === "PUT") {
        const body = init?.body;
        expect(body).toBeInstanceOf(File);
        expect(await (body as File).text()).toBe("status report");
        return Response.json({
          id: "item-1",
          name: "status.txt",
          webUrl: "https://tenant.sharepoint.com/status.txt",
          eTag: '"{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee},1"',
          parentReference: { driveId: "drive-1" },
        });
      }
      return Response.json({ id: "reply-1" });
    });

    await expect(
      client.sendChannelReplyAttachment(
        context,
        "team 1",
        "channel 1",
        "root 1",
        new File(["status report"], "status.txt", { type: "text/plain" }),
        "Latest status",
      ),
    ).resolves.toMatchObject({ id: "reply-1", name: "status.txt" });

    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/teams/team%201/channels/channel%201/filesFolder",
        method: "GET",
      },
      {
        url: "https://graph.microsoft.com/v1.0/drives/drive-1/items/folder-1:/status.txt:/content",
        method: "PUT",
      },
      {
        url: "https://graph.microsoft.com/v1.0/teams/team%201/channels/channel%201/messages/root%201/replies",
        method: "POST",
      },
    ]);
    const posted = JSON.parse(requests[2]!.body as string) as Record<string, unknown>;
    expect(posted).toMatchObject({
      attachments: [
        {
          id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          contentType: "reference",
          contentUrl: "https://tenant.sharepoint.com/status.txt",
          name: "status.txt",
        },
      ],
    });
  });

  it("uploads chat files to OneDrive and sends an organization share link", async () => {
    const postedBodies: unknown[] = [];
    const client = createClient();
    const context = createContext(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/me/drive/root:/OpenConnector")) {
        return Response.json({ id: "folder-1", parentReference: { driveId: "drive-1" } });
      }
      if (init?.method === "PUT") {
        return Response.json({ id: "item-1", name: "brief.txt", parentReference: { driveId: "drive-1" } });
      }
      if (url.endsWith("/createLink")) {
        return Response.json({ link: { webUrl: "https://tenant.sharepoint.com/share/brief" } });
      }
      postedBodies.push(JSON.parse(init?.body as string));
      return Response.json({ id: "chat-message-1" });
    });

    await expect(
      client.sendChatAttachment(context, "chat-1", new File(["brief"], "brief.txt"), "Requested brief"),
    ).resolves.toEqual({
      id: "chat-message-1",
      name: "brief.txt",
      webUrl: "https://tenant.sharepoint.com/share/brief",
    });
    expect(postedBodies[0]).toMatchObject({
      body: { contentType: "html", content: expect.stringContaining("https://tenant.sharepoint.com/share/brief") },
    });
  });
});

function createClient(): TeamsGatewayGraphClient {
  return new TeamsGatewayGraphClient(
    {
      async resolveForExecutionById() {
        throw new Error("Not used by this test.");
      },
    },
    {
      async getConfig() {
        return undefined;
      },
    },
  );
}

function createContext(fetcher: typeof fetch): TeamsGatewayGraphContext {
  return {
    selfId: "agent-user-id",
    selfEmail: "agent@company.test",
    presenceSessionId: "teams-app-id",
    deps: { accessToken: "token", fetcher },
  };
}
