import type { CredentialValidationResult } from "../../core/types.ts";

import { optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  createProviderTimeout,
  isAbortLikeError,
  ProviderRequestError,
  providerUserAgent,
  readProviderJsonBody,
} from "../provider-runtime.ts";

export interface ProxmoxContext {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

interface ProxmoxTask {
  node: string;
  vmid: unknown;
  upid: string;
}

type ProxmoxHandler = (input: Record<string, unknown>, context: ProxmoxContext) => Promise<unknown>;

/** Normalize a node origin or API root without allowing credentials or arbitrary endpoint paths. */
export function normalizeProxmoxBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  const url = assertPublicHttpUrl(requiredString(value, "baseUrl"), {
    fieldName: "baseUrl",
    allowPrivateNetwork,
    createError: (message) => new ProviderRequestError(400, message),
  });
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "baseUrl must not include credentials, query parameters, or a fragment");
  }
  if (!["", "/api2/json"].includes(url.pathname.replace(/\/+$/u, ""))) {
    throw new ProviderRequestError(400, "baseUrl must be a cluster origin or end in /api2/json");
  }
  return `${url.origin}/api2/json`;
}

export function createProxmoxContext(
  values: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): ProxmoxContext {
  const tokenId = requiredString(values.tokenId, "tokenId");
  const tokenSecret = requiredString(values.tokenSecret, "tokenSecret");
  if (!/^[^\s@!=]+@[^\s@!=]+![A-Za-z0-9._-]+$/u.test(tokenId)) {
    throw new ProviderRequestError(400, "tokenId must have the form user@realm!token-name");
  }
  if (/[\s=]/u.test(tokenSecret)) throw new ProviderRequestError(400, "tokenSecret must not contain whitespace or =");
  return { baseUrl: normalizeProxmoxBaseUrl(values.baseUrl), tokenId, tokenSecret, fetcher, signal };
}

export async function validateProxmoxCredential(context: ProxmoxContext): Promise<CredentialValidationResult> {
  // /version can be public. This authenticated endpoint verifies even tokens with narrowly scoped ACLs.
  await requestProxmox(context, "GET", "/access/permissions");
  const host = new URL(context.baseUrl).host;
  return { profile: { accountId: `${host}:${context.tokenId}`, displayName: `${host} (${context.tokenId})` } };
}

