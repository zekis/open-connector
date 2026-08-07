import type { SharePointActionHandler, SharePointRuntimeDeps } from "./graph-client.ts";

import { Buffer } from "node:buffer";
import {
  base64Bytes,
  optionalInteger,
  optionalRawString,
  optionalRecord,
  optionalString,
  requiredString,
} from "../../core/cast.ts";
import { encodePathSegment, readBoundedResponseBytes } from "../../core/request.ts";
import { ProviderRequestError, readTransitFileInput } from "../provider-runtime.ts";
import { sharePointCollectionRequest, sharePointJsonRequest, sharePointRequest } from "./graph-client.ts";

const maxSharePointFileBytes = 20 * 1024 * 1024;

interface SharePointUploadSource {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}

export const sharePointDriveActionHandlers: Record<string, SharePointActionHandler> = {
  get_drive_item(input, deps) {
    return sharePointJsonRequest(buildDriveItemPath(input), deps);
  },

  async list_folder_children(input, deps) {
    const nextLink = optionalString(input.nextLink);
    return sharePointCollectionRequest(nextLink ?? buildFolderChildrenPath(input), deps, {
      nextLinkKind: nextLink ? "drive_children" : undefined,
      query: nextLink ? undefined : { $top: optionalInteger(input.top) },
    });
  },

  async search_drive_items(input, deps) {
    const nextLink = optionalString(input.nextLink);
    const driveId = encodePathSegment(requiredString(input.driveId, "driveId"));
    const query = encodeURIComponent(escapeOdataString(requiredString(input.query, "query")));
    return sharePointCollectionRequest(nextLink ?? `drives/${driveId}/root/search(q='${query}')`, deps, {
      nextLinkKind: nextLink ? "drive_search" : undefined,
      query: nextLink ? undefined : { $top: optionalInteger(input.top) },
    });
  },

  create_folder(input, deps) {
    return sharePointJsonRequest(buildFolderChildrenPath(input, true), deps, {
      method: "POST",
      body: {
        name: requiredString(input.name, "name"),
        folder: {},
        "@microsoft.graph.conflictBehavior": optionalString(input.conflictBehavior) ?? "rename",
      },
    });
  },

  async upload_file(input, deps) {
    const source = await readUploadSource(input, deps);
    const conflictBehavior = optionalString(input.conflictBehavior) ?? "replace";
    return sharePointJsonRequest(buildUploadPath(input, source.name), deps, {
      method: "PUT",
      query: { "@microsoft.graph.conflictBehavior": conflictBehavior },
      headers: { "content-type": source.mimeType },
      rawBody: toArrayBuffer(source.bytes),
    });
  },

  async download_file(input, deps) {
    const driveId = encodePathSegment(requiredString(input.driveId, "driveId"));
    const itemId = encodePathSegment(requiredString(input.itemId, "itemId"));
    const itemPath = `drives/${driveId}/items/${itemId}`;
    const metadata = await sharePointJsonRequest<Record<string, unknown>>(itemPath, deps, {
      query: { $select: "id,name,size,file" },
    });
    if (!optionalRecord(metadata.file)) {
      throw new ProviderRequestError(400, "The requested SharePoint drive item is not a file.");
    }

    const response = await sharePointRequest(`${itemPath}/content`, deps);
    const name = optionalString(metadata.name) ?? requiredString(input.itemId, "itemId");
    const mimeType =
      optionalString(response.headers.get("content-type")) ??
      optionalString(optionalRecord(metadata.file)?.mimeType) ??
      "application/octet-stream";
    const bytes = await readBoundedResponseBytes(response, {
      maxBytes: Math.min(maxSharePointFileBytes, deps.transitFiles?.maxBytes ?? maxSharePointFileBytes),
      fieldName: name,
      createError: (message) => new ProviderRequestError(413, message),
    });

    if (deps.transitFiles) {
      const upload = await deps.transitFiles.create(new File([Uint8Array.from(bytes)], name, { type: mimeType }));
      return {
        name,
        mimeType,
        sizeBytes: bytes.byteLength,
        file: upload,
        contentBase64: null,
      };
    }

    return {
      name,
      mimeType,
      sizeBytes: bytes.byteLength,
      file: null,
      contentBase64: Buffer.from(bytes).toString("base64"),
    };
  },
};

