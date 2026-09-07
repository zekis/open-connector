import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const port = readIntegerEnvironment("OFFICECLI_API_PORT", 3030, 1, 65_535);
const documentRoot = resolve(process.env.OFFICECLI_DOCUMENT_ROOT || "/documents");
const apiToken = requiredEnvironment("OFFICECLI_API_TOKEN");
const officeCliBinary = process.env.OFFICECLI_BINARY || "officecli";
const maxRequestBytes = readIntegerEnvironment("OFFICECLI_MAX_REQUEST_BYTES", 100 * 1024 * 1024, 1, 1024 * 1024 * 1024);
const maxOutputBytes = readIntegerEnvironment("OFFICECLI_MAX_OUTPUT_BYTES", 20 * 1024 * 1024, 1, 256 * 1024 * 1024);
const commandTimeoutMs = readIntegerEnvironment("OFFICECLI_COMMAND_TIMEOUT_MS", 180_000, 1_000, 30 * 60_000);
const maximumConcurrentCommands = readIntegerEnvironment("OFFICECLI_MAX_CONCURRENT", 2, 1, 16);
const supportedDocumentExtensions = new Set([".docx", ".xlsx", ".pptx"]);
const viewModes = new Set(["text", "annotated", "outline", "stats", "issues", "forms", "html", "svg"]);
const helpFormats = new Set(["docx", "xlsx", "pptx"]);
const batchCommands = new Set(["add", "set", "remove", "move", "copy", "swap", "get", "query"]);
const mimeTypes = new Map([
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

let resolvedDocumentRoot;
let officeCliVersion;
let activeCommands = 0;
const commandWaiters = [];

await mkdir(documentRoot, { recursive: true });
if (process.env.HOME) await mkdir(process.env.HOME, { recursive: true });
resolvedDocumentRoot = await realpath(documentRoot);
officeCliVersion = await detectOfficeCliVersion();

const server = createServer(async (request, response) => {
  try {
    await routeRequest(request, response);
  } catch (error) {
    sendError(response, error);
  }
});

server.requestTimeout = commandTimeoutMs + 30_000;
server.headersTimeout = 30_000;
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`OfficeCLI API listening on port ${port} with document root ${resolvedDocumentRoot}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}

async function routeRequest(request, response) {
  const method = request.method || "GET";
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (method === "GET" && requestUrl.pathname === "/health") {
    return sendJson(response, 200, { status: "ok", officecliVersion: officeCliVersion });
  }

  requireAuthorization(request);

  if (method === "GET" && requestUrl.pathname === "/v1/info") {
    return sendJson(response, 200, {
      name: "OfficeCLI API",
      officecliVersion: officeCliVersion,
      supportedDocumentExtensions: [...supportedDocumentExtensions],
      maxRequestBytes,
      maxConcurrentCommands: maximumConcurrentCommands,
    });
  }

  if (method === "GET" && requestUrl.pathname === "/v1/documents") {
    const prefix = requestUrl.searchParams.get("prefix") || "";
    return sendJson(response, 200, { documents: await listDocuments(prefix) });
  }

  if (requestUrl.pathname.startsWith("/v1/documents/")) {
    const document = decodeDocumentRoute(requestUrl.pathname.slice("/v1/documents/".length));
    if (method === "PUT") return uploadDocument(request, response, document);
    if (method === "GET") return downloadDocument(response, document);
    if (method === "DELETE") return deleteDocument(response, document);
  }

  if (method === "POST" && requestUrl.pathname === "/v1/commands") {
    const input = await readJsonBody(request);
    const command = requiredString(input.command, "command").toLowerCase();
    const args = await buildOfficeCliArguments(command, input);
    const result = await runOfficeCli(args);
    const warnings = parseWarnings(result.stderr);
    if (command === "batch") {
      const flushResult = await saveOfficeCliDocument(args[1]);
      warnings.push(...parseWarnings(flushResult.stderr));
    }
    return sendJson(response, 200, {
      result: parseOfficeCliOutput(result.stdout),
      warnings,
    });
  }

  throw new HttpError(404, "Endpoint not found", "not_found");
}

function requireAuthorization(request) {
  const authorization = request.headers.authorization || "";
  const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : request.headers["x-api-key"];
  if (typeof candidate !== "string" || !constantTimeEquals(candidate, apiToken)) {
    throw new HttpError(401, "A valid OfficeCLI API token is required", "unauthorized");
  }
}

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function listDocuments(prefix) {
  const start = prefix
    ? await resolveManagedPath(prefix, { requireDocument: false, allowDirectory: true, mustExist: true })
    : resolvedDocumentRoot;
  const startStats = await stat(start).catch((error) => {
    if (error?.code === "ENOENT") throw new HttpError(404, "Document prefix not found", "not_found");
    throw error;
  });
  if (!startStats.isDirectory()) throw new HttpError(400, "prefix must identify a directory", "invalid_path");

  const documents = [];
  const pending = [start];
  while (pending.length > 0 && documents.length < 5_000) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || !supportedDocumentExtensions.has(extension)) continue;
      const fileStats = await stat(absolutePath);
      documents.push({
        path: relative(resolvedDocumentRoot, absolutePath).split(sep).join("/"),
        name: entry.name,
        extension,
        sizeBytes: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    }
  }
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

async function uploadDocument(request, response, document) {
  const target = await resolveManagedPath(document, { requireDocument: true, mustExist: false });
  const bytes = await readRequestBytes(request, maxRequestBytes);
  await mkdir(dirname(target), { recursive: true });
  await assertNoSymbolicLinkSegments(target, true);
  if (await fileExists(target)) await closeOfficeCliDocument(target);
  const temporaryPath = `${target}.upload-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return sendJson(response, 201, { document: await describeDocument(target) });
}

async function downloadDocument(response, document) {
  const target = await resolveManagedPath(document, { requireDocument: true, mustExist: true });
  await saveOfficeCliDocument(target);
  const fileStats = await stat(target).catch((error) => {
    if (error?.code === "ENOENT") throw new HttpError(404, "Document not found", "not_found");
    throw error;
  });
  if (!fileStats.isFile()) throw new HttpError(404, "Document not found", "not_found");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${safeHeaderFilename(basename(target))}"`,
    "content-length": String(fileStats.size),
    "content-type": mimeTypes.get(extname(target).toLowerCase()) || "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  createReadStream(target).pipe(response);
}

async function deleteDocument(response, document) {
  const target = await resolveManagedPath(document, { requireDocument: true, mustExist: true });
  const fileStats = await stat(target).catch((error) => {
    if (error?.code === "ENOENT") throw new HttpError(404, "Document not found", "not_found");
    throw error;
  });
  if (!fileStats.isFile()) throw new HttpError(404, "Document not found", "not_found");
  await closeOfficeCliDocument(target);
  await rm(target);
  sendJson(response, 200, { deleted: true, document });
}

async function describeDocument(target) {
  const fileStats = await stat(target);
  return {
    path: relative(resolvedDocumentRoot, target).split(sep).join("/"),
    name: basename(target),
    extension: extname(target).toLowerCase(),
    sizeBytes: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),
  };
}

