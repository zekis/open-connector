import { describe, expect, it, vi } from "vitest";
import {
  appendObsidianNote,
  normalizeObsidianApiBaseUrl,
  prependObsidianNote,
  searchObsidianNotes,
  validateObsidianCredential,
  writeObsidianNote,
} from "./runtime.ts";

describe("Obsidian REST runtime", () => {
  it("normalizes instance roots and API URLs", () => {
    expect(normalizeObsidianApiBaseUrl("https://notes.example.com", false)).toBe("https://notes.example.com/api/v1");
    expect(normalizeObsidianApiBaseUrl("https://notes.example.com/obsidian/api/v1/", false)).toBe(
      "https://notes.example.com/obsidian/api/v1",
    );
  });

  it("keeps large append and prepend continuations inline and ordered", async () => {
    const content = `${"A".repeat(1_499)}\n${"B".repeat(20)}`;
    for (const mutation of [
      {
        handler: appendObsidianNote,
        firstContent: "A".repeat(1_499),
        secondContent: `\\n${"B".repeat(20)}`,
      },
      {
        handler: prependObsidianNote,
        firstContent: `\\n${"B".repeat(20)}`,
        secondContent: "A".repeat(1_499),
      },
    ]) {
      const fetcher = createCommandFetch();
      const context = {
        apiKey: "test-api-key",
        apiBaseUrl: "https://notes.example.com/api/v1",
        vault: "Projects",
        fetcher,
      };

      await mutation.handler({ path: "Projects/Large.md", content }, context);

      const calls = vi.mocked(fetcher).mock.calls;
      expect(calls).toHaveLength(2);
      expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({
        vault: "Projects",
        params: { path: "Projects/Large.md", content: mutation.firstContent },
      });
      expect(JSON.parse(String(calls[1]![1]?.body))).toEqual({
        vault: "Projects",
        params: { path: "Projects/Large.md", content: mutation.secondContent },
        flags: ["inline"],
      });
    }
  });

  it("requires the private-network opt-in for Tailscale addresses", () => {
    expect(() => normalizeObsidianApiBaseUrl("http://100.87.172.90:27124", false)).toThrow();
    expect(normalizeObsidianApiBaseUrl("http://100.87.172.90:27124", true)).toBe("http://100.87.172.90:27124/api/v1");
  });

  it("validates credentials against the selected vault", async () => {
    const fetcher = createJsonFetch({
      ok: true,
      command: "vault",
      exitCode: 0,
      stdout: "Projects\n",
      stderr: "",
      duration: 14,
    });

    const result = await validateObsidianCredential(
      { baseUrl: "https://notes.example.com", vault: "Projects" },
      "test-api-key",
      fetcher,
    );

    expect(result.profile).toEqual({
      accountId: "https://notes.example.com/api/v1#Projects",
      displayName: "Obsidian · Projects",
    });
    expect(result.metadata).toMatchObject({
      apiBaseUrl: "https://notes.example.com/api/v1",
      vaultName: "Projects",
    });
    const [input, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(input instanceof Request ? input.url : input.toString()).searchParams.get("vault")).toBe("Projects");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-api-key");
  });

  it("maps a typed search onto JSON CLI output", async () => {
    const fetcher = createJsonFetch({
      ok: true,
      command: "search",
      exitCode: 0,
      stdout: '["Projects/One.md","Projects/Two.md"]\n',
      stderr: "",
      duration: 23,
    });
    const context = {
      apiKey: "test-api-key",
      apiBaseUrl: "https://notes.example.com/api/v1",
      vault: "Projects",
      fetcher,
    };

    const result = await searchObsidianNotes(
      { query: "roadmap", folder: "Projects", limit: 2, caseSensitive: true },
      context,
    );

    expect(result).toEqual({
      matches: ["Projects/One.md", "Projects/Two.md"],
      total: 2,
      durationMs: 23,
    });
    const [input] = vi.mocked(fetcher).mock.calls[0]!;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.pathname).toBe("/api/v1/cli/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      vault: "Projects",
      query: "roadmap",
      format: "json",
      path: "Projects",
      limit: "2",
      flags: "case",
    });
  });

  it("writes complete content with the overwrite flag", async () => {
    const fetcher = createJsonFetch({
      ok: true,
      command: "create",
      exitCode: 0,
      stdout: "Created Projects/Roadmap.md\n",
      stderr: "",
      duration: 31,
    });
    const context = {
      apiKey: "test-api-key",
      apiBaseUrl: "https://notes.example.com/api/v1",
      vault: "Projects",
      fetcher,
    };

    const result = await writeObsidianNote({ path: "Projects/Roadmap.md", content: "# Roadmap\n" }, context);

    expect(result).toEqual({ path: "Projects/Roadmap.md", message: "Created Projects/Roadmap.md", durationMs: 31 });
    const [input, init] = vi.mocked(fetcher).mock.calls[0]!;
    expect(new URL(input instanceof Request ? input.url : input.toString()).pathname).toBe("/api/v1/cli/create");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      vault: "Projects",
      params: { path: "Projects/Roadmap.md", content: "# Roadmap\\n" },
      flags: ["overwrite"],
    });
  });

  it("splits large writes into inline continuation commands", async () => {
    const fetcher = vi.fn(async (input: URL | RequestInfo): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const command = url.pathname.split("/").pop()!;
      return new Response(
        JSON.stringify({
          ok: true,
          command,
          exitCode: 0,
          stdout: `${command === "create" ? "Created" : "Appended to"} Projects/Large.md\n`,
          stderr: "",
          duration: 12,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const context = {
      apiKey: "test-api-key",
      apiBaseUrl: "https://notes.example.com/api/v1",
      vault: "Projects",
      fetcher,
    };
    const content = `${"A".repeat(1_499)}\n${"B".repeat(20)}`;

    const result = await writeObsidianNote({ path: "Projects/Large.md", content }, context);

    expect(result).toEqual({
      path: "Projects/Large.md",
      message: "Created Projects/Large.md",
      durationMs: 24,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(fetcher).mock.calls;
    const firstUrl = new URL(calls[0]![0] instanceof Request ? calls[0]![0].url : calls[0]![0].toString());
    const secondUrl = new URL(calls[1]![0] instanceof Request ? calls[1]![0].url : calls[1]![0].toString());
    const firstBody = JSON.parse(String(calls[0]![1]?.body));
    const secondBody = JSON.parse(String(calls[1]![1]?.body));
    expect(firstUrl.pathname).toBe("/api/v1/cli/create");
    expect(firstBody).toEqual({
      vault: "Projects",
      params: { path: "Projects/Large.md", content: "A".repeat(1_499) },
      flags: ["overwrite"],
    });
    expect(secondUrl.pathname).toBe("/api/v1/cli/append");
    expect(secondBody).toEqual({
      vault: "Projects",
      params: { path: "Projects/Large.md", content: `\\n${"B".repeat(20)}` },
      flags: ["inline"],
    });
  });
});

function createJsonFetch(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async (): Promise<Response> => {
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function createCommandFetch(): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const command = url.pathname.split("/").pop()!;
    return new Response(
      JSON.stringify({
        ok: true,
        command,
        exitCode: 0,
        stdout: `${command} completed\n`,
        stderr: "",
        duration: 12,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}
