import { realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const HEALTH_LIVE_PROBE_KIND = "fastify-inject-health-live";

export const HEALTH_LIVE_PROBE_NOTES = [
  "This probe uses Fastify light-my-request inject against GET /api/v1/health/live with db=null.",
  "It measures in-process HTTP handler overhead only.",
  "It is not representative of production API latency and does not include Neon/database, upload, evaluation, parsing, or Cloudflare R2 time.",
  "RSS/heap snapshots are workstation process.memoryUsage() values around that inject loop; they are not a production host memory SLA.",
];

function formatBytes(bytes) {
  return `${bytes} B (${(bytes / (1024 * 1024)).toFixed(2)} MiB)`;
}

export function percentile(sortedSamples, fraction) {
  if (sortedSamples.length === 0) {
    throw new Error("percentile requires at least one sample");
  }
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new Error("fraction must be between 0 and 1 inclusive");
  }
  const index = Math.min(sortedSamples.length - 1, Math.floor(sortedSamples.length * fraction));
  return sortedSamples[index];
}

export function summarizeLatencyMs(samples) {
  if (samples.length === 0) {
    throw new Error("summarizeLatencyMs requires at least one sample");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: Number(percentile(sorted, 0.5).toFixed(3)),
    p95: Number(percentile(sorted, 0.95).toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

export async function measureApiMemoryAndLatency(options = {}) {
  const rounds = options.rounds ?? 50;
  const importApp = options.importApp ?? defaultImportApp;
  const { buildApp, loadConfig } = await importApp();

  const config = {
    ...loadConfig({ LOG_LEVEL: "silent", ALLOWED_ORIGINS: "http://localhost:5173" }),
    cookieSecret: "release-readiness-cookie-secret-32b",
  };
  const before = process.memoryUsage();
  const app = await buildApp({ config, db: null });
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now();
    const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    samples.push(performance.now() - started);
    if (response.statusCode !== 200) {
      throw new Error(`health/live returned ${response.statusCode}`);
    }
  }
  const after = process.memoryUsage();
  await app.close();

  return {
    kind: HEALTH_LIVE_PROBE_KIND,
    scope: "in-process-only",
    excludes: ["database", "upload", "evaluation", "parse", "r2"],
    rounds,
    latencyMs: summarizeLatencyMs(samples),
    memory: {
      beforeRss: before.rss,
      afterRss: after.rss,
      beforeHeapUsed: before.heapUsed,
      afterHeapUsed: after.heapUsed,
      rssDelta: after.rss - before.rss,
      heapDelta: after.heapUsed - before.heapUsed,
    },
  };
}

async function defaultImportApp() {
  const { buildApp } = await import(pathToFileURL(path.join(root, "apps/api/dist/app.js")).href);
  const { loadConfig } = await import(pathToFileURL(path.join(root, "apps/api/dist/config.js")).href);
  return { buildApp, loadConfig };
}

async function main() {
  const report = await measureApiMemoryAndLatency();
  console.log("In-process Fastify inject probe for GET /api/v1/health/live (not production API latency)");
  for (const note of HEALTH_LIVE_PROBE_NOTES) {
    console.log(`- ${note}`);
  }
  console.log(`Rounds: ${report.rounds}`);
  console.log(`Latency p50/p95/max (ms): ${report.latencyMs.p50} / ${report.latencyMs.p95} / ${report.latencyMs.max}`);
  console.log(`RSS before/after: ${formatBytes(report.memory.beforeRss)} -> ${formatBytes(report.memory.afterRss)}`);
  console.log(
    `Heap used before/after: ${formatBytes(report.memory.beforeHeapUsed)} -> ${formatBytes(report.memory.afterHeapUsed)}`,
  );
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
