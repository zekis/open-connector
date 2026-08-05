import type { FileCreatedFlowTrigger, NewEmailFlowTrigger } from "./flow-types.ts";

export interface FlowPollItem {
  id: string;
  payload: unknown;
}

export interface FlowPollPlan {
  actionId: string;
  input: Record<string, unknown>;
  readItems(output: unknown): FlowPollItem[];
}

type ConnectionFlowTrigger = NewEmailFlowTrigger | FileCreatedFlowTrigger;

const supportedEmailServices = new Set(["gmail", "outlook"]);
const supportedFileServices = new Set(["obsidian", "one_drive", "dropbox"]);

export function supportsConnectionFlowTrigger(trigger: ConnectionFlowTrigger, service: string): boolean {
  return trigger.type === "new_email" ? supportedEmailServices.has(service) : supportedFileServices.has(service);
}

/** Build the read-only connector action used to detect a configured connection event. */
export function createFlowPollPlan(trigger: ConnectionFlowTrigger, service: string): FlowPollPlan {
  if (trigger.type === "new_email" && service === "outlook") {
    const input: Record<string, unknown> = {
      top: 50,
      orderby: "receivedDateTime desc",
      select: [
        "id",
        "subject",
        "receivedDateTime",
        "from",
        "sender",
        "toRecipients",
        "bodyPreview",
        "hasAttachments",
        "importance",
        "webLink",
      ],
    };
    if (trigger.query) {
      input.filter = trigger.query;
    }
    return {
      actionId: "outlook.list_messages",
      input,
      readItems: (output) => readRecordItems(output, "messages", ["id"]),
    };
  }
  if (trigger.type === "new_email" && service === "gmail") {
    const input: Record<string, unknown> = { maxResults: 50, detail: "summary" };
    if (trigger.query) {
      input.query = trigger.query;
    }
    return {
      actionId: "gmail.fetch_emails",
      input,
      readItems: (output) => readRecordItems(output, "messages", ["messageId", "id"]),
    };
  }
  if (trigger.type === "file_created" && service === "obsidian") {
    const input: Record<string, unknown> = {};
    if (trigger.folder) {
      input.folder = trigger.folder;
    }
    if (trigger.extension) {
      input.extension = trigger.extension;
    }
    return {
      actionId: "obsidian.list_files",
      input,
      readItems: (output) => readStringItems(output, "files", "path"),
    };
  }
  if (trigger.type === "file_created" && service === "one_drive") {
    const input: Record<string, unknown> = {
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
    };
    if (trigger.folder) {
      input.folderPath = trigger.folder;
    }
    return {
      actionId: "one_drive.list_folder_children",
      input,
      readItems: (output) =>
        readRecordItems(
          output,
          "items",
          ["id"],
          (item) => isOneDriveFile(item) && matchesExtension(item.name, trigger.extension),
        ),
    };
  }
  if (trigger.type === "file_created" && service === "dropbox") {
    const input: Record<string, unknown> = { recursive: false, includeDeleted: false, limit: 50 };
    if (trigger.folder) {
      input.path = trigger.folder;
    }
    return {
      actionId: "dropbox.list_folder",
      input,
      readItems: (output) =>
        readRecordItems(
          output,
          "entries",
          ["id", "pathLower", "pathDisplay"],
          (item) =>
            isDropboxFile(item) && matchesExtension(item.name ?? item.pathDisplay ?? item.pathLower, trigger.extension),
        ),
    };
  }
  throw new Error(`${service} does not support ${trigger.type} Flow triggers.`);
}

function readRecordItems(
  output: unknown,
  field: string,
  idFields: string[],
  include: (item: Record<string, unknown>) => boolean = () => true,
): FlowPollItem[] {
  const record = readRecord(output);
  const values = record && Array.isArray(record[field]) ? record[field] : [];
  return values.flatMap((value) => {
    const item = readRecord(value);
    if (!item || !include(item)) {
      return [];
    }
    const id = idFields.map((idField) => item[idField]).find((candidate) => typeof candidate === "string");
    return typeof id === "string" && id ? [{ id, payload: item }] : [];
  });
}

function readStringItems(output: unknown, field: string, payloadField: string): FlowPollItem[] {
  const record = readRecord(output);
  const values = record && Array.isArray(record[field]) ? record[field] : [];
  return values.flatMap((value) =>
    typeof value === "string" && value ? [{ id: value, payload: { [payloadField]: value } }] : [],
  );
}

function isOneDriveFile(item: Record<string, unknown>): boolean {
  return readRecord(item.file) !== undefined;
}

function isDropboxFile(item: Record<string, unknown>): boolean {
  return item.tag === "file";
}

function matchesExtension(value: unknown, extension: string | undefined): boolean {
  if (!extension) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  return value.toLowerCase().endsWith(normalized);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
