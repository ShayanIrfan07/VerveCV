// @vitest-environment jsdom
import type { ResumeDocument } from "@vervecv/documents";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computePdfHighlightBoxes,
  coverageSlices,
  displayPieces,
  EvidenceText,
  PreviewView,
  resolveBlockSpan,
} from "./preview-view";
import { UploadPanel } from "./upload-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
};

function buildDocxDocument(
  id: string,
  filename: string,
  bulletText: string,
): ResumeDocument {
  const heading = "Work Experience";
  const b0End = heading.length;
  const b1Start = b0End + 1;
  const b1End = b1Start + bulletText.length;
  return {
    id,
    version: 1,
    filename,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sourceHash: id,
    parserVersion: "test",
    sections: [
      {
        id: "section-0",
        kind: "WORK_EXPERIENCE",
        heading,
        blockIds: ["block-0", "block-1"],
      },
    ],
    blocks: [
      {
        id: "block-0",
        sectionId: "section-0",
        type: "heading",
        text: heading,
        startOffset: 0,
        endOffset: b0End,
        paragraphId: "p-0",
      },
      {
        id: "block-1",
        sectionId: "section-0",
        type: "bullet",
        text: bulletText,
        startOffset: b1Start,
        endOffset: b1End,
        paragraphId: "p-1",
      },
    ],
    metadata: {},
  };
}

