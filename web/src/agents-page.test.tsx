import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AgentsPage } from "./agents-page";
import { emptyData } from "./model";

describe("AgentsPage", () => {
  it("presents Claude and Codex subscription setup with provider model settings", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AgentsPage
          data={{
            ...emptyData,
            agentSettings: [{ provider: "claude_code", model: "opus" }],
            agentModels: {
              claude_code: [
                { id: "opus", displayName: "Opus 5" },
                { id: "sonnet", displayName: "Sonnet 5" },
              ],
              openai_codex: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" }],
            },
          }}
          onRefresh={() => {}}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Codex");
    expect(html).toContain("OpenAI agent");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Use your existing subscriptions");
    expect(html).toContain("claude setup-token");
    expect(html).toContain("Claude subscription OAuth");
    expect(html).toContain("Ready for Flows");
    expect(html).toContain("Agent model");
    expect(html).toContain("Opus 5");
    expect(html).toContain("Sonnet 5");
    expect(html).toContain('value="opus" selected=""');
    expect(html).toContain("codex login");
    expect(html).toContain("Verify local login");
    expect(html).toContain("GPT-5.6 Sol");
    expect(html).toContain('href="/providers"');
  });
});
