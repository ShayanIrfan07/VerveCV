import { extractDocx, extractPdf } from "@vervecv/documents";
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";

interface ExtractRequest {
  id: number;
  filename: string;
  mimeType: string;
  sourceHash: string;
  bytes: ArrayBuffer;
}

interface ExtractResponse {
  id: number;
  document?: unknown;
  error?: { message: string };
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<ExtractRequest>) => void) | null;
  postMessage(message: ExtractResponse): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<ExtractRequest>) => {
  void readFile(event.data);
};

async function readFile(request: ExtractRequest): Promise<void> {
  const bytes = new Uint8Array(request.bytes);
  const meta = {
    filename: request.filename,
    mimeType: request.mimeType,
    sourceHash: request.sourceHash,
    metadata: {},
  };
  try {
    const document =
      request.mimeType === "application/pdf"
        ? await extractPdf(bytes, meta, { pageCap: null, timeoutMs: null })
        : await extractDocx(bytes, meta, null);
    const response: ExtractResponse = { id: request.id, document };
    scope.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The file could not be read.";
    const response: ExtractResponse = { id: request.id, error: { message } };
    scope.postMessage(response);
  }
}
