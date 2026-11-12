export type DocumentErrorCode =
  | "PASSWORD_PROTECTED"
  | "CORRUPT"
  | "NO_EXTRACTABLE_TEXT"
  | "PDF_PAGE_LIMIT"
  | "ZIP_LIMIT_EXCEEDED"
  | "PARSE_TIMEOUT"
  | "UNSUPPORTED_TYPE";

const MESSAGES: Record<DocumentErrorCode, string> = {
  PASSWORD_PROTECTED: "The file is password protected.",
  CORRUPT: "The file could not be read.",
  NO_EXTRACTABLE_TEXT: "The file has no extractable text.",
  PDF_PAGE_LIMIT: "The file could not be read within the configured parse limits.",
  ZIP_LIMIT_EXCEEDED: "The file could not be read within the configured parse limits.",
  PARSE_TIMEOUT: "The file could not be read within the configured parse limits.",
  UNSUPPORTED_TYPE: "This file type is not supported.",
};

export class DocumentParseError extends Error {
  readonly code: DocumentErrorCode;

  constructor(code: DocumentErrorCode) {
    super(MESSAGES[code]);
    this.name = "DocumentParseError";
    this.code = code;
  }
}

export class DocumentAbortError extends Error {
  constructor() {
    super("Document parse was cancelled.");
    this.name = "DocumentAbortError";
  }
}

export async function withTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) {
    throw new DocumentAbortError();
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = (): void => {
    controller.abort();
  };
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_, reject) => {
        if (externalSignal) {
          externalSignal.addEventListener(
            "abort",
            () => {
              reject(new DocumentAbortError());
            },
            { once: true },
          );
        }
        timer = setTimeout(() => {
          controller.abort();
          reject(new DocumentParseError("PARSE_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
