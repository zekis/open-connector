import type { JsonSchema } from "./types.ts";

/**
 * How many levels of nested objects a type description expands before it
 * falls back to a bare `object`. Top-level parameters are not counted.
 */
export const MAX_NESTED_DEPTH = 3;

/** How many fields of one object a type description lists before eliding the rest. */
export const MAX_NESTED_FIELDS = 12;

/**
 * One parameter of an action input, as shown to agents in `search_actions`
 * and in action guides. `properties` is present when the parameter is an
 * object, or an array of objects, whose fields are declared.
 */
export type InputFieldSummary = {
  name: string;
  required: boolean;
  type: string;
  description: string;
  properties?: InputFieldSummary[];
};

type DescribeContext = {
  root: JsonSchema;
  depth: number;
  seenRefs: ReadonlySet<string>;
};

/**
 * Describe a JSON Schema as a compact TypeScript-like type string, expanding
 * nested objects and array items so callers can see the fields they must send,
 * e.g. `array<{ description*: string; quantity*: number; accountCode?: string }>`.
 * Required fields are marked `*` and optional ones `?`. Enums and constants are
 * rendered as JSON literal unions.
 *
 * @param schema schema of one value
 * @param root schema that local `$ref`s resolve against (usually the action input schema)
 */
export function describeSchemaType(schema: JsonSchema | undefined, root: JsonSchema = schema ?? {}): string {
  return describe(schema, { root, depth: 0, seenRefs: new Set() });
}

/**
 * Summarize the top-level parameters of an action input schema, with nested
 * field lists for object and array-of-object parameters.
 */
export function summarizeInputSchema(schema: JsonSchema): InputFieldSummary[] {
  return summarizeFields(schema, { root: schema, depth: 0, seenRefs: new Set() });
}

/**
 * Return the object schema whose fields describe a value: the schema itself
 * when it is an object (`items: false`), or its item schema when it is an
 * array of objects (`items: true`).
 */
export function nestedObjectSchema(
  schema: JsonSchema | undefined,
  root: JsonSchema,
): { schema: JsonSchema; items: boolean } | undefined {
  const resolved = resolve(schema, root, new Set()).schema;
  if (!resolved) {
    return undefined;
  }
  if (hasProperties(resolved)) {
    return { schema: resolved, items: false };
  }
  const items = isSchema(resolved.items) ? resolve(resolved.items, root, new Set()).schema : undefined;
  return items && hasProperties(items) ? { schema: items, items: true } : undefined;
}

export function readSchemaProperties(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  return schema && isSchema(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
}

export function readSchemaRequired(schema: JsonSchema | undefined): string[] {
  return schema && Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function summarizeFields(schema: JsonSchema, context: DescribeContext): InputFieldSummary[] {
  const properties = readSchemaProperties(schema);
  const required = new Set(readSchemaRequired(schema));
  return Object.entries(properties).map(([name, property]) => {
    const summary: InputFieldSummary = {
      name,
      required: required.has(name),
      type: describe(property, context),
      description: typeof property.description === "string" ? property.description : "",
    };
    if (context.depth < MAX_NESTED_DEPTH) {
      const nested = nestedObjectSchema(property, context.root);
      if (nested) {
        summary.properties = summarizeFields(nested.schema, { ...context, depth: context.depth + 1 });
      }
    }
    return summary;
  });
}

function describe(schema: JsonSchema | undefined, context: DescribeContext): string {
  const { schema: resolved, seenRefs } = resolve(schema, context.root, context.seenRefs);
  if (!resolved) {
    return "unknown";
  }
  const next = { ...context, seenRefs };
  if (resolved.const !== undefined) {
    return JSON.stringify(resolved.const);
  }
  if (Array.isArray(resolved.enum)) {
    return resolved.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = resolved[key];
    if (Array.isArray(variants) && variants.length > 0) {
      return variants.map((variant) => describe(variant as JsonSchema, next)).join(" | ");
    }
  }
  if (Array.isArray(resolved.type)) {
    return resolved.type
      .map((type) => (typeof type === "string" ? describe({ ...resolved, type }, next) : "unknown"))
      .join(" | ");
  }
  const type = typeof resolved.type === "string" ? resolved.type : inferType(resolved);
  if (type === "array") {
    return describeArray(resolved, next);
  }
  if (type === "object") {
    return describeObject(resolved, next);
  }
  return type ?? "unknown";
}

function describeArray(schema: JsonSchema, context: DescribeContext): string {
  if (!isSchema(schema.items)) {
    return "array";
  }
  return `array<${describe(schema.items, context)}>`;
}

function describeObject(schema: JsonSchema, context: DescribeContext): string {
  const entries = Object.entries(readSchemaProperties(schema));
  if (entries.length === 0) {
    if (isSchema(schema.additionalProperties) && context.depth < MAX_NESTED_DEPTH) {
      return `Record<string, ${describe(schema.additionalProperties, { ...context, depth: context.depth + 1 })}>`;
    }
    return "object";
  }
  if (context.depth >= MAX_NESTED_DEPTH) {
    return "object";
  }
  const required = new Set(readSchemaRequired(schema));
  const inner = { ...context, depth: context.depth + 1 };
  const fields = entries
    .slice(0, MAX_NESTED_FIELDS)
    .map(([name, property]) => `${name}${required.has(name) ? "*" : "?"}: ${describe(property, inner)}`);
  if (entries.length > MAX_NESTED_FIELDS) {
    fields.push(`…${entries.length - MAX_NESTED_FIELDS} more`);
  }
  return `{ ${fields.join("; ")} }`;
}

function inferType(schema: JsonSchema): string | undefined {
  if (hasProperties(schema)) {
    return "object";
  }
  if (isSchema(schema.items)) {
    return "array";
  }
  return undefined;
}

/**
 * Follow local `$ref`s (`#/$defs/...` or `#/definitions/...`) against the root
 * schema, refusing to follow the same ref twice on one path so recursive
 * schemas terminate.
 */
function resolve(
  schema: JsonSchema | undefined,
  root: JsonSchema,
  seenRefs: ReadonlySet<string>,
): { schema: JsonSchema | undefined; seenRefs: ReadonlySet<string> } {
  let current = schema;
  let seen = seenRefs;
  while (current && typeof current.$ref === "string") {
    const ref = current.$ref;
    if (seen.has(ref)) {
      return { schema: undefined, seenRefs: seen };
    }
    seen = new Set([...seen, ref]);
    const target = lookupRef(root, ref);
    if (!target) {
      return { schema: undefined, seenRefs: seen };
    }
    const { $ref: _ref, ...rest } = current;
    current = { ...target, ...rest };
  }
  return { schema: current, seenRefs: seen };
}

function lookupRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let node: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isSchema(node)) {
      return undefined;
    }
    node = node[key];
  }
  return isSchema(node) ? node : undefined;
}

function hasProperties(schema: JsonSchema): boolean {
  return isSchema(schema.properties) && Object.keys(schema.properties).length > 0;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
