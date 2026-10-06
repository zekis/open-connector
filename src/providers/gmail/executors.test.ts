import { afterEach, describe, expect, it, vi } from "vitest";
import { gmailActions } from "./actions.ts";
import { recipientResolvers } from "./executors.ts";

afterEach(() => vi.unstubAllGlobals());

const context = {
  getCredential: async () => ({
    authType: "oauth2" as const,
    accessToken: "token",
    tokenType: "Bearer",
    profile: { accountId: "me@example.com", displayName: "me@example.com", grantedScopes: [] },
    metadata: {},
  }),
};

function headers(values: Record<string, string>) {
  return { payload: { headers: Object.entries(values).map(([name, value]) => ({ name, value })) } };
}

describe("Gmail recipients", () => {
  it("marks only the actions that deliver mail", () => {
    expect(
      gmailActions
        .filter((action) => action.sendsMail)
        .map((action) => action.name)
        .sort(),
    ).toEqual(["reply_email", "reply_to_thread", "send_draft", "send_email"]);
  });

  it("splits every recipient field of a new email", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      recipientResolvers["gmail.send_email"]!(
        {
          to: "Alice <alice@example.com>, bob@example.com",
          extraRecipients: ["carol@example.com"],
          cc: ["dave@example.com"],
          bcc: "erin@example.com",
        },
        context,
      ),
    ).resolves.toEqual([
      "Alice <alice@example.com>",
      "bob@example.com",
      "carol@example.com",
      "dave@example.com",
      "erin@example.com",
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves a reply to the original message's reply-to or sender", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({ id: "m1", threadId: "t1", ...headers({ From: "Stranger <stranger@example.com>" }) }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      recipientResolvers["gmail.reply_email"]!({ threadId: "t1", messageId: "m1", body: "Thanks" }, context),
    ).resolves.toEqual(["Stranger <stranger@example.com>"]);
    expect(String(vi.mocked(fetcher).mock.calls[0]![0])).toContain("/users/me/messages/m1?format=metadata");
  });

  it("uses explicit thread reply recipients, or else the last message's sender", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({
        id: "t1",
        messages: [
          { id: "m1", threadId: "t1", ...headers({ From: "first@example.com" }) },
          { id: "m2", threadId: "t1", ...headers({ From: "last@example.com", "Reply-To": "list@example.com" }) },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      recipientResolvers["gmail.reply_to_thread"]!({ threadId: "t1", cc: "cc@example.com" }, context),
    ).resolves.toEqual(["list@example.com", "cc@example.com"]);
    await expect(
      recipientResolvers["gmail.reply_to_thread"]!({ threadId: "t1", to: "chosen@example.com" }, context),
    ).resolves.toEqual(["chosen@example.com"]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reads a draft's To, Cc, and Bcc headers before it is sent", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({
        id: "d1",
        message: {
          id: "m1",
          threadId: "t1",
          ...headers({ To: "a@example.com, B <b@example.com>", Cc: "c@example.com", Bcc: "d@example.com" }),
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(recipientResolvers["gmail.send_draft"]!({ draftId: "d1" }, context)).resolves.toEqual([
      "a@example.com",
      "B <b@example.com>",
      "c@example.com",
      "d@example.com",
    ]);
    expect(String(vi.mocked(fetcher).mock.calls[0]![0])).toContain("/users/me/drafts/d1?format=metadata");
  });
});
