import type { ResumeDocument } from "@vervecv/documents";
import { useEffect, useState } from "react";
import type { EvidenceLocator } from "./score-panel";

const SCALE = 1.25;

export interface NormalizedSpan {
  startOffset: number;
  endOffset: number;
}

export interface PdfOverlayBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  precision: "subspan" | "block-fallback";
}

interface PreviewViewProps {
  document: ResumeDocument;
  fileBytes: Uint8Array | null;
  highlight?: EvidenceLocator | null;
}

/**
 * Resolves a safe UTF-16 `[startOffset, endOffset)` slice for a block when a finding
 * locator supplies offsets. Handles both block-relative (`0..text.length`) and
 * document-relative (`block.startOffset..block.endOffset`) UTF-16 offsets, returning
 * `null` when no valid sub-span is available so callers highlight the whole block.
 */
export function resolveBlockSpan(
  block: { text: string; startOffset: number; endOffset: number },
  locator: EvidenceLocator | null | undefined,
): NormalizedSpan | null {
  if (!locator) {
    return null;
  }
  const rawStart = locator.startOffset;
  const rawEnd = locator.endOffset;
  if (
    typeof rawStart !== "number" ||
    typeof rawEnd !== "number" ||
    !Number.isFinite(rawStart) ||
    !Number.isFinite(rawEnd)
  ) {
    return null;
  }

  let start = Math.trunc(rawStart);
  let end = Math.trunc(rawEnd);

  if (
    start >= 0 &&
    end <= block.text.length &&
    start < end
  ) {
    return clampUtf16Slice(block.text, start, end);
  }

  if (
    block.startOffset > 0 &&
    start >= block.startOffset &&
    end <= block.endOffset &&
    start < end
  ) {
    start -= block.startOffset;
    end -= block.startOffset;
    return clampUtf16Slice(block.text, start, end);
  }

  return null;
}

function clampUtf16Slice(text: string, start: number, end: number): NormalizedSpan | null {
  let safeStart = Math.max(0, Math.min(start, text.length));
  let safeEnd = Math.max(safeStart, Math.min(end, text.length));

  // Avoid splitting a UTF-16 surrogate pair in the middle of a character
  if (safeStart > 0 && safeStart < text.length) {
    const code = text.charCodeAt(safeStart);
    if (code >= 0xdc00 && code <= 0xdfff) {
      safeStart -= 1;
    }
  }
  if (safeEnd > safeStart && safeEnd < text.length) {
    const code = text.charCodeAt(safeEnd);
    if (code >= 0xdc00 && code <= 0xdfff) {
      safeEnd += 1;
    }
  }

  return safeEnd > safeStart ? { startOffset: safeStart, endOffset: safeEnd } : null;
}

const MARKDOWN_LINK = /\[([^\][]+)\]\(([^()\s]+)\)/gu;

export interface DisplayPiece {
  rawStart: number;
  rawEnd: number;
  text: string;
  visible: boolean;
}

/**
 * Splits Markdown links for display. The raw string, including `[label](url)`, stays the
 * authoritative text so UTF-16 evidence offsets do not move.
 */
export function displayPieces(text: string): DisplayPiece[] {
  const pieces: DisplayPiece[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const start = match.index ?? 0;
    const label = match[1] ?? "";
    const full = match[0] ?? "";
    if (label.length === 0 || full.length === 0) {
      continue;
    }
    if (start > cursor) {
      pieces.push({
        rawStart: cursor,
        rawEnd: start,
        text: text.slice(cursor, start),
        visible: true,
      });
    }
    const labelStart = start + 1;
    const labelEnd = labelStart + label.length;
    pieces.push({ rawStart: start, rawEnd: labelStart, text: "[", visible: false });
    pieces.push({ rawStart: labelStart, rawEnd: labelEnd, text: label, visible: true });
    pieces.push({
      rawStart: labelEnd,
      rawEnd: start + full.length,
      text: text.slice(labelEnd, start + full.length),
      visible: false,
    });
    cursor = start + full.length;
  }
  if (cursor < text.length || pieces.length === 0) {
    pieces.push({
      rawStart: cursor,
      rawEnd: text.length,
      text: text.slice(cursor),
      visible: true,
    });
  }
  return pieces;
}

export interface CoverageSlice {
  start: number;
  end: number;
  depth: number;
}

