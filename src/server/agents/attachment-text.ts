import { Worker } from "node:worker_threads";

export interface AttachmentTextResult {
  text?: string;
  warning?: string;
}

/** Extract document text off the server thread with a memory budget and deadline. */
export async function extractAttachmentText(
  file: File,
  signal?: AbortSignal,
): Promise<AttachmentTextResult | undefined> {
  const format =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name)
      ? "pdf"
      : /\.(docx?|dotx?)$/i.test(file.name) ||
          ["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(
            file.type,
          )
        ? "word"
        : undefined;
  if (!format) return undefined;
  if (signal?.aborted) throw signal.reason ?? new Error("Attachment reading cancelled.");
  if (file.size > 25 * 1024 * 1024) return { warning: "Document exceeds the 25 MiB text extraction limit." };
  const bytes = new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./attachment-text-worker.ts", import.meta.url), {
      workerData: { bytes, format },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    // Drain parser diagnostics without exposing document content in server logs.
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (result: AttachmentTextResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      resolve(result);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      reject(signal?.reason ?? new Error("Attachment reading cancelled."));
    };
    const timer = setTimeout(() => finish({ warning: "Document text extraction timed out." }), 15_000);
    worker.once("message", finish);
    worker.once("error", () =>
      finish({ warning: "Document text extraction failed. The file may be damaged, encrypted, or too complex." }),
    );
    worker.once("exit", () => finish({ warning: "Document text extraction ended without a result." }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
