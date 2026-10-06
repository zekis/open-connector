import type { JsonSchema } from "./types.ts";

import { describe, expect, it } from "vitest";
import { s } from "./json-schema.ts";
import { describeSchemaType, MAX_NESTED_FIELDS, summarizeInputSchema } from "./schema-summary.ts";

const lineItems = s.array(
  "Line items.",
  s.object(
    "One line item.",
    {
      description: s.nonEmptyString("Line item description."),
      quantity: s.number("Quantity."),
      unitAmount: s.number("Amount per unit."),
      accountCode: s.nonEmptyString("Account code."),
    },
    { required: ["description", "quantity", "unitAmount"], optional: ["accountCode"] },
  ),
);

const address = s.object(
  "Postal address.",
  { street: s.string("Street."), city: s.string("City.") },
  { optional: ["street", "city"] },
);

describe("describeSchemaType", () => {
  it("keeps primitive, enum, const and union types as before", () => {
    expect(describeSchemaType({ type: "string" })).toBe("string");
    expect(describeSchemaType(s.stringEnum("Status.", ["DRAFT", "SENT"]))).toBe('"DRAFT" | "SENT"');
    expect(describeSchemaType({ const: 3 })).toBe("3");
    expect(describeSchemaType(s.nullableString("Note."))).toBe("string | null");
    expect(describeSchemaType({ type: ["string", "null"] })).toBe("string | null");
    expect(describeSchemaType(undefined)).toBe("unknown");
    expect(describeSchemaType({ type: "array" })).toBe("array");
    expect(describeSchemaType({ type: "object" })).toBe("object");
  });

  it("describes an array of objects with required fields marked", () => {
    expect(describeSchemaType(lineItems)).toBe(
      "array<{ description*: string; quantity*: number; unitAmount*: number; accountCode?: string }>",
    );
  });

  it("describes object fields and arrays of primitives", () => {
    expect(describeSchemaType(address)).toBe("{ street?: string; city?: string }");
    expect(describeSchemaType(s.array("Tags.", s.string("Tag.")))).toBe("array<string>");
    expect(describeSchemaType({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    );
  });

  it("stops expanding past the nesting cap", () => {
    const deep: JsonSchema = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } },
          },
        },
      },
    };
    expect(describeSchemaType(deep)).toBe("{ a?: { b?: { c?: object } } }");
  });

  it("elides fields past the field cap", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_NESTED_FIELDS + 2 }, (_, index) => [`f${index}`, { type: "string" }]),
    );
    const type = describeSchemaType({ type: "object", properties });
    expect(type).toContain(`f${MAX_NESTED_FIELDS - 1}?: string`);
    expect(type).not.toContain(`f${MAX_NESTED_FIELDS}?`);
    expect(type).toMatch(/…2 more }$/);
  });

  it("resolves local refs and terminates on recursive schemas", () => {
    const root: JsonSchema = {
      type: "object",
      $defs: {
        node: {
          type: "object",
          properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } },
          required: ["name"],
        },
      },
      properties: { tree: { $ref: "#/$defs/node" } },
    };
    expect(describeSchemaType((root.properties as Record<string, JsonSchema>).tree, root)).toBe(
      "{ name*: string; children?: array<unknown> }",
    );
  });
});

describe("summarizeInputSchema", () => {
  it("adds nested field lists for object and array-of-object parameters", () => {
    const summary = summarizeInputSchema(
      s.object("Input.", { lineItems, address, note: s.string("Note.") }, { optional: ["address", "note"] }),
    );

    expect(summary).toEqual([
      {
        name: "lineItems",
        required: true,
        type: "array<{ description*: string; quantity*: number; unitAmount*: number; accountCode?: string }>",
        description: "Line items.",
        properties: [
          { name: "description", required: true, type: "string", description: "Line item description." },
          { name: "quantity", required: true, type: "number", description: "Quantity." },
          { name: "unitAmount", required: true, type: "number", description: "Amount per unit." },
          { name: "accountCode", required: false, type: "string", description: "Account code." },
        ],
      },
      {
        name: "address",
        required: false,
        type: "{ street?: string; city?: string }",
        description: "Postal address.",
        properties: [
          { name: "street", required: false, type: "string", description: "Street." },
          { name: "city", required: false, type: "string", description: "City." },
        ],
      },
      { name: "note", required: false, type: "string", description: "Note." },
    ]);
  });
});
