import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { outlookActionHandlers } from "./executors.ts";

describe("Outlook executors", () => {
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
        { messageId: "message-1", attachmentId: "attachment-1" },
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
  });
});

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
