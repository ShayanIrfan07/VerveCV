import { realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function formatBytes(bytes) {
  return `${bytes} B (${(bytes / (1024 * 1024)).toFixed(2)} MiB)`;
}

export async function measureApiMemoryAndLatency(options = {}) {
  const rounds = options.rounds ?? 50;
  const { buildApp } = await import(pathToFileURL(path.join(root, "apps/api/dist/app.js")).href);
  const { loadConfig } = await import(pathToFileURL(path.join(root, "apps/api/dist/config.js")).href);

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

  samples.sort((left, right) => left - right);
  const percentile = (fraction) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
  return {
    rounds,
    latencyMs: {
      p50: Number(percentile(0.5).toFixed(3)),
      p95: Number(percentile(0.95).toFixed(3)),
      max: Number(samples[samples.length - 1].toFixed(3)),
    },
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

async function main() {
  const report = await measureApiMemoryAndLatency();
  console.log("API readiness probe (Fastify inject against /api/v1/health/live)");
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
