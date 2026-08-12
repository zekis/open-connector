import type { ProviderDefinition } from "../../core/types.ts";

import { oneDriveActions } from "./actions.ts";
import { oneDriveOAuthScopes } from "./scopes.ts";

const service = "one_drive";

/**
 * OneDrive provider backed by Microsoft Graph.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "OneDrive",
  categories: ["Storage", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      scopes: oneDriveOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      pkce: {
        method: "S256",
      },
      authorizationParams: {
        response_mode: "query",
      },
      clientConfigFields: [
        {
          key: "tenant",
          label: "Tenant",
          inputType: "text",
          required: true,
          secret: false,
          defaultValue: "common",
          placeholder: "common",
          description:
            "The Microsoft identity platform tenant segment to use, such as common, organizations, consumers, or a specific tenant ID.",
        },
      ],
    },
  ],
  homepageUrl: "https://www.microsoft.com/microsoft-365/onedrive/online-cloud-storage",
  events: [
    {
      id: "one_drive.file_created",
      displayName: "File created",
      description: "Runs when a new file appears in the root OneDrive folder.",
      polling: {
        actionId: "one_drive.list_folder_children",
        input: {
          top: 50,
          orderBy: "createdDateTime desc",
          select: [
            "id",
            "name",
            "webUrl",
            "size",
            "createdDateTime",
            "lastModifiedDateTime",
            "parentReference",
            "file",
            "folder",
          ],
        },
        result: {
          kind: "records",
          collectionField: "items",
          idFields: ["id"],
          include: { field: "file", exists: true },
        },
      },
    },
  ],
  actions: oneDriveActions,
};
