import type { EverythingActionContext } from "./runtime.ts";

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { everythingActionHandlers, everythingFileUrl, normalizeEverythingBaseUrl } from "./runtime.ts";

describe("Everything runtime", () => {
  it("allows an opted-in Tailscale HTTP Server but rejects it by default", () => {
    expect(() => normalizeEverythingBaseUrl("http://100.87.172.90:8686")).toThrow(/private or reserved/u);
    expect(normalizeEverythingBaseUrl("http://100.87.172.90:8686/", true)).toBe("http://100.87.172.90:8686");
  });

  it("searches with Everything options and normalizes paths and Windows timestamps", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("search")).toBe("claim ext:xlsx");
      expect(url.searchParams.get("count")).toBe("25");
      expect(url.searchParams.get("path_column")).toBe("1");
      expect(url.searchParams.get("date_modified_column")).toBe("1");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("bishop:secret").toString("base64")}`,
      );
      return Response.json({
        totalResults: 1,
        results: [
          {
            type: "file",
            name: "Payment Claim.xlsx",
            path: "C:\\Reports",
            size: "63475",
            date_modified: "134334720000000000",
          },
        ],
      });
    });
    const context = createContext(fetcher);

    const output = await everythingActionHandlers.search_files({ query: "claim ext:xlsx", count: 25 }, context);

    expect(output).toEqual({
      totalResults: 1,
      offset: 0,
      returnedResults: 1,
      results: [
        {
          type: "file",
          name: "Payment Claim.xlsx",
          path: "C:\\Reports",
          fullPath: "C:\\Reports\\Payment Claim.xlsx",
          sizeBytes: 63475,
          dateModified: "2026-09-10T00:00:00.000Z",
        },
      ],
    });
  });

  it("downloads an indexed path into bounded transit storage", async () => {
    const create = vi.fn(async (file: File) => ({
      fileId: "file-1",
      downloadUrl: "/api/files/file-1",
      sizeBytes: file.size,
      name: file.name,
      mimeType: file.type,
    }));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).pathname).toBe("/C%3A/Reports/Claim%20%231.xlsx");
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
    });
    const context = createContext(fetcher, {
      maxBytes: 1024,
      create,
      async read() {
        throw new Error("not used");
      },
      async delete() {
        return false;
      },
    });

    const output = await everythingActionHandlers.download_file({ path: "C:\\Reports\\Claim #1.xlsx" }, context);

    expect(output).toEqual({
      sourcePath: "C:\\Reports\\Claim #1.xlsx",
      file: {
        fileId: "file-1",
        downloadUrl: "/api/files/file-1",
        sizeBytes: 3,
        name: "Claim #1.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("encodes UNC paths in the form used by the official HTTP Server", () => {
    expect(everythingFileUrl("http://everything.example:8686", "\\\\server\\share\\Report 1.pdf").pathname).toBe(
      "/%5C%5Cserver/share/Report%201.pdf",
    );
  });
});

function createContext(
  fetcher: typeof fetch,
  transitFiles?: EverythingActionContext["transitFiles"],
): EverythingActionContext {
  return {
    baseUrl: "https://everything.example:8686",
    username: "bishop",
    password: "secret",
    fetcher,
    transitFiles,
  };
}
