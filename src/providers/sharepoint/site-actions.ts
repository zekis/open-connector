import type { SharePointActionHandler } from "./graph-client.ts";

import { optionalInteger, optionalString, requiredString } from "../../core/cast.ts";
import { encodePathSegment } from "../../core/request.ts";
import { ProviderRequestError } from "../provider-runtime.ts";
import { sharePointCollectionRequest, sharePointJsonRequest } from "./graph-client.ts";

export const sharePointSiteActionHandlers: Record<string, SharePointActionHandler> = {
  async search_sites(input, deps) {
    const nextLink = optionalString(input.nextLink);
    return sharePointCollectionRequest(nextLink ?? "sites", deps, {
      nextLinkKind: nextLink ? "sites" : undefined,
      query: nextLink ? undefined : { search: requiredString(input.query, "query") },
    });
  },

  get_site(input, deps) {
    return sharePointJsonRequest(`sites/${encodePathSegment(requiredString(input.siteId, "siteId"))}`, deps);
  },

  get_site_by_path(input, deps) {
    const hostname = requiredString(input.hostname, "hostname").toLowerCase();
    if (!/^[a-z0-9.-]+$/u.test(hostname)) {
      throw new ProviderRequestError(400, "hostname must contain only letters, numbers, dots, and hyphens.");
    }
    const sitePath = encodeRelativePath(requiredString(input.sitePath, "sitePath"), "sitePath");
    return sharePointJsonRequest(`sites/${encodePathSegment(hostname)}:/${sitePath}`, deps);
  },

  async list_site_drives(input, deps) {
    const nextLink = optionalString(input.nextLink);
    return sharePointCollectionRequest(
      nextLink ?? `sites/${encodePathSegment(requiredString(input.siteId, "siteId"))}/drives`,
      deps,
      {
        nextLinkKind: nextLink ? "site_drives" : undefined,
        query: nextLink
          ? undefined
          : {
              $top: optionalInteger(input.top),
              $orderby: optionalString(input.orderBy),
            },
      },
    );
  },
};

function encodeRelativePath(value: string, fieldName: string): string {
  const path = value.trim().replace(/^\/+|\/+$/gu, "");
  if (!path) {
    throw new ProviderRequestError(400, `${fieldName} must identify a site below the tenant root.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ProviderRequestError(400, `${fieldName} contains an invalid path segment.`);
  }
  return segments.map(encodePathSegment).join("/");
}
