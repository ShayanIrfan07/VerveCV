import { sampleDocxBytes, samplePdfBytes, type ResumeDocument } from "@vervecv/documents";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, type SessionUser } from "./api";
import { PreviewView } from "./preview-view";
import { Brand } from "./shell";
import { card, field, primaryButton, secondaryButton } from "./ui";
import {
  EvaluationInsights,
  EvaluationOverview,
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
  focus,
  onEvaluationActive,
  onNewAnalysis,
  onSessionExpired,
}: {
  user: SessionUser | null;
  extractDocument?: LocalExtractor;
  focus?: "dashboard" | "analyze" | "history";
  onEvaluationActive?: (active: boolean) => void;
  onNewAnalysis?: () => void;
  onSessionExpired?: () => void;
}) {
  async function authed<T>(path: string, init: RequestInit = {}) {
    const result = await apiRequest<T>(path, init);
    if (result.status === 401) {
      sessionExpiredRef.current?.();
    }
    return result;
  }
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
  const [selectedFile, setSelectedFile] = useState<{ name: string; bytes: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mobilePane, setMobilePane] = useState<"resume" | "feedback">("feedback");

  useEffect(() => {
    onEvaluationActive?.(evaluation !== null && user !== null);
  }, [evaluation, onEvaluationActive, user]);

  // Monotonic operation token prevents late async completions from overwriting newer file selections or history views.
  const operationSeqRef = useRef(0);
  const sessionExpiredRef = useRef(onSessionExpired);
  sessionExpiredRef.current = onSessionExpired;
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
    setSelectedFile(null);
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
      setSelectedFile(null);
      setStatus("The file is larger than the 5 MiB upload limit.");
      return;
    }
    setSelectedFile({ name: filename, bytes: data.byteLength });

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
      intent = await authed<UploadIntentResponse>("/api/v1/resumes/upload-intents", {
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
      completed = await authed<CompleteResponse>(
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
    if (listed.status === 401) {
      sessionExpiredRef.current?.();
    }
    if (listed.status === 200 && listed.body) {
      const nextItems = listed.body.evaluations;
      setHistory((prev) => (append ? [...prev, ...nextItems] : nextItems));
      setHistoryPagination(listed.body.pagination ?? null);
    }
  }, []);

  useEffect(() => {
    versionPreviewCacheRef.current.clear();
    setHistory([]);
    setHistoryPagination(null);
    setVersionId(null);
    setEvaluation(null);
    setFindings([]);
    setHighlight(null);
    setPreviewUnavailableReason(null);
    setPreviewSession(null);
    setSelectedFile(null);
    if (!user) {
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
    const result = await authed<{
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

    const result = await authed<{
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
      const viewResp = await authed<{ url?: string }>(
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
  const showDashboard = focus === undefined || focus === "dashboard";
  const showAnalyze = focus === undefined || focus === "analyze";
  const showHistory = focus === undefined || focus === "history" || focus === "dashboard";
  const countsReady = historyPagination !== null && historyPagination.hasMore === false;
  const completedCount = history.filter((item) => item.status === "complete").length;
  const latest = history[0];

  return (
    <section className="grid min-w-0 gap-5">
      {evaluation && user ? (
      <div className="min-h-screen bg-[#F8F9FC] text-[#334155]">
        <header className="flex h-16 items-center justify-between border-b border-[#E2E8F0] bg-white px-6">
          <Brand />
          <button
            className="inline-flex min-h-11 items-center rounded-full bg-[#7C3AED] px-4 text-sm font-semibold text-white hover:bg-[#6D28D9]"
            onClick={() => {
              resetActiveResumeState();
              onNewAnalysis?.();
            }}
            type="button"
          >
            + New analysis
          </button>
        </header>
        <div className="px-6 py-6">
          <h1 className="text-2xl font-semibold text-[#17172B]">Resume evaluation</h1>
          <p className="mt-1 text-sm leading-6 text-[#334155]">Understand your weaknesses. Build a stronger resume.</p>
          <div className="mt-4">
            <EvaluationOverview evaluation={evaluation} />
          </div>
          <div className="mt-4 flex gap-2 lg:hidden">
            <button
              className={`min-h-11 flex-1 rounded-lg text-sm font-semibold ${mobilePane === "resume" ? "bg-[#7C3AED] text-white" : "bg-[#EDE9FE] text-[#6D28D9]"}`}
              onClick={() => setMobilePane("resume")}
              type="button"
            >
              Resume
            </button>
            <button
              className={`min-h-11 flex-1 rounded-lg text-sm font-semibold ${mobilePane === "feedback" ? "bg-[#7C3AED] text-white" : "bg-[#EDE9FE] text-[#6D28D9]"}`}
              onClick={() => setMobilePane("feedback")}
              type="button"
            >
              Feedback
            </button>
          </div>
          <div className="mt-4 grid w-full min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className={`${mobilePane === "resume" ? "block" : "hidden"} min-w-0 lg:block lg:max-h-[calc(100vh-12rem)] lg:overflow-auto`} id="resume-preview">
              {visiblePreview ? (
                <PreviewView document={visiblePreview.document} fileBytes={visiblePreview.bytes} highlight={highlight} showExtractedText={false} />
              ) : (
                <p className="rounded-xl border border-[#E2E8F0] bg-white p-4 text-sm text-[#64748B]">
                  {previewUnavailableReason ?? "The resume preview is not available for this result."}
                </p>
              )}
            </div>
            <div className={`${mobilePane === "feedback" ? "block" : "hidden"} min-w-0 lg:block lg:max-h-[calc(100vh-12rem)] lg:overflow-auto`}>
              <EvaluationInsights
                activeHighlight={highlight}
                evaluation={evaluation}
                findings={findings}
                onHighlight={setHighlight}
                previewUnavailableReason={previewUnavailableReason}
              />
            </div>
          </div>
        </div>
      </div>
      ) : null}
      <div className={evaluation && user ? "hidden" : "contents"}>
      {showDashboard && user ? (
        <div className="grid gap-5">
          <header>
            <p className="text-sm text-muted">Workspace / Dashboard</p>
            <h1 className="mt-2 text-3xl font-semibold text-ink">
              Welcome back{user.displayName ? `, ${user.displayName}` : ""}.
            </h1>
            <p className="mt-2 text-body">Manage your resumes and review the checks that are ready.</p>
          </header>
          <div className="rounded-2xl bg-hero p-6 text-[#6B5C85] sm:p-8">
            <p className="text-xs font-bold tracking-wide text-primary-bright">YOUR NEXT CAREER MOVE</p>
            <h2 className="mt-2 text-3xl font-semibold text-[#21143D]">Build a stronger resume.</h2>
            <p className="mt-2 max-w-xl">Discover the feedback the server can already support.</p>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            <article className={card}>
              <h2 className="text-3xl font-semibold text-ink">{countsReady ? history.length : "—"}</h2>
              <p className="text-sm text-muted">Total resumes</p>
            </article>
            <article className={card}>
              <h2 className="text-3xl font-semibold text-ink">{countsReady ? completedCount : "—"}</h2>
              <p className="text-sm text-muted">Completed</p>
            </article>
            <article className={card}>
              <h2 className="text-3xl font-semibold text-ink">
                {countsReady && latest ? (latest.score ?? "—") : "—"}
              </h2>
              <p className="text-sm text-muted">Latest score</p>
            </article>
          </div>
          {countsReady ? null : (
            <p className="text-sm text-muted">Totals stay hidden until every resume on this account has been loaded.</p>
          )}
        </div>
      ) : null}

      {showAnalyze ? (
      <div
        className={`${card} ${dragging ? "border-primary bg-primary-muted" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void onFile(event.dataTransfer.files[0] ?? null);
        }}
      >
        <h2 className="text-2xl font-semibold text-ink">New resume analysis</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{status}</p>
        <div className="mt-4 rounded-xl border-2 border-dashed border-[#C4B5FD] bg-[#FAF9FF] px-5 py-12 text-center">
          <h3 className="text-xl font-semibold text-ink">Drag and drop your resume</h3>
          <p className="mt-1 text-sm text-muted">or browse files from your device</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
          <label className={primaryButton}>
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
            className={secondaryButton}
            onClick={() => void openBytes("Sample_Resume.pdf", PDF_MIME, samplePdfBytes())}
            type="button"
          >
            Preview sample PDF
          </button>
          <button
            className={secondaryButton}
            onClick={() => void openBytes("Sample_Resume.docx", DOCX_MIME, sampleDocxBytes())}
            type="button"
          >
            Preview sample DOCX
          </button>
          </div>
          <p className="mt-3 text-sm text-muted">PDF and DOCX, up to 5 MiB</p>
        </div>
        {selectedFile ? (
          <p className="mt-4 text-sm text-body">
            Selected file: {selectedFile.name} ({selectedFile.bytes} bytes)
          </p>
        ) : null}
        <p className="mt-4 rounded-lg bg-info-bg px-4 py-3 text-sm text-info">
          Your resume is subject to the 90-day retention policy.
        </p>
      </div>
      ) : null}

      {showAnalyze && versionId ? (
        <form
          className={card}
          onSubmit={(event) => {
            event.preventDefault();
            void scoreResume();
          }}
        >
          <h2 className="text-lg font-semibold text-ink">Official score</h2>
          <label className="mt-3 block text-sm text-muted">
            Candidate type
            <select
              className={field}
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
          <label className="mt-3 block text-sm text-muted">
            Job description
            <textarea
              className={field}
              placeholder="Optional. It is not compared yet."
              onChange={(event) => setJobDescription(event.target.value)}
              value={jobDescription}
            />
          </label>
          <button
            className={`mt-3 ${primaryButton}`}
            type="submit"
          >
            Score verified resume
          </button>
        </form>
      ) : null}

      {showAnalyze && (evaluation || visiblePreview) ? (
        <div
          className={`grid w-full min-w-0 items-start gap-6 ${
            evaluation && visiblePreview ? "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : ""
          }`}
        >
          {evaluation ? (
            <div className="order-1 min-w-0 lg:col-start-1 lg:row-start-1 lg:max-w-none">
              <h2 className="text-2xl font-semibold text-ink">Resume evaluation</h2>
              <p className="mt-1 text-sm leading-6 text-body">Understand your weaknesses. Build a stronger resume.</p>
            </div>
          ) : null}
          {visiblePreview ? (
            <div className="order-3 min-w-0 lg:order-none lg:col-start-1 lg:row-start-2 lg:max-h-[calc(100vh-8rem)] lg:overflow-auto" id="resume-preview">
              <PreviewView
                document={visiblePreview.document}
                fileBytes={visiblePreview.bytes}
                highlight={highlight}
              />
            </div>
          ) : null}
          {evaluation ? (
            <div className="order-2 min-w-0 lg:order-none lg:col-start-2 lg:row-span-2 lg:max-h-[calc(100vh-8rem)] lg:overflow-auto">
              <ScorePanel
                activeHighlight={highlight}
                evaluation={evaluation}
                findings={findings}
                onHighlight={setHighlight}
                onPreview={() => {
                  document.getElementById("resume-preview")?.scrollIntoView({ block: "nearest" });
                }}
                previewUnavailableReason={previewUnavailableReason}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {showHistory && user ? (
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
      </div>
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
