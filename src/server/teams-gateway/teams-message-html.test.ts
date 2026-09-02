import { describe, expect, it } from "vitest";
import { renderTeamsMessageHtml } from "./teams-message-html.ts";

describe("renderTeamsMessageHtml", () => {
  it("renders common agent Markdown as Teams-safe structured HTML", () => {
    expect(
      renderTeamsMessageHtml(`# Blocked

I need **Zeke's approval** before continuing.

1. Retry shortly
2. Message Zeke directly

> Nothing has been sent yet.

| Owner | Status |
| --- | --- |
| Clark | Waiting |

Use \`Access work or school\` and see [the guide](https://example.test/guide).`),
    ).toBe(
      '<p><strong>Blocked</strong></p><p>I need <strong>Zeke\'s approval</strong> before continuing.</p><ol><li>Retry shortly</li><li>Message Zeke directly</li></ol><blockquote><p>Nothing has been sent yet.</p></blockquote><table><thead><tr><th>Owner</th><th>Status</th></tr></thead><tbody><tr><td>Clark</td><td>Waiting</td></tr></tbody></table><p>Use <code>Access work or school</code> and see <a href="https://example.test/guide">the guide</a>.</p>',
    );
  });

  it("escapes raw HTML and refuses unsafe links", () => {
    expect(renderTeamsMessageHtml('<script>alert("x")</script>\n\n[open](javascript:alert%281%29)')).toBe(
      "<p>open</p>",
    );
  });
});
