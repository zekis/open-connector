import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { credentialValidators, executors, outlookActionHandlers } from "./executors.ts";

afterEach(() => vi.unstubAllGlobals());

const sharedCredential = {
  authType: "oauth2" as const,
  accessToken: "token",
  tokenType: "Bearer",
  connectionValues: { mailbox: "support@example.com" },
  profile: { accountId: "support@example.com", displayName: "support@example.com", grantedScopes: [] },
  metadata: {},
};

describe("Outlook executors", () => {
  it("uses the saved mailbox when actions omit it and keeps personal connections separate", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));
    vi.stubGlobal("fetch", fetcher);
    const shared = { getCredential: async () => sharedCredential };
    const personal = { getCredential: async () => ({ ...sharedCredential, connectionValues: {} }) };
    expect(await executors["outlook.list_messages"]!({}, shared)).toMatchObject({ ok: true });
    expect(await executors["outlook.list_messages"]!({}, personal)).toMatchObject({ ok: true });
    expect(String(vi.mocked(fetcher).mock.calls[0]![0])).toContain("/users/support%40example.com/messages");
    expect(String(vi.mocked(fetcher).mock.calls[1]![0])).toContain("/me/messages");
    expect(await executors["outlook.get_profile"]!({}, shared)).toMatchObject({
      ok: true,
      output: { mail: "support@example.com" },
    });
    expect(await executors["outlook.list_messages"]!({ mailbox: "other@example.com" }, shared)).toMatchObject({
      ok: false,
    });
    expect(await executors["outlook.update_mailbox_settings"]!({ timeZone: "UTC" }, shared)).toMatchObject({
      ok: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("verifies shared inbox access and uses its address as the connection identity", async () => {
    const fetcher = createFetch(async (url) =>
      Response.json(String(url).includes("/me?") ? { id: "user-id", mail: "user@example.com" } : { id: "inbox-id" }),
    );
    expect(await credentialValidators.oauth2!(sharedCredential, { fetcher })).toMatchObject({
      profile: { accountId: "support@example.com", displayName: "support@example.com" },
      metadata: { currentAccount: { id: "user-id" } },
    });
    expect(String(vi.mocked(fetcher).mock.calls[1]![0])).toContain("/users/support%40example.com/mailFolders/inbox");
    const denied = createFetch(async () => new Response("Access denied", { status: 403 }));
    await expect(credentialValidators.oauth2!(sharedCredential, { fetcher: denied })).rejects.toBeInstanceOf(
      ProviderRequestError,
    );
  });

  it.each([
    ["list_mail_folders", {}, "mailFolders", "GET"],
    ["list_messages", {}, "messages", "GET"],
    ["list_messages", { mailFolderId: "inbox" }, "mailFolders/inbox/messages", "GET"],
    ["get_message", { messageId: "message 1" }, "messages/message%201", "GET"],
    ["list_attachments", { messageId: "message 1" }, "messages/message%201/attachments", "GET"],
    ["create_draft", { subject: "Hello", body: "Test" }, "messages", "POST"],
    ["create_reply_draft", { messageId: "message 1", comment: "Thanks" }, "messages/message%201/createReply", "POST"],
    ["update_draft", { messageId: "message 1", body: "Updated" }, "messages/message%201", "PATCH"],
    ["set_message_read", { messageId: "message 1", isRead: true }, "messages/message%201", "PATCH"],
    ["delete_message", { messageId: "message 1" }, "messages/message%201", "DELETE"],
    ["send_draft", { messageId: "message 1" }, "messages/message%201/send", "POST"],
    ["send_email", { subject: "Hello", body: "Test", toRecipients: ["recipient@example.com"] }, "sendMail", "POST"],
    ["reply_email", { messageId: "message 1", comment: "Thanks" }, "messages/message%201/reply", "POST"],
  ])("routes %s to the selected shared mailbox", async (action, input, path, method) => {
    const fetcher = createFetch(async () => Response.json({ value: [], id: "result" }));
    await outlookActionHandlers[action]!(
      { ...input, mailbox: "support@example.com" },
      { accessToken: "token", fetcher },
    );
    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(String(request)).toContain(`/v1.0/users/support%40example.com/${path}`);
    expect(init?.method).toBe(method);
    if (action === "send_email" || action === "create_draft") {
      const body = JSON.parse(String(init?.body));
      expect((body.message ?? body).from).toEqual({ emailAddress: { address: "support@example.com" } });
    }
  });

  it.each(["list_messages", "list_mail_folders"])("follows shared mailbox pagination for %s", async (action) => {
    const resource = action === "list_messages" ? "messages" : "mailFolders";
    const nextLink = `https://graph.microsoft.com/v1.0/users/support@example.com/${resource}?$skiptoken=opaque%2Btoken`;
    const fetcher = createFetch(async () => Response.json({ value: [{ id: "next" }] }));
    await outlookActionHandlers[action]!(
      { mailbox: "support@example.com", nextLink, top: 1 },
      { accessToken: "token", fetcher },
    );
    expect(vi.mocked(fetcher).mock.calls[0]![0]).toBe(nextLink);
  });

  it.each([
    "https://example.com/v1.0/users/support@example.com/messages",
    "http://graph.microsoft.com/v1.0/users/support@example.com/messages",
    "https://graph.microsoft.com/v1.0/users/other@example.com/messages",
    "https://graph.microsoft.com/v1.0/me/messages",
    "https://graph.microsoft.com/v1.0/users/support@example.com/drive",
    "https://graph.microsoft.com/v1.0/users/support@example.com/messages/id/attachments",
    "https://graph.microsoft.com:8443/v1.0/users/support@example.com/messages",
    "https://user:pass@graph.microsoft.com/v1.0/users/support@example.com/messages",
  ])("rejects unsafe or mismatched shared pagination: %s", async (nextLink) => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));
    await expect(
      outlookActionHandlers.list_messages!(
        { mailbox: "support@example.com", nextLink },
        { accessToken: "token", fetcher },
      ),
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps personal mailbox pagination working", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/me/messages?$skip=10";
    const fetcher = createFetch(async () => Response.json({ value: [] }));
    await outlookActionHandlers.list_messages!({ nextLink }, { accessToken: "token", fetcher });
    expect(vi.mocked(fetcher).mock.calls[0]![0]).toBe(nextLink);
  });

  it("deletes a message by ID", async () => {
    const fetcher = createFetch(async () => new Response(null, { status: 204 }));

    await expect(
      outlookActionHandlers.delete_message!(
        { messageId: "message 1" },
        {
          accessToken: "access-token",
          tokenType: "Bearer",
          fetcher,
        },
      ),
    ).resolves.toEqual({ success: true });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(request instanceof Request ? request.url : request.toString()).pathname).toBe(
      "/v1.0/me/messages/message%201",
    );
    expect(init?.method).toBe("DELETE");
  });

  it("creates an editable reply draft with replacement content and additional recipients", async () => {
    const fetcher = createFetch(async () =>
      Response.json({ id: "reply-draft-1", subject: "RE: Project update", isDraft: true }, { status: 201 }),
    );

    await expect(
      outlookActionHandlers.create_reply_draft!(
        {
          messageId: "message 1",
          body: "Thanks, I will review it today.",
          isHtml: false,
          ccRecipients: ["pm@example.com"],
        },
        {
          accessToken: "access-token",
          tokenType: "Bearer",
          fetcher,
        },
      ),
    ).resolves.toEqual({ id: "reply-draft-1", subject: "RE: Project update", isDraft: true });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(request instanceof Request ? request.url : request.toString()).pathname).toBe(
      "/v1.0/me/messages/message%201/createReply",
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      message: {
        body: { contentType: "Text", content: "Thanks, I will review it today." },
        ccRecipients: [{ emailAddress: { address: "pm@example.com" } }],
      },
    });
  });

  it("rejects reply drafts that provide both comment and replacement body content", async () => {
    const fetcher = createFetch(async () => Response.json({ id: "reply-draft-1" }, { status: 201 }));

    await expect(
      outlookActionHandlers.create_reply_draft!(
        {
          messageId: "message-1",
          comment: "Thanks.",
          body: "Replacement content.",
        },
        {
          accessToken: "access-token",
          tokenType: "Bearer",
          fetcher,
        },
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ProviderRequestError>>({ status: 400 }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lists attachment metadata without requesting content bytes", async () => {
    const fetcher = createFetch(async () =>
      Response.json({
        value: [
          {
            id: "attachment-1",
            name: "plans.pdf",
            contentType: "application/pdf",
            size: 2048,
            isInline: false,
          },
        ],
      }),
    );

    await expect(
      outlookActionHandlers.list_attachments!({ messageId: "message 1" }, { accessToken: "access-token", fetcher }),
    ).resolves.toMatchObject({ attachments: [{ id: "attachment-1", name: "plans.pdf" }] });

    const [request] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/me/messages/message%201/attachments");
    expect(url.searchParams.get("$select")).not.toContain("contentBytes");
    expect(url.searchParams.get("$select")).not.toContain("contentId");
    expect(url.searchParams.get("$select")).not.toContain("sourceUrl");
  });

  it("downloads bounded raw attachment content into transit storage", async () => {
    const fetcher = createFetch(async (request) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      return url.pathname.endsWith("/$value")
        ? new Response("pdf-bytes", { headers: { "content-type": "application/pdf" } })
        : Response.json({ id: "attachment-1", name: "plans.pdf", contentType: "application/pdf", size: 9 });
    });
    const create = vi.fn(async () => ({
      fileId: "transit-1",
      downloadUrl: "/api/files/transit-1",
      sizeBytes: 9,
      name: "plans.pdf",
      mimeType: "application/pdf",
    }));

    await expect(
      outlookActionHandlers.download_attachment!(
        { mailbox: "support@example.com", messageId: "message-1", attachmentId: "attachment-1" },
        {
          accessToken: "access-token",
          fetcher,
          transitFiles: {
            maxBytes: 1024,
            create,
            async read() {
              throw new Error("not used");
            },
            async delete() {
              return false;
            },
          },
        },
      ),
    ).resolves.toMatchObject({
      name: "plans.pdf",
      mimeType: "application/pdf",
      file: { fileId: "transit-1" },
      contentBase64: null,
    });
    expect(create).toHaveBeenCalledOnce();
    for (const [request] of vi.mocked(fetcher).mock.calls) {
      expect(String(request)).toContain("/users/support%40example.com/messages/message-1/attachments/attachment-1");
    }
  });

  it("adds a transit file to a draft as a Graph file attachment", async () => {
    const fetcher = createFetch(async () => Response.json({ id: "attachment-1", name: "notes.txt" }, { status: 201 }));

    await expect(
      outlookActionHandlers.add_attachment!(
        { mailbox: "support@example.com", messageId: "draft 1", file: { fileId: "transit-1" } },
        {
          accessToken: "access-token",
          fetcher,
          transitFiles: {
            maxBytes: 5 * 1024 * 1024,
            async create() {
              throw new Error("not used");
            },
            async read() {
              return {
                file: new File(["hello"], "notes.txt", { type: "text/plain" }),
                sizeBytes: 5,
                name: "notes.txt",
                mimeType: "text/plain",
              };
            },
            async delete() {
              return false;
            },
          },
        },
      ),
    ).resolves.toMatchObject({ id: "attachment-1", name: "notes.txt" });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(request instanceof Request ? request.url : request.toString()).pathname).toBe(
      "/v1.0/users/support%40example.com/messages/draft%201/attachments",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "notes.txt",
      contentType: "text/plain",
      contentBytes: "aGVsbG8=",
    });
  });

  it("marks a message as read", async () => {
    const fetcher = createFetch(async () => Response.json({ id: "message-1", isRead: true }));

    await expect(
      outlookActionHandlers.set_message_read!(
        { messageId: "message-1", isRead: true },
        { accessToken: "access-token", fetcher },
      ),
    ).resolves.toMatchObject({ id: "message-1", isRead: true });

    const [, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ isRead: true });
  });
});

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
