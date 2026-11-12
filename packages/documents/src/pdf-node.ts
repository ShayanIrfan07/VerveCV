import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { PdfjsModule } from "./pdf-types.js";

const require = createRequire(import.meta.url);

export function configureNodePdfWorker(pdfjs: PdfjsModule): void {
  if (pdfjs.GlobalWorkerOptions.workerSrc) {
    return;
  }
  const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
}
