import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { outlookCalendarProviderScopes, outlookCalendarReadScopes, outlookCalendarWriteScopes } from "./scopes.ts";

const service = "outlook_calendar";

interface OutlookCalendarActionSource {
  name: string;
  description: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const rawObject = s.record(true, { description: "A Microsoft Graph JSON object." });
const nonEmptyString = (description: string): JsonSchema => s.string({ minLength: 1, description });
const stringArray = (description: string): JsonSchema =>
  s.array(nonEmptyString("A string value."), { minItems: 1, description });
const calendarId = nonEmptyString("Outlook calendar ID. Omit this field to use the default calendar.");
const eventId = nonEmptyString("Outlook event ID.");
const nextLink = s.url("Opaque pagination URL returned by a previous Outlook Calendar response.");
const bodyContentType = s.stringEnum(["text", "html"], {
  description: "Preferred content type for event bodies returned by Microsoft Graph.",
});
const dateTimeTimeZone = s.object(
  {
    dateTime: nonEmptyString("Local ISO 8601 date and time, such as 2026-08-10T09:00:00."),
    timeZone: nonEmptyString("Microsoft mailbox time-zone name, such as W. Australia Standard Time or UTC."),
  },
  {
    required: ["dateTime", "timeZone"],
    description: "Microsoft Graph date, time, and time-zone value.",
  },
);
const attendee = s.anyOf(
  [
    s.email("Attendee email address. String attendees are treated as required attendees."),
    s.object(
      {
        address: s.email("Attendee email address."),
        name: s.string({ description: "Attendee display name." }),
        type: s.stringEnum(["required", "optional", "resource"], {
          description: "Attendee role. Defaults to required.",
        }),
      },
      {
        required: ["address"],
        description: "Attendee with an optional display name and role.",
      },
    ),
  ],
  { description: "Attendee email address or attendee object." },
);
const attendees = s.array(attendee, {
  maxItems: 500,
  description: "Meeting attendees. Creating an event with attendees sends invitations.",
});
const outlookCalendar = s.looseObject(
  {
    id: nonEmptyString("Calendar ID."),
    name: nonEmptyString("Calendar name."),
    color: s.string({ description: "Calendar color." }),
    changeKey: s.string({ description: "Calendar version identifier." }),
    canEdit: s.boolean({ description: "Whether the connected account can edit the calendar." }),
    canShare: s.boolean({ description: "Whether the connected account can share the calendar." }),
    canViewPrivateItems: s.boolean({ description: "Whether private items are visible." }),
    isDefaultCalendar: s.boolean({ description: "Whether this is the account's default calendar." }),
    isRemovable: s.boolean({ description: "Whether the calendar can be removed from the account." }),
    owner: rawObject,
  },
  { description: "Outlook calendar resource." },
);
const outlookEvent = s.looseObject(
  {
    id: nonEmptyString("Event ID."),
    subject: s.string({ description: "Event subject." }),
    bodyPreview: s.string({ description: "Preview of the event body." }),
    body: rawObject,
    start: rawObject,
    end: rawObject,
    location: rawObject,
    locations: s.array(rawObject, { description: "Event locations." }),
    attendees: s.array(rawObject, { description: "Event attendees and response statuses." }),
    organizer: rawObject,
    responseStatus: rawObject,
    recurrence: rawObject,
    onlineMeeting: rawObject,
    webLink: s.string({ description: "Web URL for the event in Outlook." }),
    isAllDay: s.boolean({ description: "Whether this is an all-day event." }),
    isCancelled: s.boolean({ description: "Whether this event is cancelled." }),
    isOrganizer: s.boolean({ description: "Whether the connected account organizes the event." }),
    isOnlineMeeting: s.boolean({ description: "Whether this event is an online meeting." }),
    showAs: s.string({ description: "Free/busy status shown during the event." }),
    sensitivity: s.string({ description: "Event sensitivity." }),
    categories: s.array(s.string(), { description: "Outlook categories assigned to the event." }),
  },
  { description: "Outlook event resource." },
);
const outlookUser = s.looseObject(
  {
    id: nonEmptyString("Unique identifier for the current account."),
    displayName: s.string({ description: "Display name of the current account." }),
    mail: s.nullableString("Primary SMTP address for the current account."),
    userPrincipalName: s.string({ description: "User principal name for the current account." }),
  },
  { description: "Current Microsoft account profile." },
);
const success = s.object(
  {
    success: s.literal(true, { description: "Whether the calendar operation completed successfully." }),
  },
  { required: ["success"], description: "Successful Outlook Calendar mutation acknowledgement." },
);

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Outlook Calendar action input.");
}

const eventWriteFields = {
  subject: s.string({ description: "Event or meeting subject." }),
  body: s.string({ description: "Event body content." }),
  isHtml: s.boolean({ description: "Whether the event body is HTML instead of plain text." }),
  start: dateTimeTimeZone,
  end: dateTimeTimeZone,
  location: s.string({ description: "Event location display name." }),
  attendees,
  categories: stringArray("Outlook categories for the event."),
  importance: s.stringEnum(["low", "normal", "high"], { description: "Event importance." }),
  sensitivity: s.stringEnum(["normal", "personal", "private", "confidential"], {
    description: "Event sensitivity.",
  }),
  showAs: s.stringEnum(["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"], {
    description: "Free/busy status shown during the event.",
  }),
  isAllDay: s.boolean({ description: "Whether this is an all-day event." }),
  isReminderOn: s.boolean({ description: "Whether Outlook should show an event reminder." }),
  reminderMinutesBeforeStart: s.integer({
    minimum: 0,
    description: "Minutes before the event start when the reminder should appear.",
  }),
  allowNewTimeProposals: s.boolean({ description: "Whether attendees can propose a new meeting time." }),
  isOnlineMeeting: s.boolean({ description: "Whether Outlook should create an online meeting." }),
  onlineMeetingProvider: s.stringEnum(["teamsForBusiness", "skypeForBusiness", "skypeForConsumer", "unknown"], {
    description: "Online meeting provider.",
  }),
  recurrence: rawObject,
};

