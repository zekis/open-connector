import { base64Bytes } from "../../core/cast.ts";

const maximumProviderPreviewBytes = 20 * 1024 * 1024;

export type ProviderPreviewKind = "email" | "web" | "image" | "pdf" | "document" | "file";
export type ProviderPreviewOutputKind = "outlook_message" | "downloaded_file" | "one_drive" | "dropbox" | "text";

export interface ProviderPreview {
  id: string;
  kind: ProviderPreviewKind;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  summary?: string;
  contentUrl?: string;
  externalUrl?: string;
}

export interface ProviderPreviewSource {
  actionId: string;
  connectionId: string;
  input: Record<string, unknown>;
  outputKind: ProviderPreviewOutputKind;
}

export interface ProviderPreviewDescriptor {
  preview: ProviderPreview;
  source?: ProviderPreviewSource;
}

export interface ProviderPreviewContent {
  name: string;
  mimeType: string;
  sizeBytes?: number;
  fileId?: string;
  bytes?: Uint8Array<ArrayBuffer>;
}

export interface CreateProviderPreviewsOptions {
  service?: string;
  connectionId?: string;
  actionId?: string;
  sourceInput?: Record<string, unknown>;
  item: Record<string, unknown>;
  title: string;
  summary?: string;
  externalUrl?: string;
  contentUrl?(previewId: string): string;
}

/** Describes inline-safe previews and the connector calls required to load their content. */
export function createProviderPreviews(options: CreateProviderPreviewsOptions): ProviderPreviewDescriptor[] {
  if (options.service === "outlook" && isOutlookMessage(options)) {
    return createOutlookPreviews(options);
  }

  const file = createFilePreview(options);
  if (file) return [file];

  const externalUrl =
    safeExternalUrl(options.externalUrl) ??
    firstHttpsUrl(options.item, ["webUrl", "webLink", "url", "link", "imageUrl", "thumbnailUrl"]);
  if (!externalUrl) return [];
  const mimeType = firstText(options.item, ["mimeType", "contentType"]);
  const inferredKind = previewKind(options.title, mimeType);
  return [
    descriptor(options, {
      id: "source",
      kind: inferredKind === "file" || inferredKind === "document" ? "web" : inferredKind,
      name: options.title,
      mimeType,
      summary: options.summary,
      externalUrl,
    }),
  ];
}

/** Converts a successful connector result into browser-readable preview content. */
export function readProviderPreviewContent(
  descriptor: ProviderPreviewDescriptor,
  output: unknown,
): ProviderPreviewContent {
  const value = record(output);
  if (!value)
    throw new ProviderPreviewError("provider_preview_unavailable", "Preview returned an invalid response.", 503);
  switch (descriptor.source?.outputKind) {
    case "outlook_message": {
      const body = record(value.body);
      const content = firstText(body, ["content"]);
      if (!content)
        throw new ProviderPreviewError("provider_preview_unavailable", "The email body is unavailable.", 404);
      const bytes = new TextEncoder().encode(content);
      return {
        name: descriptor.preview.name,
        mimeType: "text/plain; charset=utf-8",
        sizeBytes: bytes.byteLength,
        bytes,
      };
    }
    case "text": {
      const content = typeof value.content === "string" ? value.content : undefined;
      if (content === undefined) {
        throw new ProviderPreviewError("provider_preview_unavailable", "The document body is unavailable.", 404);
      }
      const bytes = new TextEncoder().encode(content);
      return {
        name: descriptor.preview.name,
        mimeType: descriptor.preview.mimeType ?? "text/plain; charset=utf-8",
        sizeBytes: bytes.byteLength,
        bytes,
      };
    }
    case "one_drive": {
      const content = record(value.content);
      if (!content)
        throw new ProviderPreviewError("provider_preview_unavailable", "The file content is unavailable.", 404);
      return base64PreviewContent(descriptor.preview, content);
    }
    case "dropbox":
      return base64PreviewContent(descriptor.preview, value);
    case "downloaded_file": {
      const file = record(value.file);
      if (typeof file?.fileId === "string") {
        return {
          name: firstText(value, ["name"]) ?? descriptor.preview.name,
          mimeType: firstText(value, ["mimeType"]) ?? descriptor.preview.mimeType ?? "application/octet-stream",
          sizeBytes: nonNegativeNumber(value.sizeBytes),
          fileId: file.fileId,
        };
      }
      return base64PreviewContent(descriptor.preview, value);
    }
    default:
      throw new ProviderPreviewError("provider_preview_unavailable", "Preview content is unavailable.", 404);
  }
}

