import type { ActionDefinition, JsonSchema } from "./types.ts";
import type { OutputUnit, Schema } from "@cfworker/json-schema";

import { Validator } from "@cfworker/json-schema";

const validators = new WeakMap<ActionDefinition, Validator>();

/**
 * Keywords that describe where a failure sits rather than what went wrong.
 *
 * A single bad value produces one error for the value and one for every
 * structural keyword above it, so reporting all of them says "does not match
 * schema" several times without naming the input.
 */
const structuralKeywords = new Set([
  "$ref",
  "allOf",
  "anyOf",
  "contains",
  "dependentSchemas",
  "else",
  "false",
  "if",
  "items",
  "not",
  "oneOf",
  "patternProperties",
  "prefixItems",
  "properties",
  "then",
]);

/** How many inputs to name before summarising the rest. */
const maxReportedInputs = 6;

/**
 * Result of validating an action input against its JSON Schema.
 */
export type ActionInputValidationResult = {
  valid: boolean;
  errors: OutputUnit[];
};

/**
 * Validate unknown user input against an action's declared input schema.
 */
export function validateActionInput(action: ActionDefinition, input: unknown): ActionInputValidationResult {
  const result = validatorFor(action).validate(input);

  return {
    valid: result.valid,
    errors: result.errors,
  };
}

/**
 * Describe a validation failure by naming each rejected input and what its
 * schema expected, so a caller can correct the call instead of guessing which
 * of the inputs was the problem.
 *
 * Returns an empty string when nothing nameable can be derived, so callers can
 * fall back to their own wording.
 */
export function describeActionInputErrors(schema: JsonSchema, errors: readonly OutputUnit[]): string {
  const described: string[] = [];
  const seen = new Set<string>();

  for (const unit of errors) {
    if (structuralKeywords.has(unit.keyword)) continue;

    const detail = describeOne(schema, unit);
    if (!detail || seen.has(detail)) continue;
    seen.add(detail);
    described.push(detail);
  }

  if (described.length === 0) return "";
  if (described.length <= maxReportedInputs) return described.join("; ");

  const shown = described.slice(0, maxReportedInputs);
  return `${shown.join("; ")}; and ${described.length - maxReportedInputs} more`;
}

function describeOne(schema: JsonSchema, unit: OutputUnit): string {
  const path = instancePath(unit.instanceLocation);

  if (unit.keyword === "additionalProperties") {
    // Only worth a word when the action accepts no extra inputs; otherwise the
    // real reason is reported against the value itself.
    if (valueAt(schema, unit.keywordLocation) !== false) return "";
    const extra = /"([^"]+)"/u.exec(unit.error)?.[1];
    if (!extra) return "";
    const name = path ? `${path}.${extra}` : extra;
    return `${name} is not an input of this action`;
  }

  if (unit.keyword === "required") {
    // The library names the property only inside its message.
    const missing = /"([^"]+)"/u.exec(unit.error)?.[1];
    if (!missing) return "";
    const name = path ? `${path}.${missing}` : missing;
    const expectation = expectationOf(propertySchema(schemaAt(schema, unit.keywordLocation), missing));
    return expectation ? `${name} is required (expected ${expectation})` : `${name} is required`;
  }

  if (!path) return "";
  // "Instance type \"object\" is invalid. Expected \"string\"." and the enum
  // listing already say what was wanted; repeating it reads as a stutter. The
  // useful cases are the ones the library leaves bare, such as "String does
  // not match pattern.", which never shows the pattern.
  if (unit.keyword === "enum" || unit.error.includes("Expected")) return `${path} ${unit.error}`;

  const expectation = expectationOf(schemaAt(schema, unit.keywordLocation));
  return expectation ? `${path} ${unit.error} Expected ${expectation}.` : `${path} ${unit.error}`;
}

/** "#/query/fromDate" -> "query.fromDate"; "#" -> "". */
function instancePath(instanceLocation: string): string {
  return instanceLocation
    .replace(/^#\/?/u, "")
    .split("/")
    .filter(Boolean)
    .map(decodePointerSegment)
    .join(".");
}

/** Resolve the schema that owns the failing keyword, dropping the keyword itself. */
function schemaAt(root: JsonSchema, keywordLocation: string): JsonSchema | undefined {
  const segments = keywordLocation.replace(/^#\/?/u, "").split("/").filter(Boolean);
  segments.pop();

  let node: unknown = root;
  for (const segment of segments) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[decodePointerSegment(segment)];
  }

  return isSchema(node) ? node : undefined;
}

/** Resolve the value sitting exactly at a keyword location. */
function valueAt(root: JsonSchema, keywordLocation: string): unknown {
  const segments = keywordLocation.replace(/^#\/?/u, "").split("/").filter(Boolean);

  let node: unknown = root;
  for (const segment of segments) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[decodePointerSegment(segment)];
  }

  return node;
}

function propertySchema(owner: JsonSchema | undefined, name: string): JsonSchema | undefined {
  const properties = owner?.properties;
  if (typeof properties !== "object" || properties === null) return undefined;
  const found = (properties as Record<string, unknown>)[name];
  return isSchema(found) ? found : undefined;
}

/** Summarise what a schema accepts, in the order a reader needs it. */
function expectationOf(schema: JsonSchema | undefined): string {
  if (!schema) return "";

  const bits: string[] = [];
  if (Array.isArray(schema.enum)) {
    bits.push(`one of ${schema.enum.map((value) => String(value)).join(", ")}`);
  } else if (typeof schema.type === "string") {
    bits.push(schema.type);
  } else if (Array.isArray(schema.type)) {
    bits.push(schema.type.map((value) => String(value)).join(" or "));
  }

  if (typeof schema.format === "string") bits.push(`in ${schema.format} format`);
  if (typeof schema.pattern === "string") bits.push(`matching ${schema.pattern}`);

  const length = describeRange(schema.minLength, schema.maxLength, "characters");
  if (length) bits.push(length);

  const value = describeRange(schema.minimum, schema.maximum, "");
  if (value) bits.push(value);

  if (typeof schema.exclusiveMinimum === "number") bits.push(`greater than ${schema.exclusiveMinimum}`);

  const items = describeRange(schema.minItems, schema.maxItems, "items");
  if (items) bits.push(items);

  return bits.join(", ");
}

function describeRange(min: unknown, max: unknown, unit: string): string {
  const suffix = unit ? ` ${unit}` : "";
  if (typeof min === "number" && typeof max === "number") return `${min} to ${max}${suffix}`;
  if (typeof min === "number") return `at least ${min}${suffix}`;
  if (typeof max === "number") return `at most ${max}${suffix}`;
  return "";
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatorFor(action: ActionDefinition): Validator {
  let validator = validators.get(action);
  if (validator === undefined) {
    validator = new Validator(action.inputSchema as Schema, "2020-12");
    validators.set(action, validator);
  }

  return validator;
}
