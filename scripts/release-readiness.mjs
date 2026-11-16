import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { measureApiMemoryAndLatency } from "./measure-api-memory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, script) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(`corepack pnpm ${script}`, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const gates = [
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["db:check", "db:check"],
    ["test", "test"],
    ["build", "build"],
    ["size:check", "size:check"],
  ];

  for (const [label, script] of gates) {
    run(label, script);
  }

  const probe = await measureApiMemoryAndLatency({ rounds: 50 });
  const outDir = path.join(root, "docs", "release");
  mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "measurements.json");
  const report = {
    generatedAt: startedAt,
    completedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    gates: gates.map(([name]) => name),
    probe,
    notes: [
      "Latency is Fastify inject against /api/v1/health/live with db=null (no Neon round-trip).",
      "RSS/heap are process.memoryUsage() snapshots around that probe; they are not a production host SLA.",
      "Playwright accessibility/viewport checks are run separately via pnpm test:e2e when browsers are installed.",
      "Phase 8 (pro subscriptions) remains blocked on ADR 0001 decisions 10 and 11.",
    ],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${path.relative(root, reportPath)}`);
  console.log(
    `API probe latency p50/p95/max ms: ${probe.latencyMs.p50} / ${probe.latencyMs.p95} / ${probe.latencyMs.max}`,
  );
  console.log(`API RSS after probe: ${probe.memory.afterRss} bytes`);
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
