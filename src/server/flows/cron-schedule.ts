interface CronFieldDefinition {
  minimum: number;
  maximum: number;
  sundayAlias?: boolean;
}

interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
}

export interface ScheduleMatch {
  due: boolean;
  key: string;
}

const definitions: CronFieldDefinition[] = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 7, sundayAlias: true },
];

/** Validate the supported five-field cron syntax. */
export function validateCronExpression(expression: string): void {
  parseCronExpression(expression);
}

/** Match a UTC instant against a five-field cron expression in an IANA time zone. */
export function matchCronSchedule(expression: string, timeZone: string, now: Date): ScheduleMatch {
  const schedule = parseCronExpression(expression);
  const parts = zonedParts(now, timeZone);
  const dayOfMonthMatch = schedule.daysOfMonth.has(parts.day);
  const dayOfWeekMatch = schedule.daysOfWeek.has(parts.weekday);
  const dayMatches =
    schedule.dayOfMonthWildcard || schedule.dayOfWeekWildcard
      ? dayOfMonthMatch && dayOfWeekMatch
      : dayOfMonthMatch || dayOfWeekMatch;
  return {
    due:
      schedule.minutes.has(parts.minute) &&
      schedule.hours.has(parts.hour) &&
      schedule.months.has(parts.month) &&
      dayMatches,
    key: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}@${timeZone}`,
  };
}

/** Throw when a time-zone identifier cannot be resolved by the runtime. */
export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Unknown time zone: ${timeZone}.`);
  }
}

function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== definitions.length) {
    throw new Error("Cron must contain five fields: minute hour day-of-month month day-of-week.");
  }
  const parsed = fields.map((field, index) => parseField(field!, definitions[index]!));
  return {
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek: parsed[4]!,
    dayOfMonthWildcard: fields[2] === "*",
    dayOfWeekWildcard: fields[4] === "*",
  };
}

function parseField(field: string, definition: CronFieldDefinition): Set<number> {
  if (!field || !/^[\d*/,-]+$/u.test(field)) {
    throw new Error(`Invalid cron field: ${field || "(empty)"}.`);
  }
  const values = new Set<number>();
  for (const segment of field.split(",")) {
    addSegment(values, segment, definition);
  }
  if (values.size === 0) {
    throw new Error(`Cron field has no values: ${field}.`);
  }
  return values;
}

function addSegment(values: Set<number>, segment: string, definition: CronFieldDefinition): void {
  const [rangeValue, stepValue, ...extra] = segment.split("/");
  if (extra.length > 0 || !rangeValue) {
    throw new Error(`Invalid cron segment: ${segment}.`);
  }
  const step = stepValue === undefined ? 1 : readInteger(stepValue, 1, definition.maximum - definition.minimum + 1);
  let start: number;
  let end: number;
  if (rangeValue === "*") {
    start = definition.minimum;
    end = definition.maximum;
  } else if (rangeValue.includes("-")) {
    const [startValue, endValue, ...rangeExtra] = rangeValue.split("-");
    if (rangeExtra.length > 0 || !startValue || !endValue) {
      throw new Error(`Invalid cron range: ${rangeValue}.`);
    }
    start = readInteger(startValue, definition.minimum, definition.maximum);
    end = readInteger(endValue, definition.minimum, definition.maximum);
    if (start > end) {
      throw new Error(`Cron range must be ascending: ${rangeValue}.`);
    }
  } else {
    if (stepValue !== undefined) {
      throw new Error(`Cron steps require * or a range: ${segment}.`);
    }
    start = readInteger(rangeValue, definition.minimum, definition.maximum);
    end = start;
  }
  for (let value = start; value <= end; value += step) {
    values.add(definition.sundayAlias && value === 7 ? 0 : value);
  }
}

function readInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Cron value must be an integer between ${minimum} and ${maximum}: ${value}.`);
  }
  return parsed;
}

function zonedParts(
  now: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
} {
  validateTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const weekdays = new Map([
    ["Sun", 0],
    ["Mon", 1],
    ["Tue", 2],
    ["Wed", 3],
    ["Thu", 4],
    ["Fri", 5],
    ["Sat", 6],
  ]);
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    weekday: weekdays.get(values.get("weekday") ?? "") ?? -1,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
