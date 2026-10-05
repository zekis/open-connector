import type { ActionDefinition, JsonSchema } from "./types.ts";

import { describe, expect, it } from "vitest";
import { provider as quickchartProvider } from "../providers/quickchart/definition.ts";
import { describeActionInputErrors, validateActionInput } from "./validation.ts";

const baseAction: ActionDefinition = {
  id: "example.describe",
  service: "example",
  name: "describe",
  description: "Validation message fixture.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

describe("validateActionInput", () => {
  it("validates catalog action input without runtime code generation", () => {
    const action = quickchartProvider.actions.find((action) => action.id === "quickchart.build_qr_url");
    expect(action).toBeDefined();

    const result = validateActionInput(action!, {});

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "required",
          error: 'Instance does not have required property "text".',
        }),
      ]),
    );
  });
});

describe("describeActionInputErrors", () => {
  const messageFor = (schema: JsonSchema, input: unknown): string => {
    const action = { ...baseAction, inputSchema: schema };
    const result = validateActionInput(action, input);
    expect(result.valid, "input was expected to fail validation").toBe(false);
    return describeActionInputErrors(schema, result.errors);
  };

  it("names a missing input and what it expected", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["endpoint"],
      properties: { endpoint: { type: "string", pattern: "^/[^/]", minLength: 2, maxLength: 2048 } },
    };

    expect(messageFor(schema, {})).toBe("endpoint is required (expected string, matching ^/[^/], 2 to 2048 characters)");
  });

  it("names the input that failed a pattern, and shows the pattern", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { ifModifiedSince: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", minLength: 10, maxLength: 40 } },
    };

    expect(messageFor(schema, { ifModifiedSince: "last Tuesday" })).toBe(
      "ifModifiedSince String does not match pattern. Expected string, matching ^\\d{4}-\\d{2}-\\d{2}$, 10 to 40 characters.",
    );
  });

  it("names an input the action does not take", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { api: { type: "string" } },
      additionalProperties: false,
    };

    expect(messageFor(schema, { api: "accounting", tenant: "x" })).toBe("tenant is not an input of this action");
  });

  it("names a nested input by path", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        query: { type: "object", properties: { page: { type: "number" } } },
      },
    };

    expect(messageFor(schema, { query: { page: "two" } })).toBe('query.page Instance type "string" is invalid. Expected "number".');
  });

  it("does not repeat an expectation the validator already stated", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { api: { type: "string", enum: ["accounting", "assets"] } },
    };

    const message = messageFor(schema, { api: "Accounting" });
    expect(message).toBe('api Instance does not match any of ["accounting","assets"].');
    expect(message).not.toMatch(/Expected one of/u);
  });

  it("reports every rejected input, not just the first", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["api", "endpoint"],
      properties: { api: { type: "string" }, endpoint: { type: "string" } },
    };

    expect(messageFor(schema, {})).toBe("api is required (expected string); endpoint is required (expected string)");
  });

  it("summarises the tail rather than listing every input of a very wrong call", () => {
    const properties: Record<string, JsonSchema> = {};
    for (let index = 0; index < 9; index += 1) properties[`field${index}`] = { type: "string" };
    const schema: JsonSchema = { type: "object", required: Object.keys(properties), properties };

    expect(messageFor(schema, {})).toBe(
      "field0 is required (expected string); field1 is required (expected string); field2 is required (expected string); " +
        "field3 is required (expected string); field4 is required (expected string); field5 is required (expected string); " +
        "and 3 more",
    );
  });

  it("says nothing it cannot attribute to an input, so the caller can fall back", () => {
    expect(describeActionInputErrors({ type: "object" }, [])).toBe("");
    expect(describeActionInputErrors({ type: "object" }, [
      { keyword: "properties", keywordLocation: "#/properties", instanceLocation: "#", error: "Does not match." },
    ])).toBe("");
  });
});
