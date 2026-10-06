import type { ActionDefinition, ExecutionResult } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { executeAction } from "../../core/execution.ts";
import { ProviderRequestError, toProviderExecutionError } from "../provider-runtime.ts";
import { githubPullRequestBodyMaxLength } from "./actions.ts";
import { provider } from "./definition.ts";
import { pullRequestActionHandlers } from "./runtime-pull-request.ts";

interface RecordedRequest {
  url: string;
  method: string;
  body: string | undefined;
}

function findAction(name: string): ActionDefinition {
  const action = provider.actions.find((entry) => entry.name === name);
  if (!action) throw new Error(`missing action ${name}`);
  return action;
}

function recordingFetcher(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => Response = (request) =>
    new Response(JSON.stringify({ id: 1, number: 7, body: JSON.parse(request.body ?? "{}").body ?? null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
): typeof fetch {
  return async (url, init) => {
    const request = {
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    requests.push(request);
    return respond(request);
  };
}

/** Validate the input against the action schema, then run the handler, the way the gateway does. */
async function runAction(
  name: string,
  input: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<ExecutionResult> {
  return executeAction(
    findAction(name),
    async (actionInput) => {
      try {
        return {
          ok: true,
          output: await pullRequestActionHandlers[name](actionInput as Record<string, unknown>, {
            accessToken: "test-token",
            fetcher,
          }),
        };
      } catch (error) {
        return toProviderExecutionError(error, "provider request failed");
      }
    },
    input,
    {} as never,
  );
}

function longBody(length: number): string {
  const line = "- [ ] A checklist line in a long pull request description.\n";
  return line.repeat(Math.ceil(length / line.length)).slice(0, length);
}

describe("update_pull_request with a long body", () => {
  it("sends a ~10,000 character body as JSON in a PATCH request body", async () => {
    const body = longBody(9_900);
    const requests: RecordedRequest[] = [];

    const result = await runAction(
      "update_pull_request",
      { owner: "acme", repo: "widgets", pullNumber: 7, body },
      recordingFetcher(requests),
    );

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("PATCH");
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/repos/acme/widgets/pulls/7");
    expect(url.search).toBe("");
    expect(JSON.parse(requests[0].body ?? "{}")).toEqual({ body });
  });

  it("accepts a body of exactly GitHub's 65,536 character limit", async () => {
    const body = longBody(githubPullRequestBodyMaxLength);
    const requests: RecordedRequest[] = [];

    const result = await runAction(
      "update_pull_request",
      { owner: "acme", repo: "widgets", pullNumber: 7, body },
      recordingFetcher(requests),
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(requests[0].body ?? "{}").body).toHaveLength(githubPullRequestBodyMaxLength);
  });

  it.each(["update_pull_request", "create_pull_request"])(
    "%s rejects a body over the limit before calling GitHub, naming the input, the limit and the length given",
    async (name) => {
      const requests: RecordedRequest[] = [];
      const input = {
        owner: "acme",
        repo: "widgets",
        pullNumber: 7,
        title: "A title",
        head: "feature",
        base: "main",
        body: longBody(githubPullRequestBodyMaxLength + 1),
      };
      if (name === "update_pull_request") {
        delete (input as Record<string, unknown>).head;
      } else {
        delete (input as Record<string, unknown>).pullNumber;
      }

      const result = await runAction(name, input, recordingFetcher(requests));

      expect(requests).toHaveLength(0);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_input");
      expect(result.error?.message).toContain("body");
      expect(result.error?.message).toContain(String(githubPullRequestBodyMaxLength));
      expect(result.error?.message).toContain(String(githubPullRequestBodyMaxLength + 1));
    },
  );

  it("declares the same body limit on create and update", () => {
    for (const name of ["create_pull_request", "update_pull_request"]) {
      const properties = findAction(name).inputSchema.properties as Record<string, { maxLength?: number }>;
      expect(properties.body.maxLength).toBe(githubPullRequestBodyMaxLength);
    }
  });
});

describe("GitHub error responses", () => {
  const input = { owner: "acme", repo: "widgets", pullNumber: 7, body: longBody(9_900) };

  it("names GitHub's status and says there was no message when a 5xx has an empty body", async () => {
    const result = await runAction(
      "update_pull_request",
      input,
      recordingFetcher([], () => new Response("", { status: 500, headers: { "x-github-request-id": "ABCD:1234" } })),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("provider_error");
    expect(result.error?.message).toBe(
      "github api request failed: GitHub returned 500 with no error message (request id ABCD:1234)",
    );
    expect(result.error?.details).toMatchObject({
      status: 502,
      details: { githubStatus: 500, githubRequestId: "ABCD:1234" },
    });
  });

  it("surfaces a 422 with GitHub's validation message and each field error", async () => {
    const result = await runAction(
      "update_pull_request",
      input,
      recordingFetcher(
        [],
        () =>
          new Response(
            JSON.stringify({
              message: "Validation Failed",
              errors: [
                {
                  resource: "PullRequest",
                  code: "custom",
                  field: "body",
                  message: "body is too long (maximum is 65536 characters)",
                },
                { resource: "PullRequest", code: "invalid", field: "base" },
              ],
              documentation_url: "https://docs.github.com/rest/pulls/pulls#update-a-pull-request",
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_input");
    expect(result.error?.message).toBe(
      "GitHub returned 422: Validation Failed: body is too long (maximum is 65536 characters); PullRequest.base invalid",
    );
    expect(result.error?.details).toMatchObject({
      status: 400,
      details: {
        githubStatus: 422,
        documentationUrl: "https://docs.github.com/rest/pulls/pulls#update-a-pull-request",
      },
    });
  });

  it("keeps GitHub's message and status for a 5xx that has one", async () => {
    const result = await runAction(
      "update_pull_request",
      input,
      recordingFetcher([], () => new Response(JSON.stringify({ message: "Server Error" }), { status: 503 })),
    );

    expect(result.error?.message).toBe("GitHub returned 503: Server Error");
    expect(result.error?.details).toMatchObject({ status: 502, details: { githubStatus: 503 } });
  });

  it("still reports a not found as 404", async () => {
    const result = await runAction(
      "update_pull_request",
      input,
      recordingFetcher([], () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })),
    );

    expect(result.error?.message).toBe("GitHub returned 404: Not Found");
    expect(result.error?.details).toMatchObject({ status: 404 });
  });

  it("is a ProviderRequestError so every GitHub action maps it the same way", async () => {
    await expect(
      pullRequestActionHandlers.update_pull_request(input, {
        accessToken: "test-token",
        fetcher: recordingFetcher([], () => new Response("", { status: 500 })),
      }),
    ).rejects.toBeInstanceOf(ProviderRequestError);
  });
});
