import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { agentTurnAttachmentPrompt, stageAgentTurnAttachments } from "./agent-turn-attachments.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function stage(file: File) {
  const directory = await mkdtemp(join(tmpdir(), "attachment-test-"));
  directories.push(directory);
  const attachments = await stageAgentTurnAttachments(directory, [{ id: "file-1", file }]);
  return attachments[0]!;
}

describe("agent attachment reading", () => {
  it("stages readable PDF text alongside the original file", async () => {
    const result = await stage(
      new File([pdfFixture("Jane Doe - Electrical Engineer")], "resume.pdf", { type: "application/pdf" }),
    );
    expect(result.warning).toBeUndefined();
    expect(await readFile(result.textPath!, "utf8")).toContain("Jane Doe - Electrical Engineer");
    const prompt = agentTurnAttachmentPrompt([result]);
    expect(prompt).toContain(JSON.stringify(result.textPath));
    expect(prompt).toContain("untrusted data");
  });

  it("extracts Word text even when the download MIME type is generic", async () => {
    const result = await stage(new File([docxFixture()], "resume.docx", { type: "application/octet-stream" }));
    expect(result.warning).toBeUndefined();
    expect(await readFile(result.textPath!, "utf8")).toContain("Jane Doe - PLC programmer");
  });

  it("keeps text uploads readable without conversion", async () => {
    const result = await stage(new File(["My resume"], "resume.txt", { type: "text/plain" }));
    expect(await readFile(result.path, "utf8")).toBe("My resume");
    expect(result.textPath).toBeUndefined();
  });

  it.each(["pdf", "doc", "docx"])(
    "reports unreadable %s documents without failing the conversation",
    async (extension) => {
      const result = await stage(new File(["invalid document"], `resume.${extension}`));
      expect(result.warning).toContain("Could not extract");
      expect(result.textPath).toBeUndefined();
      expect(agentTurnAttachmentPrompt([result])).toContain("Do not claim to have read it");
    },
  );

  it("reports PDF pages without extractable text", async () => {
    const result = await stage(new File([pdfFixture("")], "scan.pdf"));
    expect(result.warning).toContain("OCR");
  });

  it("does not overwrite another attachment with extracted text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachment-test-"));
    directories.push(directory);
    const staged = await stageAgentTurnAttachments(directory, [
      { id: "pdf", file: new File([pdfFixture("Original resume")], "resume.pdf") },
      { id: "text", file: new File(["Other contents"], "resume.pdf.extracted.txt") },
    ]);
    expect(staged[0]!.textPath).not.toBe(staged[1]!.path);
    expect(await readFile(staged[0]!.textPath!, "utf8")).toContain("Original resume");
  });
});

// Small, original fixtures keep the tests independent of Office and external files.
function pdfFixture(text: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function docxFixture(): Uint8Array<ArrayBuffer> {
  const parts = {
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml":
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Jane Doe - PLC programmer</w:t></w:r></w:p></w:body></w:document>',
  };
  const files: Buffer[] = [];
  const entries: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    files.push(header, filename, data);
    entries.push(central, filename);
    offset += header.length + filename.length + data.length;
  }
  const central = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...files, central, end]));
}