async function buildOfficeCliArguments(command, input) {
  if (command === "help") {
    const format = requiredString(input.format, "format").toLowerCase();
    if (!helpFormats.has(format)) throw new HttpError(400, "format must be docx, xlsx, or pptx", "invalid_value");
    const args = ["help", format];
    if (input.element != null) args.push(requiredString(input.element, "element"));
    args.push("--json");
    return args;
  }

  if (command === "merge") {
    const template = await resolveManagedPath(requiredString(input.template, "template"), {
      requireDocument: true,
      mustExist: true,
    });
    const output = await resolveManagedPath(requiredString(input.outputDocument, "outputDocument"), {
      requireDocument: true,
      mustExist: false,
    });
    if (extname(template).toLowerCase() !== extname(output).toLowerCase()) {
      throw new HttpError(400, "template and outputDocument must use the same Office format", "unsupported_format");
    }
    if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) {
      throw new HttpError(400, "data must be an object", "invalid_value");
    }
    await mkdir(dirname(output), { recursive: true });
    await assertNoSymbolicLinkSegments(output, true);
    const args = ["merge", template, output, "--data", JSON.stringify(input.data)];
    const force = optionalBoolean(input.force, "force");
    if (force) {
      if (await fileExists(output)) await closeOfficeCliDocument(output);
      args.push("--force");
    }
    args.push("--json");
    return args;
  }

  const document = requiredString(input.document, "document");
  const target = await resolveManagedPath(document, {
    requireDocument: true,
    mustExist: command !== "create",
  });

  switch (command) {
    case "create": {
      await mkdir(dirname(target), { recursive: true });
      await assertNoSymbolicLinkSegments(target, true);
      const args = ["create", target];
      const force = optionalBoolean(input.force, "force");
      if (force) {
        if (await fileExists(target)) await closeOfficeCliDocument(target);
        args.push("--force");
      }
      args.push("--json");
      return args;
    }
    case "get": {
      const depth = optionalInteger(input.depth, "depth", 0, 32) ?? 1;
      return ["get", target, optionalString(input.path, "path") || "/", "--depth", String(depth), "--json"];
    }
    case "query": {
      const args = ["query", target, requiredString(input.selector, "selector")];
      const find = optionalString(input.find, "find");
      if (find) args.push("--find", find);
      args.push("--json");
      return args;
    }
    case "view": {
      const mode = requiredString(input.mode, "mode").toLowerCase();
      if (!viewModes.has(mode)) {
        throw new HttpError(400, `Unsupported view mode: ${mode}`, "invalid_value");
      }
      return ["view", target, mode, "--json"];
    }
    case "batch": {
      const commands = await validateBatchCommands(input.commands);
      const args = ["batch", target, "--commands", JSON.stringify(commands)];
      if (optionalBoolean(input.stopOnError, "stopOnError")) args.push("--stop-on-error");
      if (optionalBoolean(input.bestEffort, "bestEffort")) args.push("--best-effort");
      args.push("--json");
      return args;
    }
    case "validate":
      return ["validate", target, "--json"];
    case "dump":
      return ["dump", target, optionalString(input.path, "path") || "/", "--json"];
    default:
      throw new HttpError(400, `Unsupported OfficeCLI command: ${command}`, "unsupported_command");
  }
}

