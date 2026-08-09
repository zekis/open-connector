import type { OutlookCalendarRuntimeDeps } from "./graph-client.ts";

import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { credentialValidators, outlookCalendarActionHandlers } from "./executors.ts";

describe("Outlook Calendar executors", () => {
  it("lists expanded event occurrences in a selected calendar and time zone", async () => {
    const fetcher = createFetch(async () =>
      Response.json({ value: [{ id: "event-1", subject: "Project review" }], "@odata.nextLink": null }),
    );

    await expect(
      outlookCalendarActionHandlers.list_events!(
        {
          calendarId: "calendar 1",
          startDateTime: "2026-08-10T00:00:00+08:00",
          endDateTime: "2026-08-11T00:00:00+08:00",
          top: 50,
          select: ["id", "subject", "start", "end"],
          timeZone: "W. Australia Standard Time",
          bodyContentType: "text",
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({
      events: [{ id: "event-1", subject: "Project review" }],
      nextLink: null,
    });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/me/calendars/calendar%201/calendarView");
    expect(url.searchParams.get("startDateTime")).toBe("2026-08-10T00:00:00+08:00");
    expect(url.searchParams.get("endDateTime")).toBe("2026-08-11T00:00:00+08:00");
    expect(url.searchParams.get("$top")).toBe("50");
    expect(url.searchParams.get("$select")).toBe("id,subject,start,end");
    expect(new Headers(init?.headers).get("prefer")).toBe(
      'outlook.timezone="W. Australia Standard Time", outlook.body-content-type="text"',
    );
  });

  it("creates a meeting with Graph date-time, attendee, and idempotency fields", async () => {
    const fetcher = createFetch(async () =>
      Response.json({ id: "event-1", subject: "Project review" }, { status: 201 }),
    );

    await expect(
      outlookCalendarActionHandlers.create_event!(
        {
          subject: "Project review",
          body: "Review the delivery plan.",
          start: { dateTime: "2026-08-10T09:00:00", timeZone: "W. Australia Standard Time" },
          end: { dateTime: "2026-08-10T10:00:00", timeZone: "W. Australia Standard Time" },
          attendees: ["zeke@example.com", { address: "pm@example.com", name: "Project Manager", type: "optional" }],
          isOnlineMeeting: true,
          onlineMeetingProvider: "teamsForBusiness",
          transactionId: "flow-run-1",
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ id: "event-1", subject: "Project review" });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/me/events");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      subject: "Project review",
      body: { contentType: "Text", content: "Review the delivery plan." },
      start: { dateTime: "2026-08-10T09:00:00", timeZone: "W. Australia Standard Time" },
      end: { dateTime: "2026-08-10T10:00:00", timeZone: "W. Australia Standard Time" },
      attendees: [
        { emailAddress: { address: "zeke@example.com" }, type: "required" },
        { emailAddress: { address: "pm@example.com", name: "Project Manager" }, type: "optional" },
      ],
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      transactionId: "flow-run-1",
    });
  });

  it("rejects a pagination URL outside the expected Graph calendar endpoint", async () => {
    const fetcher = createFetch(async () => Response.json({ value: [] }));

    await expect(
      outlookCalendarActionHandlers.list_events!(
        {
          startDateTime: "2026-08-10T00:00:00Z",
          endDateTime: "2026-08-11T00:00:00Z",
          nextLink: "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=secret",
        },
        createDeps(fetcher),
      ),
    ).rejects.toEqual(expect.objectContaining<Partial<ProviderRequestError>>({ status: 400 }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("tentatively accepts an invitation with a proposed new time", async () => {
    const fetcher = createFetch(async () => new Response(null, { status: 202 }));

    await expect(
      outlookCalendarActionHandlers.respond_to_event!(
        {
          eventId: "event 1",
          response: "tentatively_accept",
          comment: "Could we start later?",
          proposedStart: { dateTime: "2026-08-10T10:00:00", timeZone: "W. Australia Standard Time" },
          proposedEnd: { dateTime: "2026-08-10T11:00:00", timeZone: "W. Australia Standard Time" },
        },
        createDeps(fetcher),
      ),
    ).resolves.toEqual({ success: true });

    const [request, init] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(request instanceof Request ? request.url : request.toString());
    expect(url.pathname).toBe("/v1.0/me/events/event%201/tentativelyAccept");
    expect(JSON.parse(String(init?.body))).toEqual({
      comment: "Could we start later?",
      sendResponse: true,
      proposedNewTime: {
        start: { dateTime: "2026-08-10T10:00:00", timeZone: "W. Australia Standard Time" },
        end: { dateTime: "2026-08-10T11:00:00", timeZone: "W. Australia Standard Time" },
      },
    });
  });

  it("uses the connected Microsoft account as the credential profile", async () => {
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

function createDeps(fetcher: typeof fetch): OutlookCalendarRuntimeDeps {
  return {
    accessToken: "access-token",
    tokenType: "Bearer",
    fetcher,
  };
}

function createFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return vi.fn(handler) as typeof fetch;
}
