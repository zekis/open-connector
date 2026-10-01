import type { AttachmentTextResult } from "./attachment-text.ts";

import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";
import WordExtractor from "word-extractor";

interface ExtractionInput {
  bytes: Uint8Array;
  format: "pdf" | "word";
}

const maxTextCharacters = 250_000;
const maxPdfPages = 200;

async function extract(input: ExtractionInput): Promise<AttachmentTextResult> {
  let text = "";
  let truncated = false;
  let emptyPages = false;
  if (input.format === "pdf") {
    const pdf = await getDocumentProxy(input.bytes, { useSystemFonts: false });
    try {
      truncated = pdf.numPages > maxPdfPages;
      for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, maxPdfPages); pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
          .join("")
          .trim();
        if (!pageText) emptyPages = true;
        text += `\n\n[Page ${pageNumber}]\n${pageText}`;
        page.cleanup();
        if (text.length > maxTextCharacters) {
          truncated = true;
          break;
        }
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
  } else {
    const doc = await new WordExtractor().extract(Buffer.from(input.bytes));
    text = [doc.getBody(), doc.getHeaders(), doc.getTextboxes(), doc.getFootnotes(), doc.getEndnotes()]
      .filter(Boolean)
      .join("\n\n");
    truncated = text.length > maxTextCharacters;
  }
  const warnings: string[] = [];
  if (truncated)
    warnings.push(`Extraction is partial (limit: ${maxTextCharacters} characters or ${maxPdfPages} PDF pages).`);
  if (emptyPages || !text.trim())
    warnings.push(
      "Some or all pages contain no extractable text. Scanned content or images may require OCR or visual inspection; do not assume the document is empty.",
    );
  return { text: text.slice(0, maxTextCharacters), warning: warnings.length ? warnings.join(" ") : undefined };
}

try {
  parentPort?.postMessage(await extract(workerData as ExtractionInput));
} catch {
  parentPort?.postMessage({
    warning:
      "Could not extract document text. The file may be damaged, password-protected, or unsupported. Do not claim to have read it.",
  });
}
