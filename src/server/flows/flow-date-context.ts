export interface FlowReportingWindow {
  startDate: string;
  endDateInclusive: string;
  startAt: string;
  endAtExclusive: string;
}

export interface FlowDateContext {
  referenceInstant: string;
  timeZone: string;
  localDate: string;
  localWeekday: string;
  reportingWindows: {
    today: FlowReportingWindow;
    yesterday: FlowReportingWindow;
    previousCalendarWeek: FlowReportingWindow;
    last24Hours: FlowReportingWindow;
  };
}

/** Resolve reporting dates from one fixed run instant, independently of the host time zone. */
export function createFlowDateContext(referenceInstant: string, timeZone: string): FlowDateContext {
  const reference = new Date(referenceInstant);
  if (!Number.isFinite(reference.getTime())) throw new Error("Invalid Flow reporting reference instant.");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = formatDate(reference, formatter);
  const weekday = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  const monday = shiftDate(localDate, -((weekday + 6) % 7));
  const last24HoursStart = new Date(reference.getTime() - 86_400_000);
  return {
    referenceInstant: reference.toISOString(),
    timeZone,
    localDate,
    localWeekday: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(reference),
    reportingWindows: {
      today: calendarWindow(localDate, shiftDate(localDate, 1), formatter),
      yesterday: calendarWindow(shiftDate(localDate, -1), localDate, formatter),
      previousCalendarWeek: calendarWindow(shiftDate(monday, -7), monday, formatter),
      last24Hours: {
        startDate: formatDate(last24HoursStart, formatter),
        endDateInclusive: formatDate(new Date(reference.getTime() - 1), formatter),
        startAt: last24HoursStart.toISOString(),
        endAtExclusive: reference.toISOString(),
      },
    },
  };
}

function calendarWindow(
  startDate: string,
  endDateExclusive: string,
  formatter: Intl.DateTimeFormat,
): FlowReportingWindow {
  return {
    startDate,
    endDateInclusive: shiftDate(endDateExclusive, -1),
    startAt: startOfLocalDate(startDate, formatter),
    endAtExclusive: startOfLocalDate(endDateExclusive, formatter),
  };
}

function formatDate(instant: Date, formatter: Intl.DateTimeFormat): string {
  const parts = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Find the first instant of the local calendar date, including zones whose
// clocks advance at midnight. Calendar-day windows may be 23 or 25 hours.
function startOfLocalDate(date: string, formatter: Intl.DateTimeFormat): string {
  const nominal = new Date(`${date}T00:00:00Z`).getTime();
  let lower = nominal - 2 * 86_400_000;
  let upper = nominal + 2 * 86_400_000;
  while (lower < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (formatDate(new Date(midpoint), formatter) < date) lower = midpoint + 1;
    else upper = midpoint;
  }
  return new Date(lower).toISOString();
}
