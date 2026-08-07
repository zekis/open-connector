import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { SharePointActionHandler } from "./graph-client.ts";

import { optionalString, requiredString } from "../../core/cast.ts";
import { defineOAuthProviderExecutors } from "../provider-runtime.ts";
import { sharePointDriveActionHandlers } from "./drive-actions.ts";
import { sharePointJsonRequest } from "./graph-client.ts";
import { sharePointListActionHandlers } from "./list-actions.ts";
import { sharePointSiteActionHandlers } from "./site-actions.ts";

export const sharePointActionHandlers: Record<string, SharePointActionHandler> = {
  ...sharePointSiteActionHandlers,
  ...sharePointDriveActionHandlers,
  ...sharePointListActionHandlers,
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors("sharepoint", sharePointActionHandlers);

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const currentAccount = await sharePointJsonRequest<{
      id?: unknown;
      displayName?: unknown;
      mail?: unknown;
      userPrincipalName?: unknown;
    }>(
      "me",
      {
        accessToken: input.accessToken,
        tokenType: input.tokenType,
        fetcher,
        signal,
      },
      {
        query: { $select: "id,displayName,mail,userPrincipalName" },
      },
    );
    const accountId = requiredString(currentAccount.id, "SharePoint current account ID");
    return {
      profile: {
        accountId,
        displayName:
          optionalString(currentAccount.mail) ??
          optionalString(currentAccount.userPrincipalName) ??
          optionalString(currentAccount.displayName) ??
          accountId,
      },
      metadata: {
        currentAccount,
      },
    };
  },
};
