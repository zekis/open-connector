import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./chat-markdown";

describe("ChatMarkdown", () => {
  it("renders assistant formatting as semantic HTML", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{`Here's your **important mail**.

## Priorities

1. Follow up today
2. Review the [project](https://example.com)

- Status: \`ready\`
- Owner: ~~unknown~~ Zeke`}</ChatMarkdown>,
    );

    expect(html).toContain("<strong>important mail</strong>");
    expect(html).toContain("<h2>Priorities</h2>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>ready</code>");
    expect(html).toContain("<del>unknown</del>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("**important mail**");
  });

  it("does not render raw HTML or unsafe links", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{`<script>alert("unsafe")</script>

[Unsafe link](javascript:alert("unsafe"))`}</ChatMarkdown>,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="javascript:');
  });
});
