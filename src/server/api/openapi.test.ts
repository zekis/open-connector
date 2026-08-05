import type { ProviderDefinition } from "../../core/types.ts";
import type { OpenApiDocumentOptions } from "./openapi.ts";

import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "./openapi.ts";

interface RunOperation {
  description: string;
  parameters: Array<{
    name: string;
    in: string;
    required: boolean;
    schema: Record<string, unknown>;
    description: string;
  }>;
  responses: Record<string, { description: string }>;
}

const provider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: ["productivity"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: [
    {
      id: "example.echo",
      service: "example",
      name: "echo",
      description: "Echo the input.",
      requiredScopes: [],
      providerPermissions: [],
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: { type: "object", additionalProperties: true },
    },
  ],
};

describe("action execution OpenAPI", () => {
  it.each([
    ["generic", {}],
    ["concrete", { actionId: "example.echo" }],
  ] satisfies Array<[string, OpenApiDocumentOptions]>)(
    "documents idempotent retries for the %s operation",
    (_name, options) => {
      const document = createOpenApiDocument([provider], options);
      const path = document.paths["/v1/actions/{actionId}"] as { post: RunOperation };

      expect(path.post.parameters).toContainEqual({
        name: "actionId",
        in: "path",
        required: true,
        schema: { type: "string", description: "Action id, usually <service>.<name>." },
      });
      expect(path.post.parameters).toContainEqual({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        schema: { type: "string", minLength: 1 },
        description:
          "Optional runtime-wide key for deduplicating retries of the same action request. Leading and trailing whitespace is trimmed; the remaining value must be non-empty and must not exceed 255 UTF-8 bytes. Reuse a key only for retries with the same action, input, effective connection, and stored runtime token. When this header is present, the action input must not exceed an object/array nesting depth of 100 levels.",
      });
      expect(path.post.responses["409"]?.description).toBe(
        "For idempotency, idempotency_request_in_progress means the original request is still running or its outcome is uncertain, while idempotency_key_conflict means the key was reused for a different action, input, effective connection, or stored runtime token. Other runtime conflicts may return their own error code with the same status.",
      );
      expect(path.post.responses["403"]).toBeDefined();
      expect(path.post.responses["429"]).toBeDefined();
      expect(path.post.description).toContain("24-hour replay window");
      expect(path.post.description).toContain("original HTTP status and body");
      expect(path.post.description).toContain("completed successes and failures");
      expect(path.post.description).toContain("are not automatically dispatched again");
      expect(path.post.description).toContain("does not guarantee exactly-once execution");
    },
  );

  it("documents Runtime and token policy management and run audit metadata", () => {
    const document = createOpenApiDocument([provider]);
    const runtimePolicyPath = document.paths["/api/runtime-policy"] as {
      get: { responses: Record<string, unknown> };
      put: { responses: Record<string, unknown> };
    };
    const tokenPath = document.paths["/api/runtime-tokens/{id}"] as {
      put: { responses: Record<string, unknown> };
    };
    const policyRules = document.components.schemas.PolicyRules as {
      required: string[];
      properties: Record<string, { maxItems: number; items: { maxLength: number; description: string } }>;
    };
    const runLog = document.components.schemas.RunLog as { properties: Record<string, unknown> };
    const tokenSummary = document.components.schemas.RuntimeTokenSummary as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const tokenPolicy = document.components.schemas.TokenPolicy as {
      required: string[];
    };

    expect(runtimePolicyPath.get.responses["200"]).toBeDefined();
    expect(runtimePolicyPath.put.responses["413"]).toBeDefined();
    expect(tokenPath.put.responses["413"]).toBeDefined();
    expect(policyRules.required).toEqual(["allowedActions", "blockedActions", "allowedProxies", "blockedProxies"]);
    expect(policyRules.properties.allowedActions).toMatchObject({
      maxItems: 128,
      items: { maxLength: 256, description: expect.stringContaining("256-byte UTF-8 limit") },
    });
    expect(tokenSummary.required).toEqual(
      expect.arrayContaining(["allowedActions", "blockedActions", "allowedProxies"]),
    );
    expect(tokenPolicy.required).toEqual(["allowedActions", "blockedActions", "allowedProxies"]);
    expect(runLog.properties).toHaveProperty("policy");
    expect(runLog.properties).toHaveProperty("runtimeTokenId");
  });

  it("documents authenticated Flow creation and complete replacement without accepting a model", () => {
    const document = createOpenApiDocument([provider]);
    const flowsPath = document.paths["/api/flows"] as {
      post: {
        description: string;
        requestBody: { content: { "application/json": { schema: { $ref: string } } } };
        responses: Record<string, unknown>;
      };
    };
    const flowPath = document.paths["/api/flows/{id}"] as {
      put: {
        description: string;
        parameters: Array<{ name: string; required: boolean }>;
        requestBody: { content: { "application/json": { schema: { $ref: string } } } };
        responses: Record<string, unknown>;
      };
    };
    const input = document.components.schemas.FlowDefinitionInput as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const agent = document.components.schemas.FlowAgentInput as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const definition = document.components.schemas.FlowDefinition as {
      required: string[];
      properties: Record<string, unknown>;
    };
    const trigger = document.components.schemas.FlowTrigger as { oneOf: unknown[] };
    const triggerPath = document.paths["/v1/flows/{id}/trigger"] as {
      post: { description: string; responses: Record<string, unknown> };
    };

    expect(flowsPath.post.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/FlowDefinitionInput",
    );
    expect(flowsPath.post.responses["200"]).toBeDefined();
    expect(flowsPath.post.responses["400"]).toBeDefined();
    expect(flowsPath.post.responses["401"]).toBeDefined();
    expect(flowsPath.post.description).toContain("local admin authentication");
    expect(flowPath.put.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/FlowDefinitionInput",
    );
    expect(flowPath.put.parameters).toContainEqual(expect.objectContaining({ name: "id", required: true }));
    expect(flowPath.put.responses["404"]).toBeDefined();
    expect(flowPath.put.description).toContain("Replaces all editable fields");
    expect(input.required).toEqual(
      expect.arrayContaining([
        "name",
        "sourceConnectionId",
        "destinationConnectionId",
        "instructions",
        "agent",
        "tools",
      ]),
    );
    expect(input.properties).not.toHaveProperty("model");
    expect(agent.required).toEqual(["connectionId"]);
    expect(agent.properties).not.toHaveProperty("model");
    expect(definition.required).toEqual(expect.arrayContaining(["id", "revision", "createdAt", "updatedAt"]));
    expect(definition.required).toContain("trigger");
    expect(input.properties).toHaveProperty("trigger");
    expect(trigger.oneOf).toHaveLength(5);
    expect(triggerPath.post.description).toContain("runtime bearer token");
    expect(triggerPath.post.responses["200"]).toBeDefined();
    expect(triggerPath.post.responses["401"]).toBeDefined();
  });

  it("documents connector-wide defaults, Flow overrides, and one-time approval retries", () => {
    const document = createOpenApiDocument([provider]);
    const permissionsPath = document.paths["/api/connection-permissions/{connectionId}"] as {
      put: { description: string; responses: Record<string, unknown> };
    };
    const approvalsPath = document.paths["/api/action-approvals"] as {
      get: { responses: Record<string, unknown> };
    };
    const approvePath = document.paths["/api/action-approvals/{id}/approve"] as {
      post: { description: string; responses: Record<string, unknown> };
    };
    const flowGrant = document.components.schemas.FlowToolGrant as {
      description: string;
      properties: { approval: { enum: string[] } };
    };
    const actionApproval = document.components.schemas.ActionApproval as {
      description: string;
      properties: Record<string, unknown>;
    };

    expect(permissionsPath.put.description).toContain("Chat, runtime API, MCP, and console requests");
    expect(permissionsPath.put.description).toContain("Flow explicitly overrides");
    expect(permissionsPath.put.responses).toEqual(
      expect.objectContaining({ 200: expect.anything(), 400: expect.anything(), 404: expect.anything() }),
    );
    expect(approvalsPath.get.responses["200"]).toBeDefined();
    expect(approvePath.post.description).toContain("one identical retry");
    expect(approvePath.post.description).toContain("does not execute");
    expect(flowGrant.properties.approval.enum).toEqual(["inherit", "always_allow", "require_approval"]);
    expect(flowGrant.description).toContain("override");
    expect(actionApproval.description).toContain("15 minutes");
    expect(actionApproval.properties).not.toHaveProperty("requestHash");
  });

  it("documents authenticated agent Chat with bounded stateless history and connector activity", () => {
    const document = createOpenApiDocument([provider]);
    const chatPath = document.paths["/api/agent-chat/messages"] as {
      post: {
        description: string;
        requestBody: { content: { "application/json": { schema: { $ref: string } } } };
        responses: Record<string, unknown>;
      };
    };
    const request = document.components.schemas.AgentChatRequest as {
      required: string[];
      description: string;
      properties: { messages: { minItems: number; maxItems: number } };
    };
    const activity = document.components.schemas.AgentChatToolActivity as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(chatPath.post.requestBody.content["application/json"].schema.$ref).toBe(
      "#/components/schemas/AgentChatRequest",
    );
    expect(chatPath.post.responses).toEqual(
      expect.objectContaining({
        200: expect.anything(),
        400: expect.anything(),
        401: expect.anything(),
        503: expect.anything(),
      }),
    );
    expect(chatPath.post.description).toContain("Runtime policy and run auditing");
    expect(chatPath.post.description).toContain("local admin authentication");
    expect(request.required).toEqual(["messages"]);
    expect(request.description).toContain("not persisted");
    expect(request.properties.messages).toMatchObject({ minItems: 1, maxItems: 40 });
    expect(activity.required).toEqual(expect.arrayContaining(["type", "ok", "input", "output"]));
    expect(activity.properties).toHaveProperty("connectionId");
  });
});
