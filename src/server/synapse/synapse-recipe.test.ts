import { describe, expect, it } from "vitest";
import { createSynapseObjectRecipe, isLikelyReadAction, resolveSynapseRecipeInput } from "./synapse-recipe.ts";

describe("Synapse object recipes", () => {
  it("resolves reusable calendar periods each time the recipe runs", () => {
    const recipe = createSynapseObjectRecipe("erp.list_timesheets", "erp-1", {
      from: { $synapse: "period", period: "month", edge: "start", offset: -1 },
      to: { $synapse: "period", period: "month", edge: "end", offset: -1 },
      nested: { generatedAt: { $synapse: "now", format: "iso_datetime" } },
    });

    expect(resolveSynapseRecipeInput(recipe, new Date("2026-09-10T06:30:00.000Z"))).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
      nested: { generatedAt: "2026-09-10T06:30:00.000Z" },
    });
  });

  it("recognises only conservative retrieval action names for automatic recipes", () => {
    expect(isLikelyReadAction("outlook.search_messages")).toBe(true);
    expect(isLikelyReadAction("brave.web_search")).toBe(true);
    expect(isLikelyReadAction("erp.create_invoice")).toBe(false);
    expect(isLikelyReadAction("outlook.send_message")).toBe(false);
  });
});
