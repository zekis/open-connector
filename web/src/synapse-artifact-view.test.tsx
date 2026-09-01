import type { SynapseArtifactDisplay } from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { circularGraphPositions, SynapseArtifactView, synapseDisplayLabel } from "./synapse-artifact-view";

describe("SynapseArtifactView", () => {
  it.each([
    ["list", { type: "list", items: [{ title: "Launch", detail: "Ready", status: "Doing" }] }],
    ["table", { type: "table", columns: ["Team", "Score"], rows: [["Alpha", 8]] }],
    ["kanban", { type: "kanban", columns: [{ title: "Doing", items: [{ title: "Release checks", detail: "Alex" }] }] }],
    ["canvas", { type: "canvas", items: [{ title: "Launch", content: "Core idea", x: 20, y: 30 }] }],
    [
      "graph",
      {
        type: "graph",
        nodes: [
          { id: "build", label: "Build" },
          { id: "release", label: "Release" },
        ],
        edges: [{ source: "build", target: "release" }],
      },
    ],
    [
      "chart",
      {
        type: "chart",
        chartType: "bar",
        labels: ["Week 1", "Week 2"],
        series: [{ name: "Total", values: [4, 7] }],
      },
    ],
  ] satisfies Array<[string, SynapseArtifactDisplay]>)("renders a %s display", (_type, display) => {
    const html = renderToStaticMarkup(<SynapseArtifactView display={display} markdown="Fallback" />);

    expect(html).toContain(`synapse-display-${display.type}`);
    expect(html).not.toContain("Fallback");
  });

  it("falls back to Markdown and labels structured node types", () => {
    expect(renderToStaticMarkup(<SynapseArtifactView markdown="**Readable fallback**" />)).toContain(
      "Readable fallback",
    );
    expect(synapseDisplayLabel({ type: "kanban", columns: [] })).toBe("Kanban");
  });

  it("lays graph nodes out at distinct finite positions", () => {
    const positions = [...circularGraphPositions(["one", "two", "three"]).values()];

    expect(new Set(positions.map((position) => `${position.x}:${position.y}`)).size).toBe(3);
    expect(positions.every((position) => Number.isFinite(position.x) && Number.isFinite(position.y))).toBe(true);
  });
});