export class ProviderPreviewError extends Error {
  readonly code: string;
  readonly status: 404 | 413 | 503;

  constructor(code: string, message: string, status: 404 | 413 | 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function createOutlookPreviews(options: CreateProviderPreviewsOptions): ProviderPreviewDescriptor[] {
  const messageId = firstText(options.item, ["id"]);
  const externalUrl = safeExternalUrl(options.externalUrl) ?? safeExternalUrl(options.item.webLink);
  const emailSource =
    options.connectionId && messageId
      ? {
          actionId: "outlook.get_message",
          connectionId: options.connectionId,
          input: {
            messageId,
            select: ["id", "subject", "body", "from", "sender", "receivedDateTime", "sentDateTime", "webLink"],
            bodyContentType: "text",
          },
          outputKind: "outlook_message" as const,
        }
      : undefined;
  const previews: ProviderPreviewDescriptor[] = [
    descriptor(options, {
      id: "email",
      kind: "email",
      name: options.title,
      summary: options.summary,
      externalUrl,
      source: emailSource,
    }),
  ];

  const attachments = Array.isArray(options.item.attachments) ? options.item.attachments : [];
  for (const [index, value] of attachments.entries()) {
    const attachment = record(value);
    if (!attachment) continue;
    const preview = createOutlookAttachmentPreview(options, attachment, messageId, `attachment-${index}`);
    if (preview) previews.push(preview);
  }
  return previews;
}

function createFilePreview(options: CreateProviderPreviewsOptions): ProviderPreviewDescriptor | undefined {
  const name = firstText(options.item, ["name", "fileName", "path", "pathDisplay", "pathLower"]);
  if (!name) return undefined;
  if (options.service === "outlook" && options.actionId?.includes("attachment")) {
    return createOutlookAttachmentPreview(options, options.item, firstText(options.sourceInput, ["messageId"]), "file");
  }

  const file = record(options.item.file);
  const parentReference = record(options.item.parentReference);
  const mimeType =
    firstText(file, ["mimeType"]) ?? firstText(options.item, ["mimeType", "contentType"]) ?? inferMimeType(name);
  const sizeBytes = nonNegativeNumber(options.item.size) ?? nonNegativeNumber(options.item.sizeBytes);
  const canLoad = sizeBytes === undefined || sizeBytes <= maximumProviderPreviewBytes;
  let source: ProviderPreviewSource | undefined;
  if (canLoad && options.connectionId && options.service === "one_drive" && typeof options.item.id === "string") {
    source = {
      actionId: "one_drive.download_file",
      connectionId: options.connectionId,
      input: {
        itemId: options.item.id,
        ...(typeof parentReference?.driveId === "string" ? { driveId: parentReference.driveId } : {}),
      },
      outputKind: "one_drive",
    };
  } else if (canLoad && options.connectionId && options.service === "dropbox") {
    const path = firstText(options.item, ["pathDisplay", "pathLower", "path"]);
    if (path) {
      source = {
        actionId: "dropbox.download_file",
        connectionId: options.connectionId,
        input: { path },
        outputKind: "dropbox",
      };
    }
  } else if (canLoad && options.connectionId && options.service === "obsidian" && isTextPreview(name, mimeType)) {
    source = {
      actionId: "obsidian.read_note",
      connectionId: options.connectionId,
      input: { path: name },
      outputKind: "text",
    };
  } else if (
    canLoad &&
    options.connectionId &&
    options.service === "sharepoint" &&
    typeof options.item.id === "string"
  ) {
    const driveId = firstText(parentReference, ["driveId"]);
    if (driveId) {
      source = {
        actionId: "sharepoint.download_file",
        connectionId: options.connectionId,
        input: { driveId, itemId: options.item.id },
        outputKind: "downloaded_file",
      };
    }
  }

  return descriptor(options, {
    id: "file",
    kind: previewKind(name, mimeType),
    name,
    mimeType,
    sizeBytes,
    externalUrl:
      safeExternalUrl(options.externalUrl) ??
      firstHttpsUrl(options.item, ["webUrl", "webLink", "url", "link", "downloadUrl"]),
    source,
  });
}

function createOutlookAttachmentPreview(
  options: CreateProviderPreviewsOptions,
  attachment: Record<string, unknown>,
  messageId: string | undefined,
  id: string,
): ProviderPreviewDescriptor | undefined {
  if (attachment.isInline === true) return undefined;
  const attachmentId = firstText(attachment, ["id"]) ?? firstText(options.sourceInput, ["attachmentId"]);
  const name = firstText(attachment, ["name"]) ?? options.title;
  const mimeType = firstText(attachment, ["contentType", "mimeType"]) ?? inferMimeType(name);
  const sizeBytes = nonNegativeNumber(attachment.size) ?? nonNegativeNumber(attachment.sizeBytes);
  const attachmentType = firstText(attachment, ["@odata.type"]);
  const isReference = attachmentType?.toLowerCase().endsWith("referenceattachment") === true;
  const source =
    !isReference &&
    options.connectionId &&
    messageId &&
    attachmentId &&
    (sizeBytes === undefined || sizeBytes <= maximumProviderPreviewBytes)
      ? {
          actionId: "outlook.download_attachment",
          connectionId: options.connectionId,
          input: { messageId, attachmentId },
          outputKind: "downloaded_file" as const,
        }
      : undefined;
  return descriptor(options, {
    id,
    kind: previewKind(name, mimeType),
    name,
    mimeType,
    sizeBytes,
    externalUrl: safeExternalUrl(attachment.sourceUrl),
    source,
  });
}

function descriptor(
  options: CreateProviderPreviewsOptions,
  input: Omit<ProviderPreview, "contentUrl"> & { source?: ProviderPreviewSource },
): ProviderPreviewDescriptor {
  const { source, ...preview } = input;
  return {
    preview: {
      ...preview,
      ...(source && options.contentUrl ? { contentUrl: options.contentUrl(preview.id) } : {}),
    },
    source,
  };
}

function isOutlookMessage(options: CreateProviderPreviewsOptions): boolean {
  if (options.service !== "outlook" || typeof options.item.id !== "string") return false;
  if (options.actionId?.includes("attachment")) return false;
  return (
    typeof options.item.subject === "string" ||
    typeof options.item.bodyPreview === "string" ||
    options.actionId?.includes("message") === true ||
    options.actionId?.includes("draft") === true
  );
}

function previewKind(name: string, mimeType: string | undefined): ProviderPreviewKind {
  const mime = mimeType?.toLowerCase() ?? "";
  const extension = fileExtension(name);
  if (mime.startsWith("image/") || ["gif", "jpeg", "jpg", "png", "webp"].includes(extension)) return "image";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    ["csv", "doc", "docx", "html", "md", "ppt", "pptx", "rtf", "txt", "xls", "xlsx"].includes(extension)
  ) {
    return "document";
  }
  return "file";
}

function inferMimeType(name: string): string | undefined {
  switch (fileExtension(name)) {
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "pdf":
      return "application/pdf";
    case "csv":
      return "text/csv";
    case "html":
      return "text/html";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    default:
      return undefined;
  }
}

function isTextPreview(name: string, mimeType: string | undefined): boolean {
  return mimeType?.startsWith("text/") === true || ["md", "txt"].includes(fileExtension(name));
}

function fileExtension(name: string): string {
  const basename = name.split(/[\\/]/u).at(-1) ?? name;
  const index = basename.lastIndexOf(".");
  return index >= 0 ? basename.slice(index + 1).toLowerCase() : "";
}

function firstHttpsUrl(value: Record<string, unknown> | undefined, fields: string[]): string | undefined {
  for (const field of fields) {
    const url = safeExternalUrl(value?.[field]);
    if (url) return url;
  }
  return undefined;
}

function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function firstText(value: Record<string, unknown> | undefined, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = value?.[field];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function base64PreviewContent(preview: ProviderPreview, value: Record<string, unknown>): ProviderPreviewContent {
  try {
    const bytes = base64Bytes(value.contentBase64, "preview content");
    if (bytes.byteLength > maximumProviderPreviewBytes) {
      throw new ProviderPreviewError("provider_preview_too_large", "This file is too large to preview inline.", 413);
    }
    return {
      name: firstText(value, ["name"]) ?? preview.name,
      mimeType: firstText(value, ["mimeType"]) ?? preview.mimeType ?? "application/octet-stream",
      sizeBytes: bytes.byteLength,
      bytes,
    };
  } catch (error) {
    if (error instanceof ProviderPreviewError) throw error;
    throw new ProviderPreviewError("provider_preview_unavailable", "Preview returned invalid file content.", 503);
  }
}
