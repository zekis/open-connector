import { describe, expect, it } from "vitest";
import { matchCronSchedule, validateCronExpression, validateTimeZone } from "./cron-schedule.ts";

describe("cron schedules", () => {
  it("matches five-field schedules in their configured time zone", () => {
    const instant = new Date("2026-08-05T01:00:35.000Z");

    expect(matchCronSchedule("0 9 * * *", "Australia/Perth", instant)).toEqual({
      due: true,
      key: "2026-08-05T09:00@Australia/Perth",
    });
    expect(matchCronSchedule("30 9 * * *", "Australia/Perth", instant).due).toBe(false);
  });

  it("supports lists, ranges, steps, and Sunday aliases", () => {
    expect(() => validateCronExpression("*/15 8-17 * 1,6 0,7")).not.toThrow();
    expect(matchCronSchedule("0 9 1 * 3", "UTC", new Date("2026-08-05T09:00:00.000Z")).due).toBe(true);
  });

  it("rejects invalid expressions and time zones", () => {
    expect(() => validateCronExpression("0 9 * *")).toThrow(/five fields/u);
    expect(() => validateCronExpression("61 9 * * *")).toThrow(/between 0 and 59/u);
    expect(() => validateTimeZone("Not/A_Time_Zone")).toThrow(/Unknown time zone/u);
  });
});
