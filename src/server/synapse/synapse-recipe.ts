import type { SynapseObjectRecipe, SynapseRecipeDateFormat, SynapseRecipePeriod } from "./synapse-types.ts";

const maximumRecipeDepth = 30;

/** Resolves the safe declarative values in a Synapse object recipe for one execution. */
export function resolveSynapseRecipeInput(
  recipe: SynapseObjectRecipe,
  now: Date = new Date(),
): Record<string, unknown> {
  return resolveRecipeRecord(recipe.input, now, 0);
}

/** Builds the default replace recipe for a connector result that can safely be refreshed. */
export function createSynapseObjectRecipe(
  actionId: string,
  connectionId: string,
  input: Record<string, unknown> = {},
): SynapseObjectRecipe {
  return {
    version: 1,
    actionId,
    connectionId,
    input: structuredClone(input),
    result: { mode: "replace", match: "source_identity" },
  };
}

/** Conservatively identifies connector actions that look like retrievals rather than mutations. */
export function isLikelyReadAction(actionId: string): boolean {
  const name = actionId.split(".").at(-1) ?? actionId;
  return /(?:^|_)(?:get|list|search|query|find|read|lookup|fetch|download|retrieve|inspect|view|export)(?:_|$)/u.test(
    name,
  );
}

function resolveRecipeRecord(value: Record<string, unknown>, now: Date, depth: number): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveRecipeValue(item, now, depth + 1)]),
  );
}

function resolveRecipeValue(value: unknown, now: Date, depth: number): unknown {
  if (depth > maximumRecipeDepth) throw new Error(`Synapse recipe values cannot exceed ${maximumRecipeDepth} levels.`);
  if (Array.isArray(value)) return value.map((item) => resolveRecipeValue(item, now, depth + 1));
  if (!isRecord(value)) return value;
  if (value.$synapse !== undefined) return resolveRecipeExpression(value, now);
  return resolveRecipeRecord(value, now, depth);
}

function resolveRecipeExpression(value: Record<string, unknown>, now: Date): string {
  if (value.$synapse === "now") return formatRecipeDate(now, readDateFormat(value.format, "iso_datetime"));
  if (value.$synapse !== "period") throw new Error("Unknown Synapse recipe expression.");
  const period = readPeriod(value.period);
  const edge = value.edge;
  if (edge !== "start" && edge !== "end") throw new Error("A period expression edge must be start or end.");
  const offset = value.offset === undefined ? 0 : value.offset;
  if (!Number.isInteger(offset) || Math.abs(Number(offset)) > 120) {
    throw new Error("A period expression offset must be an integer between -120 and 120.");
  }
  const boundary = edge === "start" ? periodStart(now, period, Number(offset)) : periodEnd(now, period, Number(offset));
  return formatRecipeDate(boundary, readDateFormat(value.format, "iso_date"));
}

function periodStart(now: Date, period: SynapseRecipePeriod, offset: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (period === "day") return new Date(Date.UTC(year, month, day + offset));
  if (period === "week") {
    const mondayOffset = (now.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(year, month, day - mondayOffset + offset * 7));
  }
  if (period === "month") return new Date(Date.UTC(year, month + offset, 1));
  if (period === "quarter") return new Date(Date.UTC(year, Math.floor(month / 3) * 3 + offset * 3, 1));
  return new Date(Date.UTC(year + offset, 0, 1));
}

function periodEnd(now: Date, period: SynapseRecipePeriod, offset: number): Date {
  return new Date(periodStart(now, period, offset + 1).getTime() - 1);
}

function formatRecipeDate(value: Date, format: SynapseRecipeDateFormat): string {
  const iso = value.toISOString();
  return format === "iso_date" ? iso.slice(0, 10) : iso;
}

function readPeriod(value: unknown): SynapseRecipePeriod {
  if (value === "day" || value === "week" || value === "month" || value === "quarter" || value === "year") {
    return value;
  }
  throw new Error("A period expression must use day, week, month, quarter, or year.");
}

function readDateFormat(value: unknown, fallback: SynapseRecipeDateFormat): SynapseRecipeDateFormat {
  if (value === undefined) return fallback;
  if (value === "iso_date" || value === "iso_datetime") return value;
  throw new Error("A Synapse recipe date format must be iso_date or iso_datetime.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
