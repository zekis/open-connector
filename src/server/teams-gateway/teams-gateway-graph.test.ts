import type { TeamsGatewayGraphContext } from "./teams-gateway-graph.ts";

import { describe, expect, it } from "vitest";
import { TeamsGatewayGraphClient } from "./teams-gateway-graph.ts";

describe("TeamsGatewayGraphClient presence", () => {
  it("addresses presence sessions through the current user ID", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const client = createClient();
    const context = createContext(async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(null, { status: 200 });
    });

    await client.setPresence(context);
    await client.clearPresence(context);

    expect(requests).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/users/agent-user-id/presence/setPresence",
        body: {
          sessionId: "teams-app-id",
          availability: "Available",
          activity: "Available",
          expirationDuration: "PT4H",
        },
      },
      {
        url: "https://graph.microsoft.com/v1.0/users/agent-user-id/presence/clearPresence",
        body: { sessionId: "teams-app-id" },
      },
    ]);
  });

  it("turns a forbidden presence response into setup guidance", async () => {
    const client = createClient();
    const context = createContext(
      async () =>
        new Response(JSON.stringify({ error: { code: "Forbidden", message: "" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(client.setPresence(context)).rejects.toThrow("Reconnect this account with Presence.ReadWrite");
  });
});

function createClient(): TeamsGatewayGraphClient {
  return new TeamsGatewayGraphClient(
    {
      async resolveForExecutionById() {
        throw new Error("Not used by this test.");
      },
    },
    {
      async getConfig() {
        return undefined;
      },
    },
  );
}

function createContext(fetcher: typeof fetch): TeamsGatewayGraphContext {
  return {
    selfId: "agent-user-id",
    selfEmail: "agent@company.test",
    presenceSessionId: "teams-app-id",
    deps: { accessToken: "token", fetcher },
  };
}
