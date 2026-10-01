import type { ExecutionContext, TransitFileWriter } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { setPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { executors } from "./executors.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  setPrivateNetworkAccessAllowed(false);
});

function createContext(maxBytes = 1024, baseUrl = "https://8.8.8.8"): ExecutionContext {
  const transitFiles: TransitFileWriter = {
    maxBytes,
    create: vi.fn(async (file: File) => ({
      fileId: "attachment-1",
      downloadUrl: "/api/files/attachment-1",
      sizeBytes: file.size,
      name: file.name,
      mimeType: file.type,
    })),
    read: vi.fn(),
    delete: vi.fn(),
  };
  return {
    getCredential: async () => ({
      authType: "api_key",
      apiKey: "key",
      values: { baseUrl, apiSecret: "secret" },
      metadata: {},
      profile: { accountId: "user", displayName: "User", grantedScopes: [] },
    }),
    transitFiles,
    signal: new AbortController().signal,
  };
}

describe("ERPNext attachments", () => {
  it.each(["/files/Resume.pdf", "/private/files/Jane Résumé & CV.pdf"])(
    "downloads %s with authentication and preserves binary content",
    async (fileUrl) => {
      const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(bytes, { headers: { "content-type": "application/pdf" } }),
      );
      vi.stubGlobal("fetch", fetcher);
      const context = createContext();

      const result = await executors["erpnext.download_file"]!({ file_url: fileUrl }, context);

      expect(result).toEqual({
        ok: true,
        output: {
          file: {
            fileId: "attachment-1",
            downloadUrl: "/api/files/attachment-1",
            sizeBytes: bytes.length,
            name: fileUrl.slice(fileUrl.lastIndexOf("/") + 1),
            mimeType: "application/pdf",
          },
        },
      });
      const [url, init] = fetcher.mock.calls[0]!;
      expect(new URL(String(url)).pathname).toBe("/api/method/frappe.handler.download_file");
      expect(new URL(String(url)).searchParams.get("file_url")).toBe(fileUrl);
      expect(new Headers(init?.headers).get("authorization")).toBe("token key:secret");
      expect(init?.signal).toBe(context.signal);
      expect(init?.redirect).toBe("error");
      const file = vi.mocked(context.transitFiles!.create).mock.calls[0]![0];
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    },
  );

  it("lists attachments for the requested document with pagination", async () => {
    const attachments = [
      { name: "file-1", file_name: "resume.pdf", file_url: "/private/files/resume.pdf", is_private: 1, file_size: 42 },
    ];
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: attachments }));
    vi.stubGlobal("fetch", fetcher);
    const result = await executors["erpnext.list_document_attachments"]!(
      { doctype: "Job Applicant", name: "APP-1", start: 20, page_length: 10 },
      createContext(),
    );
    expect(result).toEqual({ ok: true, output: { attachments } });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/resource/File");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({
      attached_to_doctype: "Job Applicant",
      attached_to_name: "APP-1",
      is_folder: 0,
    });
    expect(url.searchParams.get("limit_start")).toBe("20");
    expect(url.searchParams.get("limit_page_length")).toBe("10");
  });

  it.each([404, 417])("uses the v13 download method after a method lookup failure (HTTP %s)", async (status) => {
    const message =
      "Failed to get method for command frappe.handler.download_file with module 'frappe.handler' has no attribute 'download_file'";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message })]) },
          { status },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([37, 80, 68, 70, 255]), { headers: { "content-type": "application/pdf" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    const context = createContext();
    const fileUrl = "/private/files/Applicant  Résumé & CV.pdf";

    const result = await executors["erpnext.download_file"]!({ file_url: fileUrl }, context);

    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(new URL(String(url)).pathname).toBe("/api/method/frappe.core.doctype.file.file.download_file");
    expect(new URL(String(url)).searchParams.get("file_url")).toBe(fileUrl);
    expect(new Headers(init?.headers).get("authorization")).toBe("token key:secret");
    expect(init?.signal).toBe(context.signal);
    expect(init?.redirect).toBe("error");
    const file = vi.mocked(context.transitFiles!.create).mock.calls[0]![0];
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70, 255]));
  });

  it.each([404, 417])("retries early v13's Invalid Method response (HTTP %s)", async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            exc_type: "ValidationError",
            _server_messages: JSON.stringify([JSON.stringify({ message: "Invalid Method", raise_exception: 1 })]),
          },
          { status },
        ),
      )
      .mockResolvedValueOnce(new Response("%PDF-resume", { headers: { "content-type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetcher);
    const fileUrl = "/private/files/Applicant Resume.pdf";
    const result = await executors["erpnext.download_file"]!({ file_url: fileUrl }, createContext());
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const url = new URL(String(fetcher.mock.calls[1]![0]));
    expect(url.pathname).toBe("/api/method/frappe.core.doctype.file.file.download_file");
    expect(url.searchParams.get("file_url")).toBe(fileUrl);
  });

  it("does not loop if both download endpoints report Invalid Method", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ message: "Invalid Method" }, { status: 417 }));
    vi.stubGlobal("fetch", fetcher);
    const context = createContext();
    const result = await executors["erpnext.download_file"]!({ file_url: "/private/files/resume.pdf" }, context);
    expect(result.error?.message).toBe("Invalid Method");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(context.transitFiles!.create).not.toHaveBeenCalled();
  });

  it.each([403, 404, 417, 429])("does not retry ordinary errors and exposes their detail (HTTP %s)", async (status) => {
    const message = status === 403 ? "Not permitted to read this file" : "The requested file is unavailable";
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          exc_type: "ValidationError",
          _server_messages: JSON.stringify([JSON.stringify({ message })]),
        },
        { status },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const context = createContext();
    const result = await executors["erpnext.download_file"]!({ file_url: "/private/files/resume.pdf" }, context);
    expect(result.error?.message).toBe(message);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(context.transitFiles!.create).not.toHaveBeenCalled();
  });

  it("surfaces a legacy endpoint failure without retrying again", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            exception:
              "Failed to get method for command frappe.handler.download_file with module 'frappe.handler' has no attribute 'download_file'",
          },
          { status: 417 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ exception: "FileNotFoundError: File not found on disk" }, { status: 500 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const context = createContext();
    const result = await executors["erpnext.download_file"]!({ file_url: "/private/files/resume.pdf" }, context);
    expect(result.error?.message).toBe("FileNotFoundError: File not found on disk");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(context.transitFiles!.create).not.toHaveBeenCalled();
  });

  it("preserves Frappe permission errors without storing the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ exception: "frappe.exceptions.PermissionError" }, { status: 403 })),
    );
    const context = createContext();
    const result = await executors["erpnext.download_file"]!({ file_url: "/private/files/resume.pdf" }, context);
    expect(result.error).toMatchObject({ code: "authorization_failed", message: "frappe.exceptions.PermissionError" });
    expect(context.transitFiles!.create).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects oversized files (content-length: %s)", async (withLength) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(5), { headers: withLength ? { "content-length": "5" } : {} })),
    );
    const context = createContext(4);
    const result = await executors["erpnext.download_file"]!({ file_url: "/files/resume.pdf" }, context);
    expect(result.error).toMatchObject({ code: "invalid_input", details: { status: 413 } });
    expect(context.transitFiles!.create).not.toHaveBeenCalled();
  });

  it("requires temporary file storage before requesting a download", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const context = createContext();
    delete context.transitFiles;
    const result = await executors["erpnext.download_file"]!({ file_url: "/files/resume.pdf" }, context);
    expect(result.error?.message).toBe("Transit file storage is not enabled.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects external download URLs before sending credentials", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await executors["erpnext.download_file"]!(
      { file_url: "https://other.example/resume.pdf" },
      createContext(),
    );
    expect(result.error?.code).toBe("invalid_input");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("downloads through the configured private instance only with the deployment opt-in", async () => {
    const fetcher = vi.fn(async () => new Response("resume"));
    vi.stubGlobal("fetch", fetcher);
    const context = createContext(1024, "https://10.0.0.8");
    expect((await executors["erpnext.download_file"]!({ file_url: "/private/files/resume.pdf" }, context)).ok).toBe(
      false,
    );
    expect(fetcher).not.toHaveBeenCalled();
    setPrivateNetworkAccessAllowed(true);
    expect((await executors["erpnext.download_file"]!({ file_url: "/private/files/resume.pdf" }, context)).ok).toBe(
      true,
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
