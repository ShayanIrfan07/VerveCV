import { sampleDocxBytes, samplePdfBytes, type ResumeDocument } from "@vervecv/documents";
import { useCallback, useEffect, useState } from "react";
import { apiRequest, type SessionUser } from "./api";
import { PreviewView } from "./preview-view";
import { HistoryList, ScorePanel, type HistoryItem, type ScoreFinding, type ScoreView } from "./score-panel";

const UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

export function UploadPanel({ user }: { user: SessionUser | null }) {
  const [status, setStatus] = useState("Choose a PDF or DOCX file. The preview is extracted in your browser.");
  const [preview, setPreview] = useState<ResumeDocument | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [candidateType, setCandidateType] = useState<"FRESHER" | "EXPERIENCED">("FRESHER");
  const [jobDescription, setJobDescription] = useState("");
  const [evaluation, setEvaluation] = useState<ScoreView | null>(null);
  const [findings, setFindings] = useState<ScoreFinding[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [highlightBlockId, setHighlightBlockId] = useState<string | null>(null);

  async function onFile(file: File | null) {
    if (!file) {
      return;
    }
    const lower = file.name.toLowerCase();
    const mimeType = lower.endsWith(".docx")
      ? DOCX_MIME
      : lower.endsWith(".pdf")
        ? PDF_MIME
        : file.type || "application/octet-stream";
    await openBytes(file.name, mimeType, new Uint8Array(await file.arrayBuffer()));
  }

  async function openBytes(filename: string, mimeType: string, data: Uint8Array) {
    if (data.byteLength > UPLOAD_LIMIT_BYTES) {
      setStatus("The file is larger than the 5 MiB upload limit.");
      return;
    }
    setBytes(data);
    setStatus("Reading the file in your browser.");
    try {
      const document = await extractLocally(filename, mimeType, data);
      setPreview(document);
    } catch (error) {
      setPreview(null);
      setStatus(error instanceof Error ? error.message : "The file could not be read.");
      return;
    }
    if (!user) {
      setStatus("Local preview. Sign in to store the file for server verification.");
      return;
    }
    await store(filename, mimeType, data);
  }

  async function store(filename: string, mimeType: string, data: Uint8Array) {
    const intent = await apiRequest<UploadIntentResponse>("/api/v1/resumes/upload-intents", {
      method: "POST",
      body: JSON.stringify({ filename, mimeType, sizeBytes: data.byteLength }),
    });
    if (intent.status !== 201 || !intent.body?.upload) {
      setStatus(intent.body?.error?.message ?? "The server did not accept the upload.");
      return;
    }
    const payload = new Uint8Array(data.byteLength);
    payload.set(data);
    const uploaded = await fetch(intent.body.upload.url, {
      method: intent.body.upload.method,
      headers: intent.body.upload.headers,
      body: new Blob([payload.buffer], { type: mimeType }),
    });
    if (!uploaded.ok) {
      setStatus("The file could not be stored.");
      return;
    }
    const completed = await apiRequest<CompleteResponse>(
      `/api/v1/resumes/${intent.body.resumeId}/versions/${intent.body.versionId}/complete-upload`,
      { method: "POST", body: JSON.stringify({}) },
    );
    if (completed.body?.verificationState === "verified" && completed.body.officialScore === null) {
      setVersionId(intent.body.versionId);
      setStatus("The server verified the stored file. Choose a candidate type and score it. The browser preview is not the official score.");
      await loadHistory();
      return;
    }
    setStatus(completed.body?.error?.message ?? "Server verification did not finish.");
  }

  const loadHistory = useCallback(async () => {
    const listed = await apiRequest<{ evaluations: HistoryItem[] }>("/api/v1/evaluations");
    if (listed.status === 200 && listed.body) {
      setHistory(listed.body.evaluations);
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setHistory([]);
      return;
    }
    void loadHistory();
  }, [user, loadHistory]);

  async function scoreResume() {
    if (!versionId) {
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    const result = await apiRequest<{ evaluation: ScoreView; findings: ScoreFinding[]; error?: { message: string } }>(
      "/api/v1/evaluations",
      {
        method: "POST",
        body: JSON.stringify({
          resumeVersionId: versionId,
          candidateType,
          jobDescription: jobDescription.trim().length > 0 ? jobDescription.trim() : null,
          idempotencyKey,
        }),
      },
    );
    if (result.status !== 200 || !result.body?.evaluation) {
      setStatus(result.body?.error?.message ?? "The server did not score the resume.");
      return;
    }
    setEvaluation(result.body.evaluation);
    setFindings(result.body.findings);
    setStatus("Provisional score from the stored file. It is not rescaled to 100.");
    await loadHistory();
  }

  async function openHistory(id: string) {
    const result = await apiRequest<{ evaluation: ScoreView; findings: ScoreFinding[] }>(`/api/v1/evaluations/${id}`);
    if (result.status === 200 && result.body?.evaluation) {
      setEvaluation(result.body.evaluation);
      setFindings(result.body.findings);
    }
  }

  return (
    <section className="grid gap-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-950">Resume</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">{status}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <label className="rounded-lg bg-slate-950 px-3 py-2 text-sm text-white">
            Choose file
            <input
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="sr-only"
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
          <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void openBytes("Sample_Resume.pdf", PDF_MIME, samplePdfBytes())} type="button">
            Preview sample PDF
          </button>
          <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void openBytes("Sample_Resume.docx", DOCX_MIME, sampleDocxBytes())} type="button">
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
              onChange={(event) => setCandidateType(event.target.value === "EXPERIENCED" ? "EXPERIENCED" : "FRESHER")}
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
          <button className="mt-3 rounded-lg bg-slate-950 px-3 py-2 text-sm text-white" type="submit">
            Score verified resume
          </button>
        </form>
      ) : null}
      {evaluation ? <ScorePanel evaluation={evaluation} findings={findings} onHighlight={setHighlightBlockId} /> : null}
      {user ? <HistoryList items={history} onOpen={(id) => void openHistory(id)} /> : null}
      {preview ? <PreviewView document={preview} fileBytes={bytes} highlightBlockId={highlightBlockId} /> : null}
    </section>
  );
}

function extractLocally(filename: string, mimeType: string, data: Uint8Array): Promise<ResumeDocument> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract.worker.ts", import.meta.url), { type: "module" });
    const copy = data.slice();
    worker.onmessage = (event: MessageEvent<{ id?: number; document?: ResumeDocument; error?: { message: string } }>) => {
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
