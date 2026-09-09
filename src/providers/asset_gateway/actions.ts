import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { defineProviderAction } from "../../core/provider-definition.ts";
import { assetGatewayOperations } from "./operations.ts";

const service = "asset_gateway";

export const assetGatewayActions: ProviderActionDefinition[] = assetGatewayOperations.map((operation) =>
  defineProviderAction(service, {
    name: operation.name,
    description: operation.description,
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
    providerPermissions: [operation.permission],
    followUpActions: operation.followUpActions,
  }),
);
