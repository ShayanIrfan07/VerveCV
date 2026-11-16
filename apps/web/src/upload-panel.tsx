import { sampleDocxBytes, samplePdfBytes, type ResumeDocument } from "@vervecv/documents";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, type SessionUser } from "./api";
import { PreviewView } from "./preview-view";
import {
  HistoryList,
  ScorePanel,
  type EvidenceLocator,
  type HistoryItem,
  type HistoryPagination,
  type ScoreFinding,
  type ScoreView,
} from "./score-panel";

const UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const HISTORY_PAGE_SIZE = 20;

interface UploadIntentResponse {
  resumeId: string;
  versionId: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string> };
  error?: { message: string };
}

interface CompleteResponse {
  verificationState?: string;
  officialScore: null;
  error?: { code: string; message: string };
}

interface PreviewSession {
  versionId: string | null;
  document: ResumeDocument;
  bytes: Uint8Array;
}

export type LocalExtractor = (
  filename: string,
  mimeType: string,
  data: Uint8Array,
) => Promise<ResumeDocument>;

export function UploadPanel({
  user,
  extractDocument = extractLocally,
}: {
  user: SessionUser | null;
  extractDocument?: LocalExtractor;
}) {
  const [status, setStatus] = useState(
    "Choose a PDF or DOCX file. The preview is extracted in your browser.",
  );
  const [previewSession, setPreviewSession] = useState<PreviewSession | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [candidateType, setCandidateType] = useState<"FRESHER" | "EXPERIENCED">("FRESHER");
  const [jobDescription, setJobDescription] = useState("");
  const [evaluation, setEvaluation] = useState<ScoreView | null>(null);
  const [findings, setFindings] = useState<ScoreFinding[]>([]);
  const [previewUnavailableReason, setPreviewUnavailableReason] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyPagination, setHistoryPagination] = useState<HistoryPagination | null>(null);
  const [highlight, setHighlight] = useState<EvidenceLocator | null>(null);

  // Monotonic operation token prevents late async completions from overwriting newer file selections or history views.
  const operationSeqRef = useRef(0);
  // Session-local cache of verified version previews so reopening a historical score restores the exact version without network round-trips when already loaded.
  const versionPreviewCacheRef = useRef(
    new Map<string, { document: ResumeDocument; bytes: Uint8Array }>(),
  );

  function resetActiveResumeState() {
    setVersionId(null);
    setEvaluation(null);
    setFindings([]);
    setHighlight(null);
    setPreviewUnavailableReason(null);
    setPreviewSession(null);
  }

  async function onFile(file: File | null) {
    if (!file) {
      return;
    }
    const seq = ++operationSeqRef.current;
    // Immediately clear stale versionId, evaluation, findings, highlight, and preview before reading bytes.
    resetActiveResumeState();

    const lower = file.name.toLowerCase();
    const mimeType = lower.endsWith(".docx")
      ? DOCX_MIME
      : lower.endsWith(".pdf")
        ? PDF_MIME
        : file.type || "application/octet-stream";

    let rawBytes: Uint8Array;
    try {
      rawBytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      if (operationSeqRef.current === seq) {
        setStatus("The file could not be read.");
      }
      return;
    }

    if (operationSeqRef.current !== seq) {
      return;
    }
    await processSelectedBytes(seq, file.name, mimeType, rawBytes);
  }

  async function openBytes(filename: string, mimeType: string, data: Uint8Array) {
    const seq = ++operationSeqRef.current;
    resetActiveResumeState();
    await processSelectedBytes(seq, filename, mimeType, data);
  }

  async function processSelectedBytes(
    seq: number,
    filename: string,
    mimeType: string,
    data: Uint8Array,
  ) {
    if (data.byteLength > UPLOAD_LIMIT_BYTES) {
      setStatus("The file is larger than the 5 MiB upload limit.");
      return;
    }

    setStatus("Reading the file in your browser.");
    let document: ResumeDocument;
    try {
      document = await extractDocument(filename, mimeType, data);
    } catch (error) {
      if (operationSeqRef.current === seq) {
        resetActiveResumeState();
        setStatus(error instanceof Error ? error.message : "The file could not be read.");
      }
      return;
    }

    if (operationSeqRef.current !== seq) {
      return;
    }

    setPreviewSession({ versionId: null, document, bytes: data });

    if (!user) {
      setStatus("Local preview. Sign in to store the file for server verification.");
      return;
    }

    await store(seq, filename, mimeType, data, document);
  }

  async function store(
    seq: number,
    filename: string,
    mimeType: string,
    data: Uint8Array,
    extractedDocument: ResumeDocument,
  ) {
    let intent: Awaited<ReturnType<typeof apiRequest<UploadIntentResponse>>>;
    try {
      intent = await apiRequest<UploadIntentResponse>("/api/v1/resumes/upload-intents", {
        method: "POST",
        body: JSON.stringify({ filename, mimeType, sizeBytes: data.byteLength }),
      });
    } catch {
      if (operationSeqRef.current === seq) {
        setVersionId(null);
        setStatus("The server did not accept the upload.");
      }
      return;
    }
    if (operationSeqRef.current !== seq) {
      return;
    }
    if (intent.status !== 201 || !intent.body?.upload) {
      setVersionId(null);
      setStatus(intent.body?.error?.message ?? "The server did not accept the upload.");
      return;
    }

    const payload = new Uint8Array(data.byteLength);
    payload.set(data);
    let uploaded: Response;
    try {
      uploaded = await fetch(intent.body.upload.url, {
        method: intent.body.upload.method,
        headers: intent.body.upload.headers,
        body: new Blob([payload.buffer], { type: mimeType }),
      });
    } catch {
      if (operationSeqRef.current === seq) {
        setVersionId(null);
        setStatus("The file could not be stored.");
      }
      return;
    }
    if (operationSeqRef.current !== seq) {
      return;
    }
    if (!uploaded.ok) {
      setVersionId(null);
      setStatus("The file could not be stored.");
      return;
    }

    let completed: Awaited<ReturnType<typeof apiRequest<CompleteResponse>>>;
    try {
      completed = await apiRequest<CompleteResponse>(
        `/api/v1/resumes/${intent.body.resumeId}/versions/${intent.body.versionId}/complete-upload`,
        { method: "POST", body: JSON.stringify({}) },
      );
    } catch {
      if (operationSeqRef.current === seq) {
        setVersionId(null);
        setStatus("Server verification did not finish.");
      }
      return;
    }
    if (operationSeqRef.current !== seq) {
      return;
    }

    if (
      completed.status === 200 &&
      completed.body?.verificationState === "verified" &&
      completed.body.officialScore === null
    ) {
      const verifiedVersionId = intent.body.versionId;
      versionPreviewCacheRef.current.set(verifiedVersionId, {
        document: extractedDocument,
        bytes: data,
      });
      setPreviewSession({
        versionId: verifiedVersionId,
        document: extractedDocument,
        bytes: data,
      });
      setVersionId(verifiedVersionId);
      setStatus(
        "The server verified the stored file. Choose a candidate type and score it. The browser preview is not the official score.",
      );
      await loadHistory(0, false);
      return;
    }

    setVersionId(null);
    setStatus(completed.body?.error?.message ?? "Server verification did not finish.");
  }

  const loadHistory = useCallback(async (offset = 0, append = false) => {
    const listed = await apiRequest<{
      evaluations: HistoryItem[];
      pagination?: HistoryPagination;
    }>(`/api/v1/evaluations?limit=${HISTORY_PAGE_SIZE}&offset=${offset}`);
    if (listed.status === 200 && listed.body) {
      const nextItems = listed.body.evaluations;
      setHistory((prev) => (append ? [...prev, ...nextItems] : nextItems));
      setHistoryPagination(listed.body.pagination ?? null);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      versionPreviewCacheRef.current.clear();
      setHistory([]);
      setHistoryPagination(null);
      setVersionId(null);
      setEvaluation(null);
      setFindings([]);
      setHighlight(null);
      setPreviewUnavailableReason(null);
      return;
    }
    void loadHistory(0, false);
  }, [user, loadHistory]);

  async function scoreResume() {
    if (!versionId) {
      return;
    }
    const seq = operationSeqRef.current;
    const targetVersionId = versionId;
    const idempotencyKey = crypto.randomUUID();
    const result = await apiRequest<{
      evaluation: ScoreView;
      findings: ScoreFinding[];
      error?: { message: string };
    }>("/api/v1/evaluations", {
      method: "POST",
      body: JSON.stringify({
        resumeVersionId: targetVersionId,
        candidateType,
        jobDescription: jobDescription.trim().length > 0 ? jobDescription.trim() : null,
        idempotencyKey,
      }),
    });

    if (operationSeqRef.current !== seq) {
      return;
    }
    if (result.status !== 200 || !result.body?.evaluation) {
      setStatus(result.body?.error?.message ?? "The server did not score the resume.");
      return;
    }

    setHighlight(null);
    setPreviewUnavailableReason(null);
    setEvaluation(result.body.evaluation);
    setFindings(result.body.findings);
    setStatus("Provisional score from the stored file. It is not rescaled to 100.");
    await loadHistory(0, false);
  }

  async function openHistory(item: HistoryItem) {
    const seq = ++operationSeqRef.current;
    setHighlight(null);
    setPreviewUnavailableReason(null);

    const result = await apiRequest<{
      evaluation: ScoreView;
      findings: ScoreFinding[];
      error?: { message: string };
    }>(`/api/v1/evaluations/${item.id}`);

    if (operationSeqRef.current !== seq) {
      return;
    }
    if (result.status !== 200 || !result.body?.evaluation) {
      setEvaluation(null);
      setFindings([]);
      setPreviewSession(null);
      setVersionId(null);
      setStatus(result.body?.error?.message ?? "This historical evaluation is no longer available.");
      await loadHistory(0, false);
      return;
    }

    const loadedEval = result.body.evaluation;
    const loadedFindings = result.body.findings;
    const targetVersionId = loadedEval.resumeVersionId;

    // Immediately clear any mismatched preview so findings from `targetVersionId` are
    // NEVER rendered against a different resume version while loading.
    if (previewSession?.versionId !== targetVersionId) {
      setPreviewSession(null);
    }

    setEvaluation(loadedEval);
    setFindings(loadedFindings);
    setVersionId(targetVersionId);

    // 1. Check current preview or in-memory cache for this exact resumeVersionId.
    if (previewSession?.versionId === targetVersionId) {
      setStatus("Viewing historical evaluation and its matching resume preview.");
      return;
    }

    const cached = versionPreviewCacheRef.current.get(targetVersionId);
    if (cached) {
      setPreviewSession({
        versionId: targetVersionId,
        document: cached.document,
        bytes: cached.bytes,
      });
      setStatus("Viewing historical evaluation and its matching resume preview.");
      return;
    }

    // 2. Fetch the signed view-url and stored bytes for the exact resumeId + resumeVersionId.
    const fallbackMessage =
      "Original resume file is unavailable for preview; showing historical score without document preview.";

    if (!loadedEval.resumeId) {
      setVersionId(null);
      setPreviewSession(null);
      setPreviewUnavailableReason(fallbackMessage);
      setStatus(fallbackMessage);
      return;
    }

    try {
      const viewResp = await apiRequest<{ url?: string }>(
        `/api/v1/resumes/${loadedEval.resumeId}/versions/${targetVersionId}/view-url`,
      );
      if (operationSeqRef.current !== seq) {
        return;
      }
      if (viewResp.status !== 200 || !viewResp.body?.url) {
        setVersionId(null);
        setPreviewSession(null);
        setPreviewUnavailableReason(fallbackMessage);
        setStatus(fallbackMessage);
        return;
      }

      const fileResp = await fetch(viewResp.body.url);
      if (operationSeqRef.current !== seq) {
        return;
      }
      if (!fileResp.ok) {
        setVersionId(null);
        setPreviewSession(null);
        setPreviewUnavailableReason(fallbackMessage);
        setStatus(fallbackMessage);
        return;
      }

      const fetchedBytes = new Uint8Array(await fileResp.arrayBuffer());
      if (operationSeqRef.current !== seq) {
        return;
      }

      const filename = loadedEval.originalFilename ?? "Resume.pdf";
      const mimeType =
        loadedEval.mimeType ??
        (filename.toLowerCase().endsWith(".docx") ? DOCX_MIME : PDF_MIME);

      const extracted = await extractDocument(filename, mimeType, fetchedBytes);
      if (operationSeqRef.current !== seq) {
        return;
      }

      versionPreviewCacheRef.current.set(targetVersionId, {
        document: extracted,
        bytes: fetchedBytes,
      });
      setPreviewSession({
        versionId: targetVersionId,
        document: extracted,
        bytes: fetchedBytes,
      });
      setPreviewUnavailableReason(null);
      setStatus("Viewing historical evaluation and its matching resume preview.");
    } catch {
      if (operationSeqRef.current === seq) {
        setVersionId(null);
        setPreviewSession(null);
        setPreviewUnavailableReason(fallbackMessage);
        setStatus(fallbackMessage);
      }
    }
  }

  // Strictly guard preview rendering: if an evaluation is active, only render the preview
  // when its `versionId` matches `evaluation.resumeVersionId`.
  const visiblePreview =
    previewSession &&
    (!evaluation || previewSession.versionId === evaluation.resumeVersionId)
      ? previewSession
      : null;

  return (
    <section className="grid min-w-0 gap-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-950">Resume</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">{status}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <label className="rounded-lg bg-slate-950 px-3 py-2 text-sm text-white">
            Choose file
            <input
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="sr-only"
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                event.target.value = "";
                void onFile(selected);
              }}
              type="file"
            />
          </label>
          <button
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            onClick={() => void openBytes("Sample_Resume.pdf", PDF_MIME, samplePdfBytes())}
            type="button"
          >
            Preview sample PDF
          </button>
          <button
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            onClick={() => void openBytes("Sample_Resume.docx", DOCX_MIME, sampleDocxBytes())}
            type="button"
          >
            Preview sample DOCX
          </button>
        </div>
      </div>

      {versionId ? (
        <form
          className="rounded-2xl border border-slate-200 bg-white p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void scoreResume();
          }}
        >
          <h2 className="text-lg font-semibold text-slate-950">Official score</h2>
          <label className="mt-3 block text-sm text-slate-700">
            Candidate type
            <select
              className="mt-1 block rounded-lg border border-slate-300 px-3 py-2"
              onChange={(event) =>
                setCandidateType(
                  event.target.value === "EXPERIENCED" ? "EXPERIENCED" : "FRESHER",
                )
              }
              value={candidateType}
            >
              <option value="FRESHER">Fresher</option>
              <option value="EXPERIENCED">Experienced</option>
            </select>
          </label>
          <label className="mt-3 block text-sm text-slate-700">
            Job description
            <textarea
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              onChange={(event) => setJobDescription(event.target.value)}
              value={jobDescription}
            />
          </label>
          <button
            className="mt-3 rounded-lg bg-slate-950 px-3 py-2 text-sm text-white"
            type="submit"
          >
            Score verified resume
          </button>
        </form>
      ) : null}

      {evaluation ? (
        <ScorePanel
          activeHighlight={highlight}
          evaluation={evaluation}
          findings={findings}
          onHighlight={setHighlight}
          previewUnavailableReason={previewUnavailableReason}
        />
      ) : null}

      {user ? (
        <HistoryList
          activeEvaluationId={evaluation?.id ?? null}
          hasMore={historyPagination?.hasMore ?? false}
          items={history}
          onLoadMore={
            historyPagination?.nextOffset !== null && historyPagination?.nextOffset !== undefined
              ? () => void loadHistory(historyPagination.nextOffset!, true)
              : undefined
          }
          onOpen={(item) => void openHistory(item)}
        />
      ) : null}

      {visiblePreview ? (
        <PreviewView
          document={visiblePreview.document}
          fileBytes={visiblePreview.bytes}
          highlight={highlight}
        />
      ) : null}
    </section>
  );
}

function extractLocally(
  filename: string,
  mimeType: string,
  data: Uint8Array,
): Promise<ResumeDocument> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract.worker.ts", import.meta.url), { type: "module" });
    const copy = data.slice();
    worker.onmessage = (
      event: MessageEvent<{ id?: number; document?: ResumeDocument; error?: { message: string } }>,
    ) => {
      // PDF.js uses this worker port for its own ready message, which has no id.
      if (typeof event.data?.id !== "number") {
        return;
      }
      worker.terminate();
      if (!event.data.document) {
        reject(new Error(event.data.error?.message ?? "The file could not be read."));
        return;
      }
      resolve(event.data.document);
    };
    worker.onerror = (event) => {
      if (!event.message) {
        return;
      }
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(
      { id: 1, filename, mimeType, sourceHash: "browser-preview", bytes: copy.buffer },
      [copy.buffer],
    );
  });
}