async function validateBatchCommands(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new HttpError(400, "commands must contain between 1 and 500 batch items", "invalid_value");
  }
  const commands = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, `commands[${index}] must be an object`, "invalid_value");
    }
    const command = requiredString(item.command ?? item.op, `commands[${index}].command`).toLowerCase();
    if (!batchCommands.has(command)) {
      throw new HttpError(400, `Unsupported batch command at index ${index}: ${command}`, "invalid_value");
    }
    const allowedFields = new Set([
      "command",
      "op",
      "path",
      "parent",
      "type",
      "from",
      "to",
      "path2",
      "before",
      "after",
      "index",
      "selector",
      "depth",
      "props",
    ]);
    const normalized = { command };
    for (const [key, fieldValue] of Object.entries(item)) {
      if (!allowedFields.has(key) || key === "command" || key === "op" || fieldValue === undefined) continue;
      if (key === "index" || key === "depth") {
        normalized[key] = optionalInteger(fieldValue, `commands[${index}].${key}`, 0, 10_000);
      } else if (key === "props") {
        normalized.props = await validateBatchProperties(fieldValue, index);
      } else {
        normalized[key] = requiredString(fieldValue, `commands[${index}].${key}`);
      }
    }
    commands.push(normalized);
  }
  return commands;
}