/** Splits a string at evidence boundaries, including overlaps, without rewriting the text. */
export function coverageSlices(length: number, spans: readonly NormalizedSpan[]): CoverageSlice[] {
  if (length <= 0) {
    return [];
  }
  const normalized = spans
    .map((span) => ({
      start: Math.max(0, Math.min(length, Math.trunc(span.startOffset))),
      end: Math.max(0, Math.min(length, Math.trunc(span.endOffset))),
    }))
    .filter((span) => span.end > span.start);
  const bounds = new Set<number>([0, length]);
  for (const span of normalized) {
    bounds.add(span.start);
    bounds.add(span.end);
  }
  const points = [...bounds].sort((left, right) => left - right);
  const slices: CoverageSlice[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const depth = normalized.filter((span) => span.start <= start && span.end >= end).length;
    slices.push({ start, end, depth });
  }
  return slices;
}

/**
 * Computes PDF highlight rectangles for a target block + optional UTF-16 sub-span.
 *
 * - When a single-line horizontal bounding envelope exists and a valid UTF-16 sub-span is
 *   provided, projects the sub-span proportionally onto the measured line box (`precision: "subspan"`).
 * - When sub-span geometry is unavailable (e.g. multi-line boxes, whole-block selection),
 *   falls back cleanly to the measured block boxes (`precision: "block-fallback"`).
 * - When the PDF block has no measured boxes at all, returns `[]` and sets `usedTextFallback: true`
 *   so the UI surfaces a safe text-sidebar highlight fallback instead of drawing fake coordinates.
 */
export function computePdfHighlightBoxes(
  block: ResumeDocument["blocks"][number] | null,
  locator: EvidenceLocator | null | undefined,
): { boxes: PdfOverlayBox[]; usedTextFallback: boolean } {
  if (!block) {
    return { boxes: [], usedTextFallback: false };
  }

  const rawBoxes = (block.boxes ?? []).filter(
    (box) =>
      Number.isFinite(box.page) &&
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      box.width > 0 &&
      box.height > 0,
  );

  if (rawBoxes.length === 0) {
    return { boxes: [], usedTextFallback: true };
  }

  const pageBoxes =
    locator?.page !== undefined
      ? rawBoxes.filter((box) => box.page === locator.page)
      : rawBoxes;
  const effectiveBoxes = pageBoxes.length > 0 ? pageBoxes : rawBoxes;

  const span = resolveBlockSpan(block, locator);
  if (!span || block.text.length === 0) {
    return {
      boxes: effectiveBoxes.map((box) => ({ ...box, precision: "block-fallback" })),
      usedTextFallback: false,
    };
  }

  const firstBox = effectiveBoxes[0]!;
  const sameLine = effectiveBoxes.every(
    (box) => box.page === firstBox.page && Math.abs(box.y - firstBox.y) <= 3,
  );

  if (!sameLine) {
    return {
      boxes: effectiveBoxes.map((box) => ({ ...box, precision: "block-fallback" })),
      usedTextFallback: false,
    };
  }

  const minX = Math.min(...effectiveBoxes.map((box) => box.x));
  const maxX = Math.max(...effectiveBoxes.map((box) => box.x + box.width));
  const minY = Math.min(...effectiveBoxes.map((box) => box.y));
  const maxY = Math.max(...effectiveBoxes.map((box) => box.y + box.height));
  const totalWidth = maxX - minX;

  if (totalWidth <= 0) {
    return {
      boxes: effectiveBoxes.map((box) => ({ ...box, precision: "block-fallback" })),
      usedTextFallback: false,
    };
  }

  const startRatio = span.startOffset / block.text.length;
  const endRatio = span.endOffset / block.text.length;
  const subX = minX + totalWidth * startRatio;
  const subWidth = Math.max(4, totalWidth * (endRatio - startRatio));

  return {
    boxes: [
      {
        page: firstBox.page,
        x: subX,
        y: minY,
        width: Math.min(subWidth, maxX - subX),
        height: maxY - minY,
        precision: "subspan",
      },
    ],
    usedTextFallback: false,
  };
}

