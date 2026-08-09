import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { OutlookCalendarActionHandler, OutlookCalendarRuntimeDeps } from "./graph-client.ts";

import { compactObject, optionalString, requiredRecord, requiredString } from "../../core/cast.ts";
import { defineOAuthProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import {
  outlookCalendarCollectionRequest,
  outlookCalendarJsonRequest,
  outlookCalendarRequest,
} from "./graph-client.ts";

export const outlookCalendarActionHandlers: Record<string, OutlookCalendarActionHandler> = {
  get_profile(_input, deps) {
    return getProfile(deps);
  },
  list_calendars(input, deps) {
    return listCalendars(input, deps);
  },
  list_events(input, deps) {
    return listEvents(input, deps);
  },
  get_event(input, deps) {
    return getEvent(input, deps);
  },
  create_event(input, deps) {
    return createEvent(input, deps);
  },
  update_event(input, deps) {
    return updateEvent(input, deps);
  },
  delete_event(input, deps) {
    return deleteEvent(input, deps);
  },
  respond_to_event(input, deps) {
    return respondToEvent(input, deps);
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(
  "outlook_calendar",
  outlookCalendarActionHandlers,
);

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const currentAccount = await outlookCalendarJsonRequest<{
      id?: unknown;
      displayName?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
    }>(
      "me",
      {
        accessToken: input.accessToken,
        tokenType: input.tokenType,
        fetcher,
        signal,
      },
      {
        query: { $select: "id,displayName,mail,userPrincipalName" },
      },
    );
    const accountId = requiredString(currentAccount.id, "Outlook Calendar current account ID");
    return {
      profile: {
        accountId,
        displayName:
          optionalString(currentAccount.mail) ??
          optionalString(currentAccount.userPrincipalName) ??
          optionalString(currentAccount.displayName) ??
          accountId,
      },
      metadata: {
        currentAccount,
      },
    };
  },
};

async function getProfile(deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  return outlookCalendarJsonRequest("me", deps, {
    query: { $select: "id,displayName,mail,userPrincipalName" },
  });
}

async function listCalendars(input: Record<string, unknown>, deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  const pathOrUrl = optionalString(input.nextLink) ?? "me/calendars";
  const result = await outlookCalendarCollectionRequest(pathOrUrl, deps, {
    nextLinkKind: "calendars",
    query: optionalString(input.nextLink)
      ? undefined
      : compactObject({
          $top: typeof input.top === "number" ? input.top : undefined,
          $select: stringList(input.select),
        }),
  });
  return {
    calendars: result.items,
    nextLink: result.nextLink,
  };
}

async function listEvents(input: Record<string, unknown>, deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const calendarId = optionalString(input.calendarId);
  const pathOrUrl =
    nextLink ?? (calendarId ? `me/calendars/${encodeURIComponent(calendarId)}/calendarView` : "me/calendarView");
  const result = await outlookCalendarCollectionRequest(pathOrUrl, deps, {
    nextLinkKind: "calendar_view",
    query: nextLink
      ? undefined
      : compactObject({
          startDateTime: requiredString(input.startDateTime, "startDateTime"),
          endDateTime: requiredString(input.endDateTime, "endDateTime"),
          $top: typeof input.top === "number" ? input.top : undefined,
          $filter: optionalString(input.filter),
          $orderby: optionalString(input.orderby),
          $select: stringList(input.select),
        }),
    headers: buildEventReadHeaders(input),
  });
  return {
    events: result.items,
    nextLink: result.nextLink,
  };
}

async function getEvent(input: Record<string, unknown>, deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  return outlookCalendarJsonRequest(`me/events/${eventPathId(input.eventId)}`, deps, {
    query: compactObject({
      $select: stringList(input.select),
    }),
    headers: buildEventReadHeaders(input),
  });
}

async function createEvent(input: Record<string, unknown>, deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  const calendarId = optionalString(input.calendarId);
  const path = calendarId ? `me/calendars/${encodeURIComponent(calendarId)}/events` : "me/events";
  return outlookCalendarJsonRequest(path, deps, {
    method: "POST",
    body: buildEventWritePayload(input, true),
  });
}

async function updateEvent(input: Record<string, unknown>, deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  return outlookCalendarJsonRequest(`me/events/${eventPathId(input.eventId)}`, deps, {
    method: "PATCH",
    headers: {
      "if-match": optionalString(input.ifMatch),
    },
    body: buildEventWritePayload(input, false),
  });
}

async function deleteEvent(input: Record<string, unknown>, deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  await outlookCalendarRequest(`me/events/${eventPathId(input.eventId)}`, deps, {
    method: "DELETE",
    headers: {
      "if-match": optionalString(input.ifMatch),
    },
  });
  return { success: true };
}

async function respondToEvent(input: Record<string, unknown>, deps: OutlookCalendarRuntimeDeps): Promise<unknown> {
  const response = requiredString(input.response, "response");
  const responsePath = {
    accept: "accept",
    tentatively_accept: "tentativelyAccept",
    decline: "decline",
  }[response];
  if (!responsePath) {
    throw new ProviderRequestError(400, "response must be accept, tentatively_accept, or decline");
  }

  const proposedStart = input.proposedStart;
  const proposedEnd = input.proposedEnd;
  if ((proposedStart === undefined) !== (proposedEnd === undefined)) {
    throw new ProviderRequestError(400, "proposedStart and proposedEnd must be supplied together");
  }
  if (response === "accept" && proposedStart !== undefined) {
    throw new ProviderRequestError(400, "accept responses cannot propose a new time");
  }
  if (input.sendResponse === false && proposedStart !== undefined) {
    throw new ProviderRequestError(400, "sendResponse must be true when proposing a new time");
  }

  await outlookCalendarRequest(`me/events/${eventPathId(input.eventId)}/${responsePath}`, deps, {
    method: "POST",
    body: compactObject({
      comment: typeof input.comment === "string" ? input.comment : undefined,
      sendResponse: typeof input.sendResponse === "boolean" ? input.sendResponse : true,
      proposedNewTime:
        proposedStart === undefined
          ? undefined
          : {
              start: dateTimeTimeZone(proposedStart, "proposedStart"),
              end: dateTimeTimeZone(proposedEnd, "proposedEnd"),
            },
    }),
  });
  return { success: true };
}

function buildEventWritePayload(input: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  return compactObject({
    subject:
      typeof input.subject === "string"
        ? input.subject
        : creating
          ? requiredString(input.subject, "subject")
          : undefined,
    body:
      typeof input.body === "string"
        ? {
            contentType: input.isHtml === true ? "HTML" : "Text",
            content: input.body,
          }
        : undefined,
    start:
      input.start !== undefined
        ? dateTimeTimeZone(input.start, "start")
        : creating
          ? missingDateTime("start")
          : undefined,
    end: input.end !== undefined ? dateTimeTimeZone(input.end, "end") : creating ? missingDateTime("end") : undefined,
    location: typeof input.location === "string" ? { displayName: input.location } : undefined,
    attendees: normalizeAttendees(input.attendees),
    categories: stringValues(input.categories),
    importance: optionalString(input.importance),
    sensitivity: optionalString(input.sensitivity),
    showAs: optionalString(input.showAs),
    isAllDay: typeof input.isAllDay === "boolean" ? input.isAllDay : undefined,
    isReminderOn: typeof input.isReminderOn === "boolean" ? input.isReminderOn : undefined,
    reminderMinutesBeforeStart:
      typeof input.reminderMinutesBeforeStart === "number" ? input.reminderMinutesBeforeStart : undefined,
    allowNewTimeProposals: typeof input.allowNewTimeProposals === "boolean" ? input.allowNewTimeProposals : undefined,
    isOnlineMeeting: typeof input.isOnlineMeeting === "boolean" ? input.isOnlineMeeting : undefined,
    onlineMeetingProvider: optionalString(input.onlineMeetingProvider),
    recurrence:
      input.recurrence === undefined
        ? undefined
        : requiredRecord(input.recurrence, "recurrence", (message) => new ProviderRequestError(400, message)),
    transactionId: creating ? optionalString(input.transactionId) : undefined,
  });
}

function normalizeAttendees(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((attendee) => {
    if (typeof attendee === "string") {
      return {
        emailAddress: { address: requiredString(attendee, "attendee address") },
        type: "required",
      };
    }
    const item = requiredRecord(attendee, "attendee", (message) => new ProviderRequestError(400, message));
    return {
      emailAddress: compactObject({
        address: requiredString(item.address, "attendee address"),
        name: optionalString(item.name),
      }),
      type: optionalString(item.type) ?? "required",
    };
  });
}

function dateTimeTimeZone(value: unknown, fieldName: string): Record<string, string> {
  const input = requiredRecord(value, fieldName, (message) => new ProviderRequestError(400, message));
  return {
    dateTime: requiredString(input.dateTime, `${fieldName}.dateTime`),
    timeZone: requiredString(input.timeZone, `${fieldName}.timeZone`),
  };
}

function missingDateTime(fieldName: string): never {
  throw new ProviderRequestError(400, `${fieldName} is required.`);
}

function eventPathId(value: unknown): string {
  return encodeURIComponent(requiredString(value, "eventId"));
}

function stringList(value: unknown): string | undefined {
  const values = stringValues(value);
  return values && values.length > 0 ? values.join(",") : undefined;
}

function stringValues(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function buildEventReadHeaders(input: Record<string, unknown>): Record<string, string> | undefined {
  const preferences = [
    optionalString(input.timeZone)
      ? `outlook.timezone="${escapePreference(optionalString(input.timeZone)!)}"`
      : undefined,
    input.bodyContentType === "text" || input.bodyContentType === "html"
      ? `outlook.body-content-type="${input.bodyContentType}"`
      : undefined,
  ].filter((value): value is string => value !== undefined);
  return preferences.length > 0 ? { Prefer: preferences.join(", ") } : undefined;
}

function escapePreference(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