async function validateBatchProperties(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `commands[${index}].props must be an object`, "invalid_value");
  }
  const properties = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    if (typeof propertyValue === "string") {
      properties[key] = await normalizePotentialDocumentPathProperty(key, propertyValue);
    } else if (typeof propertyValue === "number" || typeof propertyValue === "boolean" || propertyValue === null) {
      properties[key] = propertyValue;
    } else {
      throw new HttpError(400, `commands[${index}].props.${key} must be a scalar value`, "invalid_value");
    }
  }
  return properties;
}

async function normalizePotentialDocumentPathProperty(key, value) {
  if (!["path", "source", "src", "image", "file"].includes(key.toLowerCase())) return value;
  if (/^(?:https?:|data:)/iu.test(value)) {
    throw new HttpError(400, `External URLs are not allowed in the ${key} property`, "invalid_path");
  }
  if (value.startsWith("/")) throw new HttpError(400, `${key} must be relative to the document root`, "invalid_path");
  const resolvedValue = resolve(resolvedDocumentRoot, value);
  assertContainedPath(resolvedValue);
  await assertNoSymbolicLinkSegments(resolvedValue, true);
  return resolvedValue;
}

async function resolveManagedPath(input, options) {
  const value = requiredString(input, options.allowDirectory ? "path" : "document");
  if (value.includes("\0") || isAbsolute(value) || /^[a-zA-Z]:[\\/]/u.test(value)) {
    throw new HttpError(400, "Paths must be relative to the OfficeCLI document root", "invalid_path");
  }
  const target = resolve(resolvedDocumentRoot, value.replaceAll("\\", "/"));
  assertContainedPath(target);
  if (options.requireDocument && !supportedDocumentExtensions.has(extname(target).toLowerCase())) {
    throw new HttpError(400, "Document paths must end in .docx, .xlsx, or .pptx", "unsupported_format");
  }
  await assertNoSymbolicLinkSegments(target, true);
  if (options.mustExist) {
    await lstat(target).catch((error) => {
      if (error?.code === "ENOENT") throw new HttpError(404, "Document not found", "not_found");
      throw error;
    });
  }
  return target;
}

function assertContainedPath(target) {
  const relativePath = relative(resolvedDocumentRoot, target);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new HttpError(400, "Path escapes the OfficeCLI document root", "invalid_path");
  }
}

async function assertNoSymbolicLinkSegments(target, includeLeaf) {
  const relativePath = relative(resolvedDocumentRoot, target);
  const segments = relativePath.split(sep);
  const maximum = includeLeaf ? segments.length : Math.max(segments.length - 1, 0);
  let current = resolvedDocumentRoot;
  for (let index = 0; index < maximum; index += 1) {
    current = resolve(current, segments[index]);
    const entry = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new HttpError(400, "Symbolic links are not allowed", "invalid_path");
  }
}

async function runOfficeCli(args) {
  const release = await acquireCommandSlot();
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const childEnvironment = {
        ...process.env,
        OFFICECLI_RESIDENT_FLUSH: "each",
        OFFICECLI_SKIP_UPDATE: "1",
      };
      delete childEnvironment.OFFICECLI_API_TOKEN;
      const child = spawn(officeCliBinary, args, {
        cwd: resolvedDocumentRoot,
        env: childEnvironment,
        shell: false,
        windowsHide: true,
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputExceeded = false;
      const timeout = setTimeout(() => child.kill("SIGKILL"), commandTimeoutMs);

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= maxOutputBytes) stdoutChunks.push(chunk);
        else {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= maxOutputBytes) stderrChunks.push(chunk);
        else {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(new HttpError(502, `Could not start OfficeCLI: ${error.message}`, "command_start_failed"));
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (outputExceeded) {
          rejectPromise(
            new HttpError(413, "OfficeCLI command output exceeded the configured limit", "output_too_large"),
          );
        } else if (signal === "SIGKILL") {
          rejectPromise(new HttpError(504, "OfficeCLI command timed out", "command_timeout"));
        } else if (exitCode !== 0) {
          const parsed = parseOfficeCliOutput(stdout);
          const message = readCliErrorMessage(parsed) || stderr || `OfficeCLI exited with code ${exitCode}`;
          rejectPromise(new HttpError(422, boundedMessage(message), "officecli_error", { exitCode, output: parsed }));
        } else {
          resolvePromise({ stdout, stderr });
        }
      });
    });
  } finally {
    release();
  }
}