const actions: OutlookCalendarActionSource[] = [
  action(
    "get_profile",
    "Get the connected Microsoft account profile so you can identify which Outlook Calendar is in use.",
    [outlookCalendarProviderScopes.userRead],
    [outlookCalendarProviderScopes.userRead],
    input({}),
    outlookUser,
  ),
  action(
    "list_calendars",
    "List calendars available to the connected Outlook account with optional field selection and pagination.",
    outlookCalendarReadScopes,
    [outlookCalendarProviderScopes.calendarsReadWrite],
    input({
      top: s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of calendars to return." }),
      select: stringArray("Calendar fields to request from Microsoft Graph."),
      nextLink,
    }),
    s.object(
      {
        calendars: s.array(outlookCalendar, { description: "Calendars returned by Outlook." }),
        nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
      },
      { required: ["calendars", "nextLink"], description: "Outlook calendar list response." },
    ),
  ),
  action(
    "list_events",
    "List event occurrences, exceptions, and single events in a time range from the default or selected Outlook calendar.",
    outlookCalendarReadScopes,
    [outlookCalendarProviderScopes.calendarsReadWrite],
    input(
      {
        calendarId,
        startDateTime: nonEmptyString(
          "Inclusive ISO 8601 range start. Include an offset, such as 2026-08-10T00:00:00+08:00.",
        ),
        endDateTime: nonEmptyString(
          "Exclusive ISO 8601 range end. Include an offset, such as 2026-08-11T00:00:00+08:00.",
        ),
        top: s.integer({ minimum: 1, maximum: 1000, description: "Maximum number of events to return." }),
        filter: s.string({ description: "OData filter expression for the calendar view." }),
        orderby: s.string({ description: "OData orderby expression for the calendar view." }),
        select: stringArray("Event fields to request from Microsoft Graph."),
        timeZone: s.string({ description: "Time zone for event start and end values in the response." }),
        bodyContentType,
        nextLink,
      },
      ["startDateTime", "endDateTime"],
    ),
    s.object(
      {
        events: s.array(outlookEvent, { description: "Events returned by Outlook." }),
        nextLink: s.nullableString("Pagination URL for the next page, or null when there is no next page."),
      },
      { required: ["events", "nextLink"], description: "Outlook event list response." },
    ),
  ),
  action(
    "get_event",
    "Get one Outlook event by event ID, with optional field selection, body format, and response time zone.",
    outlookCalendarReadScopes,
    [outlookCalendarProviderScopes.calendarsReadWrite],
    input(
      {
        eventId,
        select: stringArray("Event fields to request from Microsoft Graph."),
        timeZone: s.string({ description: "Time zone for event start and end values in the response." }),
        bodyContentType,
      },
      ["eventId"],
    ),
    outlookEvent,
  ),
  action(
    "create_event",
    "Create an event or meeting in the default or selected Outlook calendar; attendees receive invitations.",
    outlookCalendarWriteScopes,
    [outlookCalendarProviderScopes.calendarsReadWrite],
    input(
      {
        calendarId,
        ...eventWriteFields,
        transactionId: s.string({
          minLength: 1,
          description: "Client-supplied transaction ID used by Microsoft Graph to avoid duplicate retries.",
        }),
      },
      ["subject", "start", "end"],
    ),
    outlookEvent,
  ),
  action(
    "update_event",
    "Update supplied fields on an existing Outlook event or meeting.",
    outlookCalendarWriteScopes,
    [outlookCalendarProviderScopes.calendarsReadWrite],
    input(
      {
        eventId,
        ifMatch: s.string({ description: "Optional event ETag used for optimistic concurrency." }),
        ...eventWriteFields,
      },
      ["eventId"],
    ),
    outlookEvent,
  ),
  action(
    "delete_event",
    "Delete an Outlook event; deleting a meeting organized by this account sends cancellations to attendees.",
    outlookCalendarWriteScopes,
    [outlookCalendarProviderScopes.calendarsReadWrite],
    input(
      {
        eventId,
        ifMatch: s.string({ description: "Optional event ETag used for optimistic concurrency." }),
      },
      ["eventId"],
    ),
    success,
  ),
  action(
    "respond_to_event",
    "Accept, tentatively accept, or decline an Outlook meeting invitation, optionally sending a comment or proposing another time.",
    outlookCalendarWriteScopes,
    [outlookCalendarProviderScopes.calendarsReadWrite],
    input(
      {
        eventId,
        response: s.stringEnum(["accept", "tentatively_accept", "decline"], {
          description: "Response to send for the meeting invitation.",
        }),
        comment: s.string({ description: "Optional comment sent to the meeting organizer." }),
        sendResponse: s.boolean({
          default: true,
          description: "Whether Outlook should send the response to the organizer. Defaults to true.",
        }),
        proposedStart: dateTimeTimeZone,
        proposedEnd: dateTimeTimeZone,
      },
      ["eventId", "response"],
    ),
    success,
  ),
];

export const outlookCalendarActions: ActionDefinition[] = actions.map((item) => defineProviderAction(service, item));

function action(
  name: string,
  description: string,
  requiredScopes: string[],
  providerPermissions: string[],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): OutlookCalendarActionSource {
  return { name, description, requiredScopes, providerPermissions, inputSchema, outputSchema };
}
