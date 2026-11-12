import { describe, expect, it } from "vitest";
import { DocumentParseError, withTimeout } from "./errors.js";
import { extractDocx } from "./docx.js";
import { extractPdf } from "./pdf.js";
import { classifyHeading } from "./headings.js";
import { corruptPdfBytes, emptyPdfBytes, encryptedDocxBytes, sampleDocxBytes, samplePdfBytes } from "./samples.js";
import { readDocxPackage } from "./zip.js";
import { createDeflateZip } from "./zip-node.js";
import { createStoredZip } from "./zip-write.js";

const meta = {
  filename: "Sample_Resume.pdf",
  mimeType: "application/pdf",
  sourceHash: "abc",
  metadata: {},
};

describe("document extraction", () => {
  it("classifies only an exact known heading", () => {
    expect(classifyHeading("Work Experience")).toBe("WORK_EXPERIENCE");
    expect(classifyHeading("Others")).toBeNull();
    expect(classifyHeading("I have work experience in finance")).toBeNull();
  });

  it("extracts PDF text, pages, and user-space boxes", async () => {
    const document = await extractPdf(samplePdfBytes(), meta, { pageCap: 5, timeoutMs: 10_000 });
    expect(document.blocks.map((block) => block.text)).toEqual(["Work Experience", "Shipped the export pipeline."]);
    expect(document.sections[0]?.kind).toBe("WORK_EXPERIENCE");
    expect(document.blocks[0]?.boxes?.[0]).toMatchObject({ page: 1 });
    expect(document.blocks[0]?.startOffset).toBe(0);
    expect(document.metadata["nonTextContentRead"]).toBe(false);
    const pages = document.metadata["pages"] as { page: number }[];
    expect(pages).toHaveLength(1);
  });

  it("rejects an image-only PDF, a corrupt PDF, and a page cap", async () => {
    await expect(extractPdf(emptyPdfBytes(), meta, { pageCap: 5, timeoutMs: 10_000 })).rejects.toMatchObject({
      code: "NO_EXTRACTABLE_TEXT",
    });
    await expect(extractPdf(corruptPdfBytes(), meta, { pageCap: 5, timeoutMs: 10_000 })).rejects.toMatchObject({
      code: "CORRUPT",
    });
    await expect(extractPdf(samplePdfBytes(), meta, { pageCap: 0, timeoutMs: 10_000 })).rejects.toMatchObject({
      code: "PDF_PAGE_LIMIT",
    });
  });

  it("extracts DOCX paragraphs without fabricating pages", async () => {
    const document = await extractDocx(
      sampleDocxBytes(),
      { ...meta, filename: "Sample_Resume.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { entryCap: 10, uncompressedBytes: 100_000, timeoutMs: 10_000 },
    );
    expect(document.blocks.map((block) => block.text)).toContain("Work Experience");
    expect(document.blocks.every((block) => block.page === undefined && block.boxes === undefined)).toBe(true);
    const body = document.blocks.find((block) => block.text.includes("pipeline"));
    expect(body?.style).toMatchObject({ bold: true });
    expect(body?.paragraphId).toMatch(/^p-/);
  });

  it("rejects an encrypted DOCX before decompression limits are required", async () => {
    await expect(readDocxPackage(encryptedDocxBytes(), null)).rejects.toBeInstanceOf(DocumentParseError);
    await expect(readDocxPackage(encryptedDocxBytes(), null)).rejects.toMatchObject({ code: "PASSWORD_PROTECTED" });
  });

  it("stops a DOCX whose inflated size exceeds the configured cap", async () => {
    const encoder = new TextEncoder();
    const bomb = createDeflateZip([
      { name: "[Content_Types].xml", data: encoder.encode("<Types></Types>") },
      { name: "word/document.xml", data: new Uint8Array(80_000), declaredUncompressedSize: 20 },
    ]);
    await expect(readDocxPackage(bomb, { entryCap: 10, uncompressedBytes: 1_000 })).rejects.toMatchObject({
      code: "ZIP_LIMIT_EXCEEDED",
    });
  });

  it("rejects a DOCX with too many entries", async () => {
    const encoder = new TextEncoder();
    const files = [
      { name: "[Content_Types].xml", data: encoder.encode("<Types></Types>") },
      { name: "word/document.xml", data: encoder.encode("<w:document/>") },
      { name: "word/extra-1.xml", data: encoder.encode("a") },
    ];
    await expect(readDocxPackage(createStoredZip(files), { entryCap: 2, uncompressedBytes: 10_000 })).rejects.toMatchObject({
      code: "ZIP_LIMIT_EXCEEDED",
    });
  });

  it("times out a stalled parse", async () => {
    await expect(withTimeout(15, () => new Promise(() => undefined))).rejects.toMatchObject({ code: "PARSE_TIMEOUT" });
  });
});
