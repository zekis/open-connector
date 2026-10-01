import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { createClaudeAgentDecisionSchema } from "./claude-agent-decision.ts";

describe("agent decision schema", () => {
  const validator = new Validator(createClaudeAgentDecisionSchema(["lookup"]), "2020-12");

  it.each([{ kind: "final" }, { kind: "final", text: "" }, { kind: "final", text: " \n\t" }])(
    "rejects an empty final reply: %j",
    (decision) => {
      expect(validator.validate(decision).valid).toBe(false);
    },
  );

  it("accepts usable replies and tool decisions with an explanation", () => {
    expect(
      validator.validate({ kind: "tool_call", toolName: "lookup", arguments: {}, text: "Look up the record" }).valid,
    ).toBe(true);
    expect(validator.validate({ kind: "final", text: "Hello" }).valid).toBe(true);
  });
});