function buildPdfDocumentWithoutBoxes(): ResumeDocument {
  const text = "Recieve webhooks in production";
  return {
    id: "pdf-no-boxes",
    version: 1,
    filename: "ScanFallback_Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "pdf-no-boxes",
    parserVersion: "test",
    sections: [
      {
        id: "section-0",
        kind: "WORK_EXPERIENCE",
        heading: "",
        blockIds: ["block-0"],
      },
    ],
    blocks: [
      {
        id: "block-0",
        sectionId: "section-0",
        type: "bullet",
        text,
        startOffset: 0,
        endOffset: text.length,
        page: 1,
        // Intentionally omit `boxes` to exercise PDF coordinate fallback
      },
    ],
    metadata: { pages: [] },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("PreviewView UTF-16 offset highlights and PDF fallbacks", () => {
  it("projects sub-span UTF-16 offsets onto single-line PDF boxes and falls back safely when coordinates are missing", () => {
    const blockWithBox: ResumeDocument["blocks"][number] = {
      id: "block-1",
      sectionId: "section-0",
      type: "bullet",
      text: "Built teh teh pipeline",
      startOffset: 20,
      endOffset: 42,
      page: 1,
      boxes: [{ page: 1, x: 72, y: 680, width: 220, height: 12 }],
    };

    expect(
      resolveBlockSpan(blockWithBox, { blockId: "block-1", startOffset: 6, endOffset: 13 }),
    ).toEqual({ startOffset: 6, endOffset: 13 });

    // Document-relative offsets also normalize cleanly
    expect(
      resolveBlockSpan(blockWithBox, { blockId: "block-1", startOffset: 26, endOffset: 33 }),
    ).toEqual({ startOffset: 6, endOffset: 13 });

    const subspanResult = computePdfHighlightBoxes(blockWithBox, {
      blockId: "block-1",
      startOffset: 6,
      endOffset: 13,
      page: 1,
    });
    expect(subspanResult.usedTextFallback).toBe(false);
    expect(subspanResult.boxes).toHaveLength(1);
    expect(subspanResult.boxes[0]?.precision).toBe("subspan");
    expect(subspanResult.boxes[0]?.x).toBeGreaterThan(72);
    expect(subspanResult.boxes[0]?.width).toBeLessThan(220);

    // Block with no measured PDF boxes triggers safe text fallback instead of fake coordinates
    const blockWithoutBoxes: ResumeDocument["blocks"][number] = {
      ...blockWithBox,
      boxes: undefined,
    };
    const fallbackResult = computePdfHighlightBoxes(blockWithoutBoxes, {
      blockId: "block-1",
      startOffset: 6,
      endOffset: 13,
    });
    expect(fallbackResult).toEqual({ boxes: [], usedTextFallback: true });
  });

  it("renders exact UTF-16 <mark> slices in DOCX and shows a fallback notice when PDF coordinates are unavailable", async () => {
    const docx = buildDocxDocument("doc-1", "Resume.docx", "🚀 Built teh teh pipeline today");
    const startOffset = docx.blocks[1]!.text.indexOf("teh teh");
    const endOffset = startOffset + "teh teh".length;

    await act(async () => {
      root.render(
        <PreviewView
          document={docx}
          fileBytes={new Uint8Array([1, 2, 3])}
          highlight={{ blockId: "block-1", startOffset, endOffset }}
        />,
      );
    });

    const marks = container.querySelectorAll('[data-testid="utf16-highlight-mark"]');
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks[0]?.textContent).toBe("teh teh");

    // Render PDF without boxes -> shows fallback notice + text sidebar <mark>
    const pdfNoBoxes = buildPdfDocumentWithoutBoxes();
    await act(async () => {
      root.render(
        <PreviewView
          document={pdfNoBoxes}
          fileBytes={new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])}
          highlight={{ blockId: "block-0", startOffset: 0, endOffset: 7 }}
        />,
      );
    });

    const fallbackBanner = container.querySelector('[data-testid="pdf-position-fallback"]');
    expect(fallbackBanner?.textContent).toContain("Exact PDF coordinates are unavailable");
    const pdfMark = container.querySelector('[data-testid="utf16-highlight-mark"]');
    expect(pdfMark?.textContent).toBe("Recieve");
  });

  it("does not paint the candidate name until a finding supplies evidence", async () => {
    const name = "Ada Lovelace";
    const email = "[ada@example.com](mailto:ada@example.com)";
    const document: ResumeDocument = {
      id: "name-highlight",
      version: 1,
      filename: "Ada.pdf",
      mimeType: "application/pdf",
      sourceHash: "name-highlight",
      parserVersion: "test",
      sections: [
        {
          id: "section-0",
          kind: "CONTACT",
          heading: "",
          blockIds: ["block-0", "block-1"],
        },
      ],
      blocks: [
        {
          id: "block-0",
          sectionId: "section-0",
          type: "paragraph",
          text: name,
          startOffset: 0,
          endOffset: name.length,
          page: 1,
          boxes: [{ page: 1, x: 72, y: 740, width: 160, height: 18 }],
        },
        {
          id: "block-1",
          sectionId: "section-0",
          type: "paragraph",
          text: email,
          startOffset: name.length + 1,
          endOffset: name.length + 1 + email.length,
          page: 1,
          boxes: [{ page: 1, x: 72, y: 710, width: 180, height: 12 }],
        },
      ],
      metadata: { pages: [{ page: 1, width: 612, height: 792 }] },
    };
    const rawEmail = document.blocks[1]!.text;

    await act(async () => {
      root.render(
        <PreviewView document={document} fileBytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])} />,
      );
    });

    expect(container.querySelector('[data-testid="pdf-highlight-box"]')).toBeNull();
    expect(container.querySelector('[data-testid="utf16-highlight-mark"]')).toBeNull();
    const nameButton = container.querySelector('[data-block-id="block-0"]');
    expect(nameButton?.className).not.toContain("ring-amber");
    expect(nameButton?.className).not.toContain("bg-amber");
    expect(document.blocks[1]!.text).toBe(rawEmail);

    const visibleEmail = [...container.querySelectorAll('[data-block-id="block-1"] [data-visible-text="true"]')]
      .map((node) => node.textContent)
      .join("");
    expect(visibleEmail).toBe("ada@example.com");
    const hiddenSyntax = [...container.querySelectorAll('[data-markdown-syntax="true"]')]
      .map((node) => node.textContent)
      .join("");
    expect(hiddenSyntax).toContain("mailto:");
    expect(hiddenSyntax.startsWith("[")).toBe(true);

    const labelStart = email.indexOf("ada@example.com");
    await act(async () => {
      root.render(
        <PreviewView
          document={document}
          fileBytes={new Uint8Array([0x25, 0x50, 0x44, 0x46])}
          highlight={{ blockId: "block-1", startOffset: labelStart, endOffset: labelStart + "ada".length }}
        />,
      );
    });

    const boxes = container.querySelectorAll('[data-testid="pdf-highlight-box"]');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.getAttribute("data-precision")).toBe("subspan");
    expect(boxes[0]?.className).not.toContain("bg-amber-300");
    expect(boxes[0]?.className).not.toContain("border-2");
    const marked = container.querySelector('[data-testid="utf16-highlight-mark"]');
    expect(marked?.textContent).toBe("ada");
    expect(document.blocks[1]!.text).toBe(rawEmail);
    expect(document.blocks[1]!.startOffset).toBe(name.length + 1);
  });

  it("keeps overlapping UTF-16 ranges and line breaks readable", () => {
    const text = "Alpha line\nBeta line";
    expect(displayPieces(`[ada@example.com](mailto:ada@example.com)`).filter((piece) => piece.visible).map((piece) => piece.text)).toEqual([
      "ada@example.com",
    ]);
    const slices = coverageSlices(text.length, [
      { startOffset: 0, endOffset: 10 },
      { startOffset: 6, endOffset: 16 },
    ]);
    const overlap = slices.find((slice) => slice.depth > 1);
    expect(overlap).toEqual({ start: 6, end: 10, depth: 2 });
    expect(text.slice(overlap!.start, overlap!.end)).toBe("line");

    act(() => {
      root.render(<EvidenceText spans={[{ startOffset: 0, endOffset: 10 }, { startOffset: 6, endOffset: 16 }]} text={text} />);
    });
    const deep = container.querySelector('[data-evidence-depth="2"]');
    expect(deep?.textContent).toBe("line");
    expect(container.textContent).toContain("Alpha line\nBeta line");
  });
});