async function saveOfficeCliDocument(target) {
  return runOfficeCliResidentCommand("save", target);
}

async function closeOfficeCliDocument(target) {
  return runOfficeCliResidentCommand("close", target);
}

async function runOfficeCliResidentCommand(command, target) {
  try {
    return await runOfficeCli([command, target, "--json"]);
  } catch (error) {
    if (isNoResidentError(error)) return { stdout: "", stderr: "" };
    throw error;
  }
}

function isNoResidentError(error) {
  return (
    error instanceof HttpError &&
    error.code === "officecli_error" &&
    error.message.startsWith("No resident running for ")
  );
}

async function fileExists(target) {
  return lstat(target).then(
    () => true,
    (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    },
  );
}

async function detectOfficeCliVersion() {
  try {
    const result = await runOfficeCli(["--version"]);
    return result.stdout || "unknown";
  } catch (error) {
    process.stderr.write(`OfficeCLI startup check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

async function acquireCommandSlot() {
  if (activeCommands < maximumConcurrentCommands) {
    activeCommands += 1;
    return releaseCommandSlot;
  }
  await new Promise((resolvePromise) => commandWaiters.push(resolvePromise));
  activeCommands += 1;
  return releaseCommandSlot;
}

function releaseCommandSlot() {
  activeCommands -= 1;
  commandWaiters.shift()?.();
}

function parseOfficeCliOutput(output) {
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function parseWarnings(stderr) {
  return stderr
    ? stderr
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function readCliErrorMessage(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const error = output.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    if (typeof error.error === "string") return error.error;
  }
  return typeof output.message === "string" ? output.message : undefined;
}

async function readJsonBody(request) {
  const bytes = await readRequestBytes(request, maxRequestBytes);
  if (bytes.length === 0) throw new HttpError(400, "A JSON request body is required", "invalid_json");
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed;
  } catch (error) {
    throw new HttpError(
      400,
      `Invalid JSON body: ${error instanceof Error ? error.message : "parse failed"}`,
      "invalid_json",
    );
  }
}

async function readRequestBytes(request, maximumBytes) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new HttpError(413, "Request body exceeds the configured limit", "request_too_large");
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maximumBytes)
      throw new HttpError(413, "Request body exceeds the configured limit", "request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(body.length),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message = error instanceof HttpError ? error.message : "Internal server error";
  if (status >= 500 && !(error instanceof HttpError)) process.stderr.write(`${error?.stack || String(error)}\n`);
  sendJson(response, status, {
    error: {
      code,
      message,
      ...(error instanceof HttpError && error.details !== undefined ? { details: error.details } : {}),
    },
  });
}

function decodeDocumentRoute(value) {
  try {
    return value
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw new HttpError(400, "Document path is not valid URL encoding", "invalid_path");
  }
}

function requiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${fieldName} is required`, "invalid_value");
  }
  return value.trim();
}

function optionalString(value, fieldName) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${fieldName} must be a string`, "invalid_value");
  return value.trim() || undefined;
}

function optionalBoolean(value, fieldName) {
  if (value == null) return false;
  if (typeof value !== "boolean") throw new HttpError(400, `${fieldName} must be a boolean`, "invalid_value");
  return value;
}

function optionalInteger(value, fieldName, minimum, maximum) {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpError(400, `${fieldName} must be an integer from ${minimum} to ${maximum}`, "invalid_value");
  }
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  if (value.length < 24) throw new Error(`${name} must contain at least 24 characters`);
  return value;
}

function readIntegerEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function safeHeaderFilename(value) {
  return value.replace(/[^\x20-\x21\x23-\x7e]/gu, "_");
}

function boundedMessage(value) {
  const normalized = String(value).trim();
  return normalized.length <= 4_000 ? normalized : `${normalized.slice(0, 3_999)}…`;
}

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
