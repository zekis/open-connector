import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AgentsPage } from "./agents-page";
import { emptyData } from "./model";

describe("AgentsPage", () => {
  it("presents Claude subscription setup with Anthropic model settings", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentsPage
          data={{
            ...emptyData,
            agentSettings: [{ provider: "claude_code", model: "opus" }],
            agentModels: [
              { id: "opus", displayName: "Opus 5" },
              { id: "sonnet", displayName: "Sonnet 5" },
            ],
          }}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).not.toContain("Codex");
    expect(html).not.toContain("OpenAI agent");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Claude uses your subscription");
    expect(html).toContain("claude setup-token");
    expect(html).toContain("Claude subscription OAuth");
    expect(html).toContain("Ready for Flows");
    expect(html).toContain("Flow model");
    expect(html).toContain("Opus 5");
    expect(html).toContain("Sonnet 5");
    expect(html).toContain('value="opus" selected=""');
    expect(html).toContain("Read from Anthropic");
    expect(html).toContain('href="/providers"');
  });
});
