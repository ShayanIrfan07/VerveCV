import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "../..");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@vervecv/documents": path.resolve(repoRoot, "packages/documents/src/index.ts"),
      // The documents package is compiled from source. pnpm does not hoist these
      // libraries into the web app, so the dev server needs an explicit path.
      mammoth: path.resolve(repoRoot, "packages/documents/node_modules/mammoth"),
      "pdfjs-dist/legacy/build/pdf.mjs": path.resolve(appDir, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"),
    },
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  optimizeDeps: {
    include: ["mammoth"],
    exclude: ["pdfjs-dist"],
  },
  worker: {
    format: "es",
  },
});
