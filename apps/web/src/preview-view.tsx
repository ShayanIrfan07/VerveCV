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
  const [selectedId, setSelectedId] = useState<string | null>(document.blocks[0]?.id ?? null);

  useEffect(() => {
    setSelectedId(document.blocks[0]?.id ?? null);
  }, [document]);

  const activeBlockId = highlight?.blockId ?? selectedId;
  const activeBlock = document.blocks.find((block) => block.id === activeBlockId) ?? null;
  const activeLocator =
    highlight && activeBlock && highlight.blockId === activeBlock.id ? highlight : null;
  const activeSpan = activeBlock ? resolveBlockSpan(activeBlock, activeLocator) : null;
  const docx = document.mimeType !== "application/pdf";

  const pdfGeometry =
    !docx && fileBytes ? computePdfHighlightBoxes(activeBlock, activeLocator) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
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
        <ul className="mt-3 grid gap-2">
          {document.blocks.map((block) => {
            const isTarget = activeBlockId === block.id;
            const spanForBlock = isTarget ? activeSpan : null;
            return (
              <li key={block.id}>
                <button
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                    isTarget ? "bg-amber-100 ring-1 ring-amber-400" : "bg-slate-50"
                  }`}
                  data-block-id={block.id}
                  onClick={() => setSelectedId(block.id)}
                  onMouseEnter={() => setSelectedId(block.id)}
                  type="button"
                >
                  <HighlightedText span={spanForBlock} text={block.text} />
                </button>
              </li>
            );
          })}
        </ul>
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

function HighlightedText({
  text,
  span,
}: {
  text: string;
  span: NormalizedSpan | null;
}) {
  if (!span) {
    return <>{text}</>;
  }
  const before = text.slice(0, span.startOffset);
  const target = text.slice(span.startOffset, span.endOffset);
  const after = text.slice(span.endOffset);
  return (
    <>
      {before}
      <mark className="rounded bg-amber-300 px-0.5 text-slate-950" data-testid="utf16-highlight-mark">
        {target}
      </mark>
      {after}
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
                className={`mt-2 rounded px-2 py-1 ${
                  isTarget && !spanForBlock ? "bg-amber-200" : isTarget ? "bg-amber-50" : ""
                }`}
                data-paragraph-id={block.paragraphId ?? block.id}
                key={block.id}
                onClick={() => onSelect(block.id)}
                onMouseEnter={() => onSelect(block.id)}
              >
                <HighlightedText span={spanForBlock} text={block.text} />
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
      className="relative inline-block bg-slate-100"
      style={{ width: width * SCALE, height: height * SCALE }}
    >
      <canvas ref={setCanvas} />
      {boxes.map((box, index) => (
        <span
          className="pointer-events-none absolute border-2 border-amber-500 bg-amber-300/40"
          data-precision={box.precision}
          data-testid="pdf-highlight-box"
          key={`${box.x}-${box.y}-${index}`}
          style={{
            left: box.x * SCALE,
            top: (height - box.y - box.height) * SCALE,
            width: box.width * SCALE,
            height: box.height * SCALE,
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
