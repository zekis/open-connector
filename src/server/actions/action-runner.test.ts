import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type {
  ActionDefinition,
  ActionExecutor,
  ProviderDefinition,
  RecipientResolver,
  ResolvedCredential,
} from "../../core/types.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { ConnectionApprovalService } from "../approvals/connection-approval-service.ts";
import type { Logger } from "../logger.ts";
import type { IRunLogStore, RunLog, RunLogListInput, RunLogPage } from "../storage/runtime-store.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { ActionPolicyService } from "../../core/action-policy.ts";
import { ActionRunner } from "./action-runner.ts";
import * as runLogSummary from "./run-log-summary.ts";

const echoAction: ActionDefinition = {
  id: "example.echo",
  service: "example",
  name: "echo",
  description: "Echo input.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

const sendAction: ActionDefinition = {
  id: "example.send",
  service: "example",
  name: "send",
  description: "Send an email.",
  requiredScopes: [],
  providerPermissions: [],
  inputSchema: { type: "object", properties: { to: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object" },
  sendsMail: true,
};

const exampleProvider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: ["Developer Tools"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: [echoAction, sendAction],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActionRunner", () => {
  it("uses one execution id across logs, storage, and the result", async () => {
    const runs = new MemoryRunLogStore();
    const { entries, logger } = createTestLogger();
    const runner = createRunner({ runs, logger });

    const run = await runner.run({
      actionId: "example.echo",
      input: { message: "hello", token: "secret" },
      caller: "http",
    });

    expect(run).toMatchObject({ auditPersisted: true, result: { ok: true } });
    expect(runs.items).toEqual([
      expect.objectContaining({
        id: run?.executionId,
        connectionId: "example:default",
        inputSummary: { message: "hello", token: "[redacted]" },
        outputSummary: { message: "ok" },
      }),
    ]);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fields: expect.objectContaining({ executionId: run?.executionId }) }),
        expect.objectContaining({
          fields: expect.objectContaining({ executionId: run?.executionId, auditPersisted: true }),
        }),
      ]),
    );
  });

  it("does not replace a successful action result when audit storage fails", async () => {
    const runs = new MemoryRunLogStore();
    runs.addError = new Error("secret-in-storage");
    const { entries, logger } = createTestLogger();
    const runner = createRunner({ runs, logger });

    const run = await runner.run({ actionId: "example.echo", input: {}, caller: "mcp" });

    expect(run).toMatchObject({
      auditPersisted: false,
      result: { ok: true, output: { message: "ok" } },
    });
    expect(JSON.stringify(entries)).not.toContain("secret-in-storage");
  });

  it("falls back to an unavailable summary without changing the action result", async () => {
    vi.spyOn(runLogSummary, "summarizeForRunLog").mockImplementationOnce(() => {
      throw new Error("secret-in-summary");
    });
    const runs = new MemoryRunLogStore();
    const { entries, logger } = createTestLogger();
    const runner = createRunner({ runs, logger });

    const run = await runner.run({ actionId: "example.echo", input: {}, caller: "web" });

    expect(run?.result).toEqual({ ok: true, output: { message: "ok" } });
    expect(runs.items[0]).toMatchObject({ inputSummary: "[unavailable]" });
    expect(JSON.stringify(entries)).not.toContain("secret-in-summary");
  });

  it("records unexpected execution errors as internal errors without logging the thrown value", async () => {
    const runs = new MemoryRunLogStore();
    const { entries, logger } = createTestLogger();
    const runner = createRunner({
      runs,
      logger,
      providerLoader: new TestProviderLoader(async () => {
        throw new Error("secret-in-executor");
      }),
    });

    const run = await runner.run({ actionId: "example.echo", input: {}, caller: "http" });

    expect(run?.result).toEqual({
      ok: false,
      error: { code: "internal_error", message: "Action execution failed unexpectedly." },
    });
    expect(runs.items[0]).toMatchObject({ ok: false, errorCode: "internal_error" });
    expect(JSON.stringify(entries)).not.toContain("secret-in-executor");
  });

  it("records policy denial before resolving a connection or loading an executor", async () => {
    const runs = new MemoryRunLogStore();
    const { logger } = createTestLogger();
    const providerLoader = new TestProviderLoader(async () => ({ ok: true, output: {} }));
    const loadExecutor = vi.spyOn(providerLoader, "loadActionExecutor");
    const resolveConnection = vi.spyOn(ConnectionService.prototype, "resolveForExecution");
    const actionPolicy = new ActionPolicyService({ blockedActions: ["example.echo"] });
    const runner = createRunner({ runs, logger, providerLoader, actionPolicy });

    const run = await runner.run({
      actionId: "example.echo",
      input: {},
      caller: "http",
      policy: actionPolicy.createSnapshot(),
      runtimeTokenId: "token-1",
    });

    expect(run).toMatchObject({
      result: { ok: false, error: { code: "action_blocked" } },
      auditPersisted: true,
    });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(loadExecutor).not.toHaveBeenCalled();
    expect(runs.items[0]).toMatchObject({
      runtimeTokenId: "token-1",
      policy: {
        allowed: false,
        checks: [{ source: "deployment", outcome: "block_match", rule: "example.echo" }],
      },
    });
  });

  it.each(["http", "mcp"] as const)(
    "enforces connection-scoped rules before approval and execution for %s",
    async (caller) => {
      const runs = new MemoryRunLogStore();
      const { logger } = createTestLogger();
      const requestAction = vi.fn().mockResolvedValue({ allowed: true });
      const executor = vi.fn(async () => ({ ok: true as const, output: {} }));
      const runner = createRunner({
        runs,
        logger,
        providerLoader: new TestProviderLoader(executor),
        approvals: { requestAction },
      });
      const policy = new ActionPolicyService().createSnapshot(undefined, {
        allowedActions: ["example.*@example:shared"],
        blockedActions: [],
        allowedProxies: [],
        allowedRecipients: [],
      });
      const denied = await runner.run({ actionId: echoAction.id, input: {}, caller, policy });
      expect(denied?.result).toMatchObject({ ok: false, error: { code: "action_not_allowed" } });
      expect(requestAction).not.toHaveBeenCalled();
      expect(executor).not.toHaveBeenCalled();
      const allowed = await runner.run({
        actionId: echoAction.id,
        input: {},
        caller,
        policy,
        connectionName: "shared",
      });
      expect(allowed?.result.ok).toBe(true);
      expect(executor).toHaveBeenCalledOnce();
      expect(runs.items[0]?.policy).toMatchObject({ allowed: false });
    },
  );

  it("queues globally gated actions before loading an executor and exposes the pending approval", async () => {
    const runs = new MemoryRunLogStore();
    const { logger } = createTestLogger();
    const providerLoader = new TestProviderLoader(async () => ({ ok: true, output: {} }));
    const loadExecutor = vi.spyOn(providerLoader, "loadActionExecutor");
    const requestAction = vi.fn().mockResolvedValue({
      allowed: false,
      approval: {
        id: "approval-1",
        status: "pending",
        actionId: echoAction.id,
        connectionId: "example:default",
        caller: "chat",
        input: { message: "hello" },
        requestHash: "hash-1",
        requestedAt: "2026-08-05T00:00:00.000Z",
      },
    });
    const runner = createRunner({ runs, logger, providerLoader, approvals: { requestAction } });

    const run = await runner.run({
      actionId: echoAction.id,
      input: { message: "hello" },
      caller: "chat",
    });

    expect(run?.result).toEqual({
      ok: false,
      error: {
        code: "approval_pending",
        message: "example.echo was queued and is pending approval for Example Public.",
        details: {
          approvalId: "approval-1",
          status: "pending",
          queued: true,
          actionId: echoAction.id,
          connectionId: "example:default",
        },
      },
    });
    expect(requestAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: echoAction.id, caller: "chat", input: { message: "hello" } }),
    );
    expect(loadExecutor).not.toHaveBeenCalled();
    expect(runs.items[0]).toMatchObject({ ok: false, errorCode: "approval_pending" });
  });

  describe("recipient policy", () => {
    const actionPolicy = new ActionPolicyService({ allowedRecipients: ["@tierneymorris.com.au"] });
    const resolveTo: RecipientResolver = async (input) => (input as { to: string[] }).to;

    it("leaves mail-sending actions alone when no recipient policy is configured", async () => {
      const resolver = vi.fn(resolveTo);
      const executor = vi.fn(async () => ({ ok: true as const, output: {} }));
      const runner = createRunner({
        runs: new MemoryRunLogStore(),
        logger: createTestLogger().logger,
        providerLoader: new TestProviderLoader(executor, resolver),
        actionPolicy: new ActionPolicyService(),
      });

      const run = await runner.run({ actionId: sendAction.id, input: { to: ["anyone@example.com"] }, caller: "mcp" });

      expect(run?.result.ok).toBe(true);
      expect(resolver).not.toHaveBeenCalled();
      expect(executor).toHaveBeenCalledOnce();
    });

    it("sends when every recipient is allowed and refuses before approval or execution otherwise", async () => {
      const runs = new MemoryRunLogStore();
      const requestAction = vi.fn().mockResolvedValue({ allowed: true });
      const executor = vi.fn(async () => ({ ok: true as const, output: {} }));
      const runner = createRunner({
        runs,
        logger: createTestLogger().logger,
        providerLoader: new TestProviderLoader(executor, resolveTo),
        actionPolicy,
        approvals: { requestAction },
      });

      const allowed = await runner.run({
        actionId: sendAction.id,
        input: { to: ["alice@tierneymorris.com.au"] },
        caller: "mcp",
      });
      expect(allowed?.result.ok).toBe(true);
      expect(executor).toHaveBeenCalledOnce();

      const refused = await runner.run({
        actionId: sendAction.id,
        input: { to: ["alice@tierneymorris.com.au", "outsider@example.com"] },
        caller: "mcp",
      });
      expect(refused?.result).toEqual({
        ok: false,
        error: {
          code: "recipient_not_allowed",
          message: "example.send would send mail to recipients outside the recipient allowlist: outsider@example.com.",
        },
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(requestAction).toHaveBeenCalledOnce();
      expect(runs.items.at(-1)).toMatchObject({
        ok: false,
        errorCode: "recipient_not_allowed",
        policy: { allowed: false, checks: [{ source: "deployment", outcome: "allow_miss" }] },
      });
    });

    it.each([
      ["has no recipient resolver", undefined],
      [
        "cannot resolve its recipients",
        async () => {
          throw new Error("lookup failed");
        },
      ],
    ])("fails closed when a mail-sending action %s", async (_case, resolver) => {
      const executor = vi.fn(async () => ({ ok: true as const, output: {} }));
      const runner = createRunner({
        runs: new MemoryRunLogStore(),
        logger: createTestLogger().logger,
        providerLoader: new TestProviderLoader(executor, resolver),
        actionPolicy,
      });

      const run = await runner.run({
        actionId: sendAction.id,
        input: { to: ["alice@tierneymorris.com.au"] },
        caller: "http",
      });

      expect(run?.result).toMatchObject({ ok: false, error: { code: "recipient_not_allowed" } });
      expect(executor).not.toHaveBeenCalled();
    });

    it("does not check actions that do not send mail", async () => {
      const resolver = vi.fn(resolveTo);
      const runner = createRunner({
        runs: new MemoryRunLogStore(),
        logger: createTestLogger().logger,
        providerLoader: new TestProviderLoader(async () => ({ ok: true, output: {} }), resolver),
        actionPolicy,
      });

      const run = await runner.run({ actionId: echoAction.id, input: {}, caller: "http" });

      expect(run?.result.ok).toBe(true);
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  it("bypasses the shared connector gate for callers that enforce approval themselves", async () => {
    const runs = new MemoryRunLogStore();
    const { logger } = createTestLogger();
    const requestAction = vi.fn();
    const runner = createRunner({ runs, logger, approvals: { requestAction } });

    const run = await runner.run({
      actionId: echoAction.id,
      input: {},
      caller: "flow",
      approvalPolicy: "bypass",
    });

    expect(run?.result).toEqual({ ok: true, output: { message: "ok" } });
    expect(requestAction).not.toHaveBeenCalled();
  });
});

function createRunner(options: {
  runs: IRunLogStore;
  logger: Logger;
  providerLoader?: IProviderLoader;
  actionPolicy?: ActionPolicyService;
  approvals?: Pick<ConnectionApprovalService, "requestAction">;
}): ActionRunner {
  const catalog = createCatalogStore([exampleProvider], { executableActionIds: [echoAction.id, sendAction.id] });
  const providerLoader =
    options.providerLoader ?? new TestProviderLoader(async () => ({ ok: true, output: { message: "ok" } }));
  return new ActionRunner({
    catalog,
    providerLoader,
    connections: new ConnectionService({ catalog, providerLoader, store: new MemoryConnectionStore() }),
    runs: options.runs,
    actionPolicy: options.actionPolicy,
    approvals: options.approvals,
    logger: options.logger,
  });
}

class TestProviderLoader implements IProviderLoader {
  private readonly executor: ActionExecutor;
  private readonly recipientResolver?: RecipientResolver;

  constructor(executor: ActionExecutor, recipientResolver?: RecipientResolver) {
    this.executor = executor;
    this.recipientResolver = recipientResolver;
  }

  async loadActionExecutor(): Promise<ActionExecutor> {
    return this.executor;
  }

  async loadProxyExecutor(): Promise<undefined> {
    return undefined;
  }

  async loadCredentialValidators(): Promise<undefined> {
    return undefined;
  }

  async loadRecipientResolver(): Promise<RecipientResolver | undefined> {
    return this.recipientResolver;
  }
}

class MemoryConnectionStore implements IConnectionStore {
  async get(): Promise<StoredConnection | undefined> {
    return undefined;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    return { id: crypto.randomUUID(), revision: crypto.randomUUID(), service, connectionName, credential };
  }

  async updateCredential(): Promise<boolean> {
    return false;
  }

  async delete(): Promise<void> {}

  async list(): Promise<StoredConnection[]> {
    return [];
  }
}

class MemoryRunLogStore implements IRunLogStore {
  readonly items: RunLog[] = [];
  addError?: Error;

  async add(run: RunLog): Promise<{ retentionApplied: boolean }> {
    if (this.addError) throw this.addError;
    this.items.push(run);
    return { retentionApplied: true };
  }

  async get(id: string): Promise<RunLog | undefined> {
    return this.items.find((run) => run.id === id);
  }

  async list(_input?: RunLogListInput): Promise<RunLogPage> {
    return { items: this.items };
  }
}

type TestLogEntry = {
  fields: Record<string, unknown>;
  message: string;
};

function createTestLogger(): { entries: TestLogEntry[]; logger: Logger } {
  const entries: TestLogEntry[] = [];
  const record = (fields: Record<string, unknown>, message: string): void => {
    entries.push({ fields, message });
  };
  return {
    entries,
    logger: { info: record, warn: record } as unknown as Logger,
  };
}
