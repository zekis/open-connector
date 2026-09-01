import type { AppData } from "./model";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { emptyData } from "./model";
import { TeamsGatewayAgentPage } from "./teams-gateway-agent-page";
import { TeamsGatewayPage } from "./teams-gateway-page";

const data: AppData = {
  ...emptyData,
  connections: [
    {
      id: "teams-connection",
      service: "microsoft_teams",
      connectionName: "default",
      authType: "oauth2",
      configured: true,
      profile: { displayName: "agent@company.test" },
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
};

describe("Teams gateway routes", () => {
  it("links agent creation to its own page", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/teams-gateway"]}>
        <Routes>
          <Route path="/teams-gateway" element={<TeamsGatewayPage data={data} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(html).toContain('href="/teams-gateway/new"');
    expect(html).not.toContain('data-slot="dialog-content"');
  });

  it("renders setup as a full routed editor", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/teams-gateway/new"]}>
        <Routes>
          <Route path="/teams-gateway/new" element={<TeamsGatewayAgentPage data={data} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(html).toContain("Create a Teams agent");
    expect(html).toContain('href="/teams-gateway"');
    expect(html).toContain("Save agent");
    expect(html).not.toContain('data-slot="dialog-content"');
  });
});