function pathSegment(value: unknown, field: string): string {
  const text = requiredString(value, field);
  if (text === "." || text === ".." || /[/\\%?#\s]/u.test(text)) {
    throw new ProviderRequestError(400, `${field} must be a single path segment`);
  }
  return encodeURIComponent(text);
}

function nodePath(input: Record<string, unknown>): string {
  return `/nodes/${pathSegment(input.node, "node")}`;
}

function vmPath(input: Record<string, unknown>): string {
  if (!Number.isInteger(input.vmid) || Number(input.vmid) < 100 || Number(input.vmid) > 999999999) {
    throw new ProviderRequestError(400, "vmid must be an integer between 100 and 999999999");
  }
  return `${nodePath(input)}/qemu/${input.vmid}`;
}

function vmFields(input: Record<string, unknown>): Record<string, unknown> {
  const { node: _node, vmid: _vmid, ...fields } = input;
  // The action schema restricts the supported fields before execution.
  if (fields.sshkeys !== undefined) fields.sshkeys = encodeURIComponent(requiredString(fields.sshkeys, "sshkeys"));
  return fields;
}

async function requestProxmox(
  context: ProxmoxContext,
  method: string,
  path: string,
  fields: Record<string, unknown> = {},
): Promise<unknown> {
  const url = new URL(`${context.baseUrl}${path}`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  if (method === "GET") url.search = params.toString();
  const timeout = createProviderTimeout(context.signal, 60_000);
  try {
    const response = await context.fetcher(url, {
      method,
      headers: {
        authorization: `PVEAPIToken=${context.tokenId}=${context.tokenSecret}`,
        accept: "application/json",
        "user-agent": providerUserAgent,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: method === "GET" ? undefined : params.toString(),
      // A reverse-proxy redirect must never forward a token or replay provisioning to another host.
      redirect: "manual",
      signal: timeout.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ProviderRequestError(502, "Proxmox redirected the request. Configure the final cluster URL.");
    }
    const payload = optionalRecord(
      await readProviderJsonBody(response, {
        emptyBody: {},
        invalidJsonMessage: "Proxmox returned invalid JSON",
        maxBytes: 4 * 1024 * 1024,
        invalidJsonFallback: response.ok ? undefined : () => ({}),
      }),
    );
    if (!response.ok) {
      const detail = optionalString(payload?.message);
      const message = detail
        ?.replaceAll(context.tokenSecret, "[redacted]")
        .replaceAll(context.tokenId, "[redacted]")
        .slice(0, 1000);
      throw new ProviderRequestError(
        response.status,
        message ? `Proxmox: ${message}` : `Proxmox request failed (HTTP ${response.status})`,
      );
    }
    if (!payload || !Object.hasOwn(payload, "data"))
      throw new ProviderRequestError(502, "Proxmox response is missing data");
    return payload.data;
  } catch (error) {
    if (timeout.didTimeout() || isAbortLikeError(error)) {
      throw new ProviderRequestError(
        504,
        "Proxmox request was interrupted. A submitted task may still be running; inspect the VM before retrying.",
      );
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

async function submitTask(
  context: ProxmoxContext,
  path: string,
  fields: Record<string, unknown>,
  vmid: unknown,
): Promise<ProxmoxTask> {
  const result = await requestProxmox(context, "POST", path, fields);
  if (typeof result !== "string" || !result.startsWith("UPID:"))
    throw new ProviderRequestError(502, "Proxmox did not return a task UPID");
  const taskNode = result.split(":")[1];
  if (!taskNode) throw new ProviderRequestError(502, "Proxmox returned an invalid task UPID");
  return { node: taskNode, vmid, upid: result };
}

export const proxmoxHandlers: Record<string, ProxmoxHandler> = {
  async list_nodes(_input, context) {
    return { nodes: await requestProxmox(context, "GET", "/nodes") };
  },
  async list_resources(input, context) {
    return { resources: await requestProxmox(context, "GET", "/cluster/resources", { type: input.type }) };
  },
  async list_storage(input, context) {
    return { storage: await requestProxmox(context, "GET", `${nodePath(input)}/storage`, { content: input.content }) };
  },
  async list_storage_content(input, context) {
    return {
      volumes: await requestProxmox(
        context,
        "GET",
        `${nodePath(input)}/storage/${pathSegment(input.storage, "storage")}/content`,
        { content: input.content },
      ),
    };
  },
  async list_networks(input, context) {
    return { interfaces: await requestProxmox(context, "GET", `${nodePath(input)}/network`) };
  },
  async get_next_vmid(_input, context) {
    const vmid = Number(await requestProxmox(context, "GET", "/cluster/nextid"));
    if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999999999)
      throw new ProviderRequestError(502, "Proxmox returned an invalid VM ID");
    return { vmid };
  },
  async create_vm(input, context) {
    vmPath(input);
    return submitTask(context, `${nodePath(input)}/qemu`, { ...vmFields(input), vmid: input.vmid }, input.vmid);
  },
  async clone_vm(input, context) {
    if (input.newid === input.vmid) throw new ProviderRequestError(400, "newid must differ from the source vmid");
    if (input.full === false && input.storage !== undefined)
      throw new ProviderRequestError(400, "storage can only be selected for a full clone");
    const fields = { ...vmFields(input), full: input.full ?? true };
    const task = await submitTask(context, `${vmPath(input)}/clone`, fields, input.newid);
    return { ...task, targetNode: input.target ?? input.node };
  },
  async get_vm_config(input, context) {
    return { config: await requestProxmox(context, "GET", `${vmPath(input)}/config`) };
  },
  async update_vm_config(input, context) {
    const fields = vmFields(input);
    if (!Object.keys(fields).some((key) => key !== "digest"))
      throw new ProviderRequestError(400, "Supply at least one configuration change");
    await requestProxmox(context, "PUT", `${vmPath(input)}/config`, fields);
    return { node: input.node, vmid: input.vmid, updated: true };
  },
  async get_vm_status(input, context) {
    return { status: await requestProxmox(context, "GET", `${vmPath(input)}/status/current`) };
  },
  async start_vm(input, context) {
    return submitTask(context, `${vmPath(input)}/status/start`, {}, input.vmid);
  },
  async shutdown_vm(input, context) {
    return submitTask(
      context,
      `${vmPath(input)}/status/shutdown`,
      { timeout: input.timeout, forceStop: false },
      input.vmid,
    );
  },
  async get_task_status(input, context) {
    return {
      task: await requestProxmox(context, "GET", `${nodePath(input)}/tasks/${pathSegment(input.upid, "upid")}/status`),
    };
  },
  async get_task_log(input, context) {
    return {
      lines: await requestProxmox(context, "GET", `${nodePath(input)}/tasks/${pathSegment(input.upid, "upid")}/log`, {
        start: input.start,
        limit: input.limit ?? 50,
      }),
    };
  },
};
