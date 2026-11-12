import type { ResumeDocument } from "@vervecv/documents";
import { useEffect, useState } from "react";

const SCALE = 1.25;

interface PreviewViewProps {
  document: ResumeDocument;
  fileBytes: Uint8Array | null;
}

export function PreviewView({ document, fileBytes }: PreviewViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(document.blocks[0]?.id ?? null);
  const selected = document.blocks.find((block) => block.id === selectedId) ?? null;
  const docx = document.mimeType !== "application/pdf";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        {docx || !fileBytes ? (
          <DocxPreview document={document} selectedId={selectedId} onSelect={setSelectedId} />
        ) : (
          <PdfPreview bytes={fileBytes} document={document} selectedId={selectedId} />
        )}
      </div>
      <aside className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Extracted text</h2>
        <ul className="mt-3 grid gap-2">
          {document.blocks.map((block) => (
            <li key={block.id}>
              <button
                className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selectedId === block.id ? "bg-amber-200" : "bg-slate-50"}`}
                onClick={() => setSelectedId(block.id)}
                onMouseEnter={() => setSelectedId(block.id)}
                type="button"
              >
                {block.text}
              </button>
            </li>
          ))}
        </ul>
        {selected ? <p className="mt-4 text-xs text-slate-500">UTF-16 offsets {selected.startOffset}–{selected.endOffset}</p> : null}
      </aside>
    </div>
  );
}

function DocxPreview({
  document,
  selectedId,
  onSelect,
}: {
  document: ResumeDocument;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <article className="grid gap-4">
      {document.sections.map((section) => (
        <section key={section.id}>
          {section.heading ? <h3 className="text-base font-semibold text-slate-950">{section.heading}</h3> : null}
          {section.blockIds.map((blockId) => {
            const block = document.blocks.find((item) => item.id === blockId);
            if (!block || block.type === "heading") {
              return null;
            }
            return (
              <p
                className={`mt-2 rounded px-2 py-1 ${selectedId === block.id ? "bg-amber-200" : ""}`}
                data-paragraph-id={block.paragraphId ?? block.id}
                key={block.id}
                onClick={() => onSelect(block.id)}
                onMouseEnter={() => onSelect(block.id)}
              >
                {block.text}
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
  selectedId,
}: {
  bytes: Uint8Array;
  document: ResumeDocument;
  selectedId: string | null;
}) {
  const pages = Array.isArray(document.metadata["pages"]) ? document.metadata["pages"] : [];
  const selected = document.blocks.find((block) => block.id === selectedId) ?? null;

  return (
    <div className="grid gap-4">
      {pages.map((page) => {
        const info = page as { page?: number; width?: number; height?: number };
        if (typeof info.page !== "number" || typeof info.width !== "number" || typeof info.height !== "number") {
          return null;
        }
        return (
          <PdfPage
            bytes={bytes}
            boxes={(selected?.boxes ?? []).filter((box) => box.page === info.page)}
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
  boxes: { x: number; y: number; width: number; height: number }[];
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
    <div className="relative inline-block bg-slate-100" style={{ width: width * SCALE, height: height * SCALE }}>
      <canvas ref={setCanvas} />
      {boxes.map((box, index) => (
        <span
          className="pointer-events-none absolute border-2 border-amber-500 bg-amber-300/40"
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

async function renderPage(bytes: Uint8Array, pageNumber: number, canvas: HTMLCanvasElement): Promise<void> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
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
    ? { getDocument: imported.getDocument, GlobalWorkerOptions: imported.GlobalWorkerOptions ?? { workerSrc: "" } }
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