describe("UploadPanel state resets, failed uploads, and historical evaluation matching", () => {
  it("immediately resets versionId, evaluation, findings, and highlight when switching files or when upload/parse fails", async () => {
    const resumeA = buildDocxDocument("doc-a", "First_Resume.docx", "Recieve webhooks in Go");
    const resumeB = buildDocxDocument("doc-b", "Second_Resume.docx", "Shipped clean services");

    const versionA = "11111111-1111-4111-8111-111111111111";
    const resumeIdA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let nextIntentShouldFail = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/v1/evaluations") && method === "GET") {
        return new Response(
          JSON.stringify({
            evaluations: [],
            pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "/api/v1/resumes/upload-intents" && method === "POST") {
        if (nextIntentShouldFail) {
          return new Response(
            JSON.stringify({
              error: { code: "TOO_MANY_PENDING_UPLOADS", message: "Upload rejected by server." },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            resumeId: resumeIdA,
            versionId: versionA,
            upload: {
              method: "PUT",
              url: "https://storage.example/upload-a",
              headers: { "content-type": resumeA.mimeType },
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "https://storage.example/upload-a" && method === "PUT") {
        return new Response(null, { status: 200 });
      }

      if (url.endsWith("/complete-upload") && method === "POST") {
        return new Response(
          JSON.stringify({ verificationState: "verified", officialScore: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "/api/v1/evaluations" && method === "POST") {
        return new Response(
          JSON.stringify({
            evaluation: {
              id: "eval-a",
              resumeId: resumeIdA,
              resumeVersionId: versionA,
              originalFilename: "First_Resume.docx",
              mimeType: resumeA.mimeType,
              scoreStatus: "PROVISIONAL",
              baseScore: 5,
              denominator: 44,
              penaltyTotal: null,
              penaltyStatus: "not_evaluated",
              finalScore: null,
              rubricVersion: "rubric-2026-11-12-provisional",
              criteria: [
                { ruleId: "contact-information", maxScore: 4, status: "scored", score: 1 },
                { ruleId: "readability", maxScore: 7, status: "withheld", score: null, reasonCode: "OPEN_DECISION" },
              ],
              jdMatch: null,
              createdAt: "2026-11-13T10:00:00.000Z",
            },
            findings: [
              {
                id: "f-1",
                ruleId: "grammar-spelling",
                message: 'Possible misspelling "Recieve".',
                suggestion: "Receive",
                evidence: [{ blockId: "block-1", startOffset: 0, endOffset: 7 }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: { message: "Not mocked" } }), { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);

    let shouldFailExtraction = false;
    const mockExtractor = vi.fn(async (filename: string) => {
      if (shouldFailExtraction) {
        throw new Error("The file could not be read.");
      }
      return filename.includes("First") ? resumeA : resumeB;
    });

    await act(async () => {
      root.render(<UploadPanel extractDocument={mockExtractor} user={USER} />);
    });
    await flushAsync();

    // 1. Upload and score First_Resume.docx
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file1 = new File([new Uint8Array([1, 2, 3])], "First_Resume.docx", {
      type: resumeA.mimeType,
    });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file1], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushAsync();

    const scoreBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Score verified resume"),
    );
    expect(scoreBtn).toBeDefined();

    await act(async () => {
      scoreBtn!.click();
    });
    await flushAsync();

    expect(container.textContent).toContain('Possible misspelling "Recieve".');
    expect(container.textContent).toContain("5 of 44");

    // Hover finding to activate UTF-16 highlight
    const findingBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes('Possible misspelling "Recieve".'),
    );
    await act(async () => {
      findingBtn?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="utf16-highlight-mark"]')?.textContent).toBe(
      "Recieve",
    );

    // 2. Select Second_Resume.docx whose upload-intent FAILS on the server:
    // Previous evaluation, findings, highlight, and "Score verified resume" form MUST all disappear!
    nextIntentShouldFail = true;
    const file2 = new File([new Uint8Array([4, 5, 6])], "Second_Resume.docx", {
      type: resumeB.mimeType,
    });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file2], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushAsync();

    expect(container.textContent).toContain("Upload rejected by server.");
    expect(container.textContent).not.toContain('Possible misspelling "Recieve".');
    expect(container.textContent).not.toContain("Score verified resume");
    expect(container.querySelector('[data-testid="utf16-highlight-mark"]')).toBeNull();

    // 3. Select Corrupt_Resume.docx whose local parse FAILS:
    // Neither stale preview nor scoring form may remain visible.
    shouldFailExtraction = true;
    const file3 = new File([new Uint8Array([9, 9, 9])], "Corrupt_Resume.docx", {
      type: resumeB.mimeType,
    });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file3], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushAsync();

    expect(container.textContent).toContain("The file could not be read.");
    expect(container.textContent).not.toContain("Shipped clean services");
    expect(container.textContent).not.toContain("Score verified resume");
  });

  it("loads the matching resume preview when opening history, and hides mismatched previews when the original file is unavailable", async () => {
    const currentDoc = buildDocxDocument("doc-current", "Current_Resume.docx", "Current local bullet");
    const historicalDoc = buildDocxDocument(
      "doc-historical",
      "Historical_Resume.docx",
      "Historical bullet with recieve typo",
    );

    const histEvalAvailableId = "eval-hist-ok";
    const histEvalMissingFileId = "eval-hist-missing";
    const histResumeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const histVersionOk = "22222222-2222-4222-8222-222222222222";
    const histVersionMissing = "33333333-3333-4333-8333-333333333333";

    const historyItems = [
      {
        id: histEvalAvailableId,
        resumeId: histResumeId,
        resumeVersionId: histVersionOk,
        originalFilename: "Historical_Resume.docx",
        mimeType: historicalDoc.mimeType,
        scoreStatus: "PROVISIONAL",
        baseScore: 7,
        denominator: 44,
        penaltyStatus: "not_evaluated",
        finalScore: null,
        createdAt: "2026-11-13T09:00:00.000Z",
      },
      {
        id: histEvalMissingFileId,
        resumeId: histResumeId,
        resumeVersionId: histVersionMissing,
        originalFilename: "Unavailable_Resume.docx",
        mimeType: historicalDoc.mimeType,
        scoreStatus: "PROVISIONAL",
        baseScore: 3,
        denominator: 44,
        penaltyStatus: "not_evaluated",
        finalScore: null,
        createdAt: "2026-11-13T08:00:00.000Z",
      },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/v1/evaluations?") && method === "GET") {
        return new Response(
          JSON.stringify({
            evaluations: historyItems,
            pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === `/api/v1/evaluations/${histEvalAvailableId}`) {
        return new Response(
          JSON.stringify({
            evaluation: {
              ...historyItems[0],
              penaltyTotal: null,
              rubricVersion: "rubric-2026-11-12-provisional",
              criteria: [
                { ruleId: "contact-information", maxScore: 4, status: "scored", score: 3 },
              ],
              jdMatch: null,
            },
            findings: [
              {
                id: "hist-f1",
                ruleId: "grammar-spelling",
                message: 'Possible misspelling "recieve".',
                evidence: [{ blockId: "block-1", startOffset: 23, endOffset: 30 }],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === `/api/v1/resumes/${histResumeId}/versions/${histVersionOk}/view-url`) {
        return new Response(
          JSON.stringify({ url: "https://storage.example/download-hist-ok" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "https://storage.example/download-hist-ok") {
        return new Response(new Uint8Array([10, 20, 30]), { status: 200 });
      }

      if (url === `/api/v1/evaluations/${histEvalMissingFileId}`) {
        return new Response(
          JSON.stringify({
            evaluation: {
              ...historyItems[1],
              penaltyTotal: null,
              rubricVersion: "rubric-2026-11-12-provisional",
              criteria: [
                { ruleId: "contact-information", maxScore: 4, status: "scored", score: 1 },
              ],
              jdMatch: null,
            },
            findings: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === `/api/v1/resumes/${histResumeId}/versions/${histVersionMissing}/view-url`) {
        return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "/api/v1/resumes/upload-intents") {
        return new Response(
          JSON.stringify({
            resumeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            versionId: "44444444-4444-4444-8444-444444444444",
            upload: {
              method: "PUT",
              url: "https://storage.example/upload-current",
              headers: { "content-type": currentDoc.mimeType },
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://storage.example/upload-current") {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/complete-upload")) {
        return new Response(
          JSON.stringify({ verificationState: "verified", officialScore: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(null, { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const mockExtractor = vi.fn(async (filename: string) =>
      filename.includes("Historical") ? historicalDoc : currentDoc,
    );

    await act(async () => {
      root.render(<UploadPanel extractDocument={mockExtractor} user={USER} />);
    });
    await flushAsync();

    // First load Current_Resume.docx so a different resume is currently on screen
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const currentFile = new File([new Uint8Array([1, 2])], "Current_Resume.docx", {
      type: currentDoc.mimeType,
    });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [currentFile], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushAsync();
    expect(container.textContent).toContain("Current local bullet");

    // Click historical evaluation #1 (available file): replaces preview with Historical_Resume.docx
    const histBtn1 = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Historical_Resume.docx"),
    );
    expect(histBtn1).toBeDefined();
    await act(async () => {
      histBtn1!.click();
    });
    await flushAsync();

    expect(container.textContent).toContain("7 of 44");
    expect(container.textContent).toContain("Historical bullet with recieve typo");
    expect(container.textContent).not.toContain("Current local bullet");

    const historicalFinding = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes('Possible misspelling "recieve".'),
    );
    await act(async () => {
      historicalFinding?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="utf16-highlight-mark"]')?.textContent).toBe("recieve");

    await act(async () => {
      historicalFinding?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });

    // Click historical evaluation #2 (original file unavailable): shows score 3 of 44 WITHOUT rendering Historical_Resume.docx preview!
    const histBtn2 = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Unavailable_Resume.docx"),
    );
    expect(histBtn2).toBeDefined();
    await act(async () => {
      histBtn2!.click();
    });
    await flushAsync();

    expect(container.textContent).toContain("3 of 44");
    expect(
      container.querySelector('[data-testid="preview-unavailable-notice"]')?.textContent,
    ).toContain("Original resume file is unavailable for preview");
    expect(container.textContent).not.toContain("Historical bullet with recieve typo");
    expect(container.textContent).not.toContain("Current local bullet");
    expect(container.querySelector('[data-testid="utf16-highlight-mark"]')).toBeNull();
  });
});
