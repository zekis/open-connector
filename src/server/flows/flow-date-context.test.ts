import { describe, expect, it } from "vitest";
import { createFlowDateContext } from "./flow-date-context.ts";

describe("Flow reporting date context", () => {
  it("uses Perth's calendar date even when UTC is still the previous day", () => {
    const context = createFlowDateContext("2026-09-21T23:00:00.000Z", "Australia/Perth");
    expect(context.localDate).toBe("2026-09-22");
    expect(context.localWeekday).toBe("Tuesday");
    expect(context.reportingWindows.yesterday).toEqual({
      startDate: "2026-09-21",
      endDateInclusive: "2026-09-21",
      startAt: "2026-09-20T16:00:00.000Z",
      endAtExclusive: "2026-09-21T16:00:00.000Z",
    });
    expect(context.reportingWindows.previousCalendarWeek).toEqual({
      startDate: "2026-09-14",
      endDateInclusive: "2026-09-20",
      startAt: "2026-09-13T16:00:00.000Z",
      endAtExclusive: "2026-09-20T16:00:00.000Z",
    });
  });

  it.each([
    ["2026-03-09T12:00:00Z", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
    ["2026-11-02T12:00:00Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
  ])("uses local midnight across daylight-saving changes at %s", (instant, start, end, hours) => {
    const context = createFlowDateContext(instant, "America/New_York");
    const window = context.reportingWindows.yesterday;
    expect(window.startAt).toBe(start);
    expect(window.endAtExclusive).toBe(end);
    expect(Date.parse(window.endAtExclusive) - Date.parse(window.startAt)).toBe(hours * 3_600_000);
    const rolling = context.reportingWindows.last24Hours;
    expect(Date.parse(rolling.endAtExclusive) - Date.parse(rolling.startAt)).toBe(86_400_000);
  });

  it("handles leap days and previous weeks crossing a year boundary", () => {
    expect(createFlowDateContext("2024-03-01T01:00:00Z", "Australia/Perth").reportingWindows.yesterday.startDate).toBe(
      "2024-02-29",
    );
    expect(
      createFlowDateContext("2026-01-05T01:00:00Z", "Australia/Perth").reportingWindows.previousCalendarWeek,
    ).toMatchObject({ startDate: "2025-12-29", endDateInclusive: "2026-01-04" });
  });

  it("supports fractional-hour offsets and rejects invalid references", () => {
    expect(createFlowDateContext("2026-09-22T01:00:00Z", "Asia/Kathmandu").reportingWindows.today.startAt).toBe(
      "2026-09-21T18:15:00.000Z",
    );
    expect(() => createFlowDateContext("invalid", "Australia/Perth")).toThrow();
    expect(() => createFlowDateContext("2026-09-22T01:00:00Z", "invalid")).toThrow();
  });
});
