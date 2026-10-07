import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { setPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch } from "../provider-runtime.ts";
import { credentialValidators } from "./executors.ts";
import { createProxmoxContext, normalizeProxmoxBaseUrl, proxmoxHandlers } from "./runtime.ts";

const values = {
  baseUrl: "https://pve.example.com:8006",
  tokenId: "automation@pve!connector",
  tokenSecret: "test-token-secret",
};
const upid = "UPID:pve1:00000001:00000002:00000003:qmcreate:101:automation@pve!connector:";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setDefaultGuardedFetchDnsLookup(undefined);
  setPrivateNetworkAccessAllowed(false);
});

describe("Proxmox provisioning", () => {
  it("uses API token auth and form encoding without auto-starting or retrying creation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: upid }));
    const context = createProxmoxContext(values, fetcher);
    const key = "ssh-ed25519 AAAA+BBBB/CCCC= test@example.com\nssh-ed25519 DDDD second";
    const output = await proxmoxHandlers.create_vm!(
      { node: "pve1", vmid: 101, name: "test-vm", memory: 2048, onboot: false, sshkeys: key, scsi0: "local-lvm:32" },
      context,
    );
    expect(output).toEqual({ node: "pve1", vmid: 101, upid });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${values.baseUrl}/api2/json/nodes/pve1/qemu`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`PVEAPIToken=${values.tokenId}=${values.tokenSecret}`);
    expect(init?.redirect).toBe("manual");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("sshkeys")).toBe(encodeURIComponent(key));
    expect(body.get("memory")).toBe("2048");
    expect(body.get("onboot")).toBe("0");
    expect(body.has("start")).toBe(false);
    expect(body.has("node")).toBe(false);
  });

  it("keeps task polling on the source node for a cross-node full clone", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: upid }));
    const output = await proxmoxHandlers.clone_vm!(
      { node: "pve1", vmid: 900, newid: 101, name: "clone", target: "pve2" },
      createProxmoxContext(values, fetcher),
    );
    expect(output).toEqual({ node: "pve1", targetNode: "pve2", vmid: 101, upid });
    expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body)).get("full")).toBe("1");
  });

  it("preserves task failure status instead of treating stopped as success", async () => {
    const task = { node: "pve1", upid, status: "stopped", exitstatus: "disk allocation failed" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: task }));
    expect(
      await proxmoxHandlers.get_task_status!({ node: "pve1", upid }, createProxmoxContext(values, fetcher)),
    ).toEqual({ task });
    expect(String(fetcher.mock.calls[0]![0])).toContain(`/tasks/${encodeURIComponent(upid)}/status`);
  });

  it("sends configuration digests and accepts the null update response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: null }));
    const result = await proxmoxHandlers.update_vm_config!(
      { node: "pve1", vmid: 101, memory: 4096, digest: "previous-digest" },
      createProxmoxContext(values, fetcher),
    );
    expect(result).toEqual({ node: "pve1", vmid: 101, updated: true });
    expect(fetcher.mock.calls[0]![1]?.method).toBe("PUT");
    expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body)).get("digest")).toBe("previous-digest");
  });

  it("rejects ambiguous task responses and normalizes nextid strings", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: "101" }))
      .mockResolvedValueOnce(Response.json({ data: null }));
    const context = createProxmoxContext(values, fetcher);
    expect(await proxmoxHandlers.get_next_vmid!({}, context)).toEqual({ vmid: 101 });
    await expect(proxmoxHandlers.start_vm!({ node: "pve1", vmid: 101 }, context)).rejects.toThrow("task UPID");
  });

  it("does not follow redirects carrying tokens or replay a VM creation", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.example.com" } }));
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    const context = createProxmoxContext(values, createProviderFetch({ fetch: transport }));
    await expect(proxmoxHandlers.create_vm!({ node: "pve1", vmid: 101, name: "test" }, context)).rejects.toThrow(
      "redirected",
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects path traversal before sending a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const context = createProxmoxContext(values, fetcher);
    for (const node of ["..", "%2e%2e", "pve1/../../access", "pve1?test"]) {
      await expect(proxmoxHandlers.list_storage!({ node }, context)).rejects.toThrow("path segment");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts credentials from upstream errors and preserves authorization status", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: `bad ${values.tokenId}=${values.tokenSecret}` }, { status: 403 }));
    await expect(proxmoxHandlers.list_nodes!({}, createProxmoxContext(values, fetcher))).rejects.toMatchObject({
      status: 403,
      message: "Proxmox: bad [redacted]=[redacted]",
    });
  });

  it("propagates cancellation without retrying a submitted operation", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      abort.abort();
      init?.signal?.throwIfAborted();
      throw new Error("Expected an abort");
    });
    await expect(
      proxmoxHandlers.start_vm!({ node: "pve1", vmid: 101 }, createProxmoxContext(values, fetcher, abort.signal)),
    ).rejects.toMatchObject({ status: 504 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("Proxmox credentials and egress", () => {
  it("normalizes the API root and rejects unsafe or ambiguous URLs", () => {
    expect(normalizeProxmoxBaseUrl(`${values.baseUrl}/api2/json/`)).toBe(`${values.baseUrl}/api2/json`);
    for (const url of [
      "ftp://pve.example.com",
      "https://user:password@pve.example.com",
      "https://pve.example.com/api2/json/nodes",
      "https://pve.example.com?token=test",
      "https://127.0.0.1:8006",
      "https://169.254.169.254",
    ]) {
      expect(() => normalizeProxmoxBaseUrl(url, true)).toThrow();
    }
    expect(() => normalizeProxmoxBaseUrl("https://10.0.0.10:8006", false)).toThrow();
    expect(normalizeProxmoxBaseUrl("https://10.0.0.10:8006", true)).toBe("https://10.0.0.10:8006/api2/json");
    expect(normalizeProxmoxBaseUrl("http://pve.example.com")).toBe("http://pve.example.com/api2/json");
  });

  it("allows HTTP over Tailscale only when private-network access is enabled", async () => {
    const tailnetValues = { ...values, baseUrl: "http://100.100.10.20:8080" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: {} }));
    setPrivateNetworkAccessAllowed(false);
    expect(() => credentialValidators.customCredential!({ values: tailnetValues }, { fetcher })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    setPrivateNetworkAccessAllowed(true);
    await expect(credentialValidators.customCredential!({ values: tailnetValues }, { fetcher })).resolves.toBeDefined();
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://100.100.10.20:8080/api2/json/access/permissions");
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      `PVEAPIToken=${values.tokenId}=${values.tokenSecret}`,
    );
  });

  it("checks effective token permissions on an authenticated endpoint", async () => {
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: {} }));
    const result = await credentialValidators.customCredential!({ values }, { fetcher });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${values.baseUrl}/api2/json/access/permissions`);
    expect(result?.profile?.accountId).toBe(`pve.example.com:8006:${values.tokenId}`);
    expect(JSON.stringify(result)).not.toContain(values.tokenSecret);
  });

  it("keeps DNS checks active and applies private-network opt-in to validation", async () => {
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "10.0.0.10", family: 4 }]);
    setPrivateNetworkAccessAllowed(false);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: {} }));
    await expect(credentialValidators.customCredential!({ values }, { fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    setPrivateNetworkAccessAllowed(true);
    await expect(credentialValidators.customCredential!({ values }, { fetcher })).resolves.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