export function PreviewView({ document, fileBytes, highlight = null }: PreviewViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [document]);

  const activeBlockId = highlight?.blockId ?? selectedId;
  const activeBlock = document.blocks.find((block) => block.id === activeBlockId) ?? null;
  const activeLocator =
    highlight && activeBlock && highlight.blockId === activeBlock.id ? highlight : null;
  const activeSpan = activeBlock ? resolveBlockSpan(activeBlock, activeLocator) : null;
  const docx = document.mimeType !== "application/pdf";
  const evidenceBlock = highlight
    ? (document.blocks.find((block) => block.id === highlight.blockId) ?? null)
    : null;

  const pdfGeometry =
    !docx && fileBytes && highlight ? computePdfHighlightBoxes(evidenceBlock, highlight) : null;

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
        {docx || !fileBytes ? (
          <DocxPreview
            activeBlockId={activeBlockId}
            activeSpan={activeSpan}
            document={document}
            onSelect={setSelectedId}
          />
        ) : (
          <PdfPreview
            bytes={fileBytes}
            document={document}
            overlayBoxes={pdfGeometry?.boxes ?? []}
            usedTextFallback={pdfGeometry?.usedTextFallback ?? false}
          />
        )}
      </div>
      <aside className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Extracted text
        </h2>
        <div className="mt-4 space-y-5">
          {document.sections.map((section) => (
            <section className="space-y-1" data-section-id={section.id} key={section.id}>
              {section.blockIds.map((blockId) => {
                const block = document.blocks.find((item) => item.id === blockId);
                if (!block) {
                  return null;
                }
                const isTarget = activeBlockId === block.id;
                const spanForBlock = isTarget ? activeSpan : null;
                return (
                  <button
                    className={extractedBlockClass(block.type, isTarget && spanForBlock === null)}
                    data-block-id={block.id}
                    data-block-type={block.type}
                    data-raw-length={block.text.length}
                    key={block.id}
                    onClick={() => setSelectedId(block.id)}
                    onMouseEnter={() => setSelectedId(block.id)}
                    type="button"
                  >
                    {block.type === "bullet" ? (
                      <span aria-hidden="true" className="mr-2 text-slate-400">
                        •
                      </span>
                    ) : null}
                    <EvidenceText spans={spanForBlock ? [spanForBlock] : []} text={block.text} />
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        {activeBlock ? (
          <p className="mt-4 text-xs text-slate-500" data-testid="utf16-offset-caption">
            {activeSpan
              ? `UTF-16 span ${activeSpan.startOffset}–${activeSpan.endOffset} in ${activeBlock.id}`
              : `UTF-16 offsets ${activeBlock.startOffset}–${activeBlock.endOffset}`}
          </p>
        ) : null}
      </aside>
    </div>
  );
}

function extractedBlockClass(type: string, quietSelection: boolean): string {
  const selection = quietSelection ? "border-l-2 border-slate-300 pl-2" : "";
  if (type === "heading") {
    return `block w-full whitespace-pre-wrap break-words py-1 text-left text-base font-semibold leading-6 text-slate-950 ${selection}`;
  }
  if (type === "bullet") {
    return `block w-full whitespace-pre-wrap break-words py-0.5 pl-1 text-left text-sm leading-6 text-slate-800 ${selection}`;
  }
  return `block w-full whitespace-pre-wrap break-words py-0.5 text-left text-sm leading-6 text-slate-800 ${selection}`;
}

export function EvidenceText({
  text,
  spans,
}: {
  text: string;
  spans: readonly NormalizedSpan[];
}) {
  const pieces = displayPieces(text);
  const coverage = coverageSlices(text.length, spans);
  return (
    <>
      {pieces.map((piece) => {
        const parts = coverage.filter((slice) => slice.end > piece.rawStart && slice.start < piece.rawEnd);
        const chunks = parts.length > 0 ? parts : [{ start: piece.rawStart, end: piece.rawEnd, depth: 0 }];
        return chunks.map((chunk) => {
          const start = Math.max(chunk.start, piece.rawStart);
          const end = Math.min(chunk.end, piece.rawEnd);
          const value = text.slice(start, end);
          const marked = chunk.depth > 0;
          return (
            <span
              className={piece.visible ? undefined : "hidden"}
              data-markdown-syntax={piece.visible ? undefined : "true"}
              data-visible-text={piece.visible ? "true" : undefined}
              key={`${piece.rawStart}-${start}-${end}`}
            >
              {marked ? (
                <mark
                  className={
                    chunk.depth > 1
                      ? "bg-amber-200/70 text-inherit underline decoration-amber-700 decoration-2 underline-offset-2"
                      : "bg-amber-100/60 text-inherit underline decoration-amber-600/80 underline-offset-2"
                  }
                  data-evidence-depth={chunk.depth}
                  data-testid="utf16-highlight-mark"
                >
                  {value}
                </mark>
              ) : (
                value
              )}
            </span>
          );
        });
      })}
    </>
  );
}

function DocxPreview({
  document,
  activeBlockId,
  activeSpan,
  onSelect,
}: {
  document: ResumeDocument;
  activeBlockId: string | null;
  activeSpan: NormalizedSpan | null;
  onSelect: (id: string) => void;
}) {
  return (
    <article className="grid gap-4">
      {document.sections.map((section) => (
        <section key={section.id}>
          {section.heading ? (
            <h3 className="text-base font-semibold text-slate-950">{section.heading}</h3>
          ) : null}
          {section.blockIds.map((blockId) => {
            const block = document.blocks.find((item) => item.id === blockId);
            if (!block || block.type === "heading") {
              return null;
            }
            const isTarget = activeBlockId === block.id;
            const spanForBlock = isTarget ? activeSpan : null;
            return (
              <p
                className={`mt-2 whitespace-pre-wrap break-words leading-7 ${
                  block.type === "heading"
                    ? "text-base font-semibold text-slate-950"
                    : block.type === "bullet"
                      ? "pl-4 text-sm text-slate-800"
                      : "text-sm text-slate-800"
                } ${isTarget && !spanForBlock ? "border-l-2 border-slate-300 pl-3" : ""}`}
                data-paragraph-id={block.paragraphId ?? block.id}
                key={block.id}
                onClick={() => onSelect(block.id)}
                onMouseEnter={() => onSelect(block.id)}
              >
                <EvidenceText spans={spanForBlock ? [spanForBlock] : []} text={block.text} />
              </p>
            );
          })}
        </section>
      ))}
    </article>
  );
}

function PdfPreview({
  bytes,
  document,
  overlayBoxes,
  usedTextFallback,
}: {
  bytes: Uint8Array;
  document: ResumeDocument;
  overlayBoxes: PdfOverlayBox[];
  usedTextFallback: boolean;
}) {
  const pages = Array.isArray(document.metadata["pages"]) ? document.metadata["pages"] : [];

  return (
    <div className="grid gap-4">
      {usedTextFallback ? (
        <p
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950"
          data-testid="pdf-position-fallback"
        >
          Exact PDF coordinates are unavailable for this finding; highlighted in the extracted text panel.
        </p>
      ) : null}
      {pages.map((page) => {
        const info = page as { page?: number; width?: number; height?: number };
        if (
          typeof info.page !== "number" ||
          typeof info.width !== "number" ||
          typeof info.height !== "number"
        ) {
          return null;
        }
        return (
          <PdfPage
            boxes={overlayBoxes.filter((box) => box.page === info.page)}
            bytes={bytes}
            height={info.height}
            key={info.page}
            pageNumber={info.page}
            width={info.width}
          />
        );
      })}
    </div>
  );
}

function PdfPage({
  bytes,
  pageNumber,
  width,
  height,
  boxes,
}: {
  bytes: Uint8Array;
  pageNumber: number;
  width: number;
  height: number;
  boxes: PdfOverlayBox[];
}) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvas) {
      return;
    }
    let cancelled = false;
    void renderPage(bytes, pageNumber, canvas).catch(() => {
      if (!cancelled) {
        canvas.replaceChildren();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bytes, canvas, pageNumber]);

  return (
    <div
      className="relative mx-auto w-full max-w-full bg-slate-100"
      style={{ maxWidth: width * SCALE, aspectRatio: `${width} / ${height}` }}
    >
      <canvas className="absolute inset-0 h-full w-full" ref={setCanvas} />
      {boxes.map((box, index) => (
        <span
          className="pointer-events-none absolute border-b-2 border-amber-700/80 bg-amber-200/15"
          data-precision={box.precision}
          data-testid="pdf-highlight-box"
          key={`${box.x}-${box.y}-${index}`}
          style={{
            left: `${(box.x / width) * 100}%`,
            top: `${((height - box.y - box.height) / height) * 100}%`,
            width: `${(box.width / width) * 100}%`,
            height: `${(box.height / height) * 100}%`,
            mixBlendMode: "multiply",
          }}
        />
      ))}
    </div>
  );
}

async function renderPage(
  bytes: Uint8Array,
  pageNumber: number,
  canvas: HTMLCanvasElement,
): Promise<void> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: SCALE });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context || !page.render) {
      return;
    }
    await page.render({ canvasContext: context, canvas, viewport }).promise;
  } finally {
    await pdf.cleanup?.();
  }
}

async function loadPdfjs(): Promise<{
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocument>; destroy(): void };
  GlobalWorkerOptions: { workerSrc: string };
}> {
  await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
  const imported = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument?: (params: Record<string, unknown>) => { promise: Promise<PdfDocument>; destroy(): void };
    GlobalWorkerOptions?: { workerSrc: string };
    default?: {
      getDocument: (params: Record<string, unknown>) => { promise: Promise<PdfDocument>; destroy(): void };
      GlobalWorkerOptions: { workerSrc: string };
    };
  };
  const pdfjs = imported.getDocument
    ? {
        getDocument: imported.getDocument,
        GlobalWorkerOptions: imported.GlobalWorkerOptions ?? { workerSrc: "" },
      }
    : imported.default;
  if (!pdfjs?.getDocument) {
    throw new Error("PDF parser is unavailable");
  }
  return pdfjs;
}

interface PdfDocument {
  getPage(pageNumber: number): Promise<{
    getViewport(params: { scale: number }): { width: number; height: number };
    render?: (params: {
      canvasContext: CanvasRenderingContext2D;
      canvas: HTMLCanvasElement;
      viewport: { width: number; height: number };
    }) => { promise: Promise<void> };
  }>;
  cleanup?: () => Promise<void>;
}