function buildDriveItemPath(input: Record<string, unknown>): string {
  const driveBase = buildDriveBase(input);
  const itemId = optionalString(input.itemId);
  if (itemId) {
    return `${driveBase}/items/${encodePathSegment(itemId)}`;
  }
  const itemPath = requiredString(input.itemPath, "itemPath");
  const segments = normalizeDrivePath(itemPath, "itemPath");
  return segments.length === 0 ? `${driveBase}/root` : `${driveBase}/root:/${encodeSegments(segments)}:`;
}

function buildFolderChildrenPath(input: Record<string, unknown>, forCreate = false): string {
  const driveBase = buildDriveBase(input);
  const itemId = optionalString(forCreate ? input.parentItemId : input.folderItemId);
  const path = optionalString(forCreate ? input.parentPath : input.folderPath);
  if (itemId) {
    return `${driveBase}/items/${encodePathSegment(itemId)}/children`;
  }
  if (path) {
    const segments = normalizeDrivePath(path, forCreate ? "parentPath" : "folderPath");
    return segments.length === 0
      ? `${driveBase}/root/children`
      : `${driveBase}/root:/${encodeSegments(segments)}:/children`;
  }
  return `${driveBase}/root/children`;
}

function buildUploadPath(input: Record<string, unknown>, name: string): string {
  const driveBase = buildDriveBase(input);
  const parentItemId = optionalString(input.parentItemId);
  if (parentItemId) {
    return `${driveBase}/items/${encodePathSegment(parentItemId)}:/${encodePathSegment(name)}:/content`;
  }

  const folderSegments = optionalString(input.folderPath)
    ? normalizeDrivePath(requiredString(input.folderPath, "folderPath"), "folderPath")
    : [];
  return `${driveBase}/root:/${encodeSegments([...folderSegments, name])}:/content`;
}

function buildDriveBase(input: Record<string, unknown>): string {
  return `drives/${encodePathSegment(requiredString(input.driveId, "driveId"))}`;
}

function normalizeDrivePath(value: string, fieldName: string): string[] {
  const path = value.trim().replace(/^\/+|\/+$/gu, "");
  if (!path) {
    return [];
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ProviderRequestError(400, `${fieldName} contains an invalid path segment.`);
  }
  return segments;
}

function encodeSegments(segments: string[]): string {
  return segments.map(encodePathSegment).join("/");
}

async function readUploadSource(
  input: Record<string, unknown>,
  deps: SharePointRuntimeDeps,
): Promise<SharePointUploadSource> {
  const hasFile = input.file !== undefined;
  const hasBase64 = input.contentBase64 !== undefined;
  const hasText = input.text !== undefined;
  if ([hasFile, hasBase64, hasText].filter(Boolean).length !== 1) {
    throw new ProviderRequestError(400, "Provide exactly one of file, contentBase64, or text.");
  }

  let bytes: Uint8Array;
  let sourceName: string | undefined;
  let sourceMimeType: string | undefined;
  if (hasFile) {
    const file = await readTransitFileInput(input.file, deps);
    bytes = new Uint8Array(await file.file.arrayBuffer());
    sourceName = file.name;
    sourceMimeType = file.mimeType;
  } else if (hasBase64) {
    bytes = base64Bytes(input.contentBase64, "contentBase64", (message) => new ProviderRequestError(400, message));
  } else {
    const text = optionalRawString(input.text);
    if (text === undefined) {
      throw new ProviderRequestError(400, "text must be a string.");
    }
    bytes = new TextEncoder().encode(text);
    sourceMimeType = "text/plain; charset=utf-8";
  }

  if (bytes.byteLength > maxSharePointFileBytes) {
    throw new ProviderRequestError(413, `SharePoint upload exceeds ${maxSharePointFileBytes} bytes.`);
  }
  return {
    bytes,
    name: optionalString(input.name) ?? sourceName ?? requiredString(input.name, "name"),
    mimeType: optionalString(input.mimeType) ?? sourceMimeType ?? "application/octet-stream",
  };
}

function escapeOdataString(value: string): string {
  return value.replaceAll("'", "''");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
