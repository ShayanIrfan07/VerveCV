import { sampleDocxBytes, samplePdfBytes, type ResumeDocument } from "@vervecv/documents";
import { useState } from "react";
import { apiRequest, type SessionUser } from "./api";
import { PreviewView } from "./preview-view";

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
      setStatus("The server verified the stored file. Scoring is a later step, so this view remains a preview.");
      return;
    }
    setStatus(completed.body?.error?.message ?? "Server verification did not finish.");
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
      {preview ? <PreviewView document={preview} fileBytes={bytes} /> : null}
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
