import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ChatPage } from "./chat-page";
import { emptyData } from "./model";

describe("ChatPage", () => {
  it("shows configured Claude and the actions from connected applications", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChatPage
          data={{
            ...emptyData,
            providers: [
              {
                service: "example",
                displayName: "Example",
                categories: ["Developer Tools"],
                authTypes: ["api_key"],
                auth: [{ type: "api_key" }],
                actions: [
                  {
                    id: "example.lookup",
                    service: "example",
                    name: "lookup",
                    description: "Look up a record.",
                    requiredScopes: [],
                    execution: {
                      locallyExecutable: true,
                      catalogOnly: false,
                      requiredAuthTypes: ["api_key"],
                      noAuthRunnable: false,
                      needsCredential: true,
                    },
                  },
                ],
              },
            ],
            connections: [
              {
                id: "connection-1",
                service: "example",
                connectionName: "default",
                authType: "api_key",
                configured: true,
                virtual: false,
                default: true,
                profile: { displayName: "Example account" },
                metadata: {},
              },
            ],
            agentConnections: [
              {
                id: "claude-subscription",
                provider: "claude_code",
                authType: "subscription_oauth",
                configured: true,
                displayName: "Claude subscription",
              },
            ],
          }}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Claude is ready");
    expect(html).toContain("1 connected application · 1 available action");
    expect(html).toContain("What can I help you with?");
    expect(html).toContain("Summarize today&#x27;s important emails.");
    expect(html).toContain('aria-label="Message Claude"');
    expect(html).not.toContain("Set up Claude to start chatting");
  });

  it("directs an unconfigured runtime to Agent setup", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChatPage data={emptyData} />
      </MemoryRouter>,
    );

    expect(html).toContain("Agent setup required");
    expect(html).toContain("Connect your agent");
    expect(html).toContain('href="/agents"');
    expect(html).toContain("Set up Claude to start chatting");
    expect(html).toContain("disabled");
  });
});
