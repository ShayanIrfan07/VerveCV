import type { BoundingBox } from "@vervecv/evaluation";
import { DocumentAbortError, DocumentParseError, withTimeout } from "./errors.js";
import { matchesMagic } from "./magic.js";
import { toResumeDocument, type DocumentMeta, type SourceBlock } from "./model.js";
import type { PdfjsModule, PdfjsTextItem } from "./pdf-types.js";

export interface PdfLimits {
  pageCap: number | null;
  timeoutMs: number | null;
  signal?: AbortSignal;
}

let workerSrcOverride: string | null = null;

export function configurePdfWorker(workerSrc: string): void {
  workerSrcOverride = workerSrc;
}

export async function extractPdf(bytes: Uint8Array, meta: DocumentMeta, limits: PdfLimits): Promise<ReturnType<typeof toResumeDocument>> {
  if (!matchesMagic(bytes, "pdf")) {
    throw new DocumentParseError("UNSUPPORTED_TYPE");
  }
  const work = async (signal: AbortSignal): Promise<ReturnType<typeof toResumeDocument>> => {
    const pdfjs = await loadPdfjs();
    if (signal.aborted) {
      throw limits.signal?.aborted ? new DocumentAbortError() : new DocumentParseError("PARSE_TIMEOUT");
    }
    const loadingTask = pdfjs.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    const abort = (): void => {
      loadingTask.destroy();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const pdf = await loadingTask.promise;
      try {
        if (pdf.numPages < 1) {
          throw new DocumentParseError("CORRUPT");
        }
        if (limits.pageCap !== null && pdf.numPages > limits.pageCap) {
          throw new DocumentParseError("PDF_PAGE_LIMIT");
        }
        const blocks: SourceBlock[] = [];
        const pages: { page: number; width: number; height: number }[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          if (signal.aborted) {
            throw limits.signal?.aborted ? new DocumentAbortError() : new DocumentParseError("PARSE_TIMEOUT");
          }
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1 });
          pages.push({ page: pageNumber, width: viewport.width, height: viewport.height });
          const content = await page.getTextContent();
          blocks.push(...linesToBlocks(pageNumber, content.items));
        }
        const document = toResumeDocument(
          { ...meta, metadata: { ...meta.metadata, pages } },
          blocks,
        );
        if (document.blocks.every((block) => block.text.trim().length === 0)) {
          throw new DocumentParseError("NO_EXTRACTABLE_TEXT");
        }
        return document;
      } finally {
        await pdf.cleanup?.();
      }
    } catch (error) {
      if (error instanceof DocumentParseError || error instanceof DocumentAbortError) {
        throw error;
      }
      if (limits.signal?.aborted) {
        throw new DocumentAbortError();
      }
      const name = error instanceof Error ? error.name : "";
      if (name === "PasswordException") {
        throw new DocumentParseError("PASSWORD_PROTECTED");
      }
      throw new DocumentParseError("CORRUPT");
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  if (limits.timeoutMs === null) {
    return work(limits.signal ?? new AbortController().signal);
  }
  return withTimeout(limits.timeoutMs, work, limits.signal);
}

async function loadPdfjs(): Promise<PdfjsModule> {
  const imported = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as Partial<PdfjsModule> & {
    default?: Partial<PdfjsModule>;
  };
  const pdfjs = (imported.getDocument ? imported : imported.default) as PdfjsModule;
  if (workerSrcOverride) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrcOverride;
  } else if (!pdfjs.GlobalWorkerOptions.workerSrc && runningOnNode()) {
    const nodeSetup = (await import(/* @vite-ignore */ "./pdf-node.js")) as {
      configureNodePdfWorker: (module: PdfjsModule) => void;
    };
    nodeSetup.configureNodePdfWorker(pdfjs);
  }
  return pdfjs;
}

function linesToBlocks(pageNumber: number, items: unknown[]): SourceBlock[] {
  const textItems = items.filter(isTextItem).filter((item) => item.str.length > 0);
  const lines: PdfjsTextItem[][] = [];
  for (const item of textItems) {
    const y = item.transform[5] ?? 0;
    const current = lines[lines.length - 1];
    const currentY = current?.[0]?.transform[5] ?? y;
    if (!current || Math.abs(currentY - y) > 2) {
      lines.push([item]);
    } else {
      current.push(item);
    }
  }
  lines.sort((left, right) => (right[0]?.transform[5] ?? 0) - (left[0]?.transform[5] ?? 0));
  return lines.map((line) => lineToBlock(pageNumber, line));
}

function lineToBlock(pageNumber: number, line: PdfjsTextItem[]): SourceBlock {
  const ordered = [...line].sort((left, right) => (left.transform[4] ?? 0) - (right.transform[4] ?? 0));
  let text = "";
  const boxes: BoundingBox[] = [];
  for (const item of ordered) {
    const x = item.transform[4] ?? 0;
    const previous = boxes[boxes.length - 1];
    if (text.length > 0 && previous && x - (previous.x + previous.width) > 1) {
      text += " ";
    }
    text += item.str;
    const height = item.height || Math.abs(item.transform[3] ?? 0);
    if (item.width > 0 && height > 0) {
      boxes.push({
        page: pageNumber,
        x,
        y: item.transform[5] ?? 0,
        width: item.width,
        height,
      });
    }
  }
  const style = sharedStyle(ordered);
  const bullet = /^[-*•●·]\s+/u.test(text.trim());
  return {
    text: text.trim(),
    type: bullet ? "bullet" : "paragraph",
    page: pageNumber,
    ...(boxes.length > 0 ? { boxes } : {}),
    ...(style ? { style } : {}),
  };
}

function sharedStyle(items: PdfjsTextItem[]): Record<string, unknown> | undefined {
  const sizes = items.map((item) => Math.round(Math.abs(item.transform[3] ?? item.height) * 10) / 10);
  const fonts = items.map((item) => item.fontName).filter((font): font is string => typeof font === "string" && font.length > 0);
  const style: Record<string, unknown> = {};
  if (sizes.length > 0 && sizes.every((size) => size === sizes[0])) {
    style["fontSize"] = sizes[0];
  }
  if (fonts.length === items.length && fonts.every((font) => font === fonts[0])) {
    style["fontFamily"] = fonts[0];
    if (/bold/i.test(fonts[0] ?? "")) {
      style["bold"] = true;
    }
    if (/italic|oblique/i.test(fonts[0] ?? "")) {
      style["italic"] = true;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function runningOnNode(): boolean {
  const runtime = globalThis as { process?: { versions?: { node?: string } } };
  return typeof runtime.process?.versions?.node === "string";
}

function isTextItem(item: unknown): item is PdfjsTextItem {
  if (typeof item !== "object" || item === null || !("str" in item)) {
    return false;
  }
  const candidate = item as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
  return typeof candidate.str === "string" && Array.isArray(candidate.transform) && typeof candidate.width === "number";
}
