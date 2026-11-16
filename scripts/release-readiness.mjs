import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HEALTH_LIVE_PROBE_NOTES,
  measureApiMemoryAndLatency,
} from "./measure-api-memory.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LOCAL_MEASUREMENTS_RELATIVE = "docs/release/measurements.local.json";
export const EXAMPLE_MEASUREMENTS_RELATIVE = "docs/release/measurements.example.json";
export const LEGACY_TRACKED_MEASUREMENTS_RELATIVE = "docs/release/measurements.json";

export const RELEASE_GATES = [
  ["lint", "lint"],
  ["typecheck", "typecheck"],
  ["db:check", "db:check"],
  ["test", "test"],
  ["build", "build"],
  ["size:check", "size:check"],
];

export function resolveMeasurementsOutputPath(rootDir, options = {}) {
  const relative = options.relativePath ?? LOCAL_MEASUREMENTS_RELATIVE;
  const outputPath = path.resolve(rootDir, relative);
  assertSafeMeasurementsOutputPath(rootDir, outputPath);
  return outputPath;
}

export function assertSafeMeasurementsOutputPath(rootDir, outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  const forbidden = [
    path.resolve(rootDir, EXAMPLE_MEASUREMENTS_RELATIVE),
    path.resolve(rootDir, LEGACY_TRACKED_MEASUREMENTS_RELATIVE),
  ];
  for (const tracked of forbidden) {
    if (pathsEqual(resolvedOutput, tracked)) {
      throw new Error(
        `Refusing to overwrite tracked release measurements at "${path.relative(rootDir, tracked)}". Write machine-local results to "${LOCAL_MEASUREMENTS_RELATIVE}" instead.`,
      );
    }
  }
}

function pathsEqual(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

export function buildReleaseReport({ startedAt, completedAt, node, platform, gates, probe }) {
  return {
    generatedAt: startedAt,
    completedAt,
    node,
    platform,
    gates,
    probe,
    notes: [
      ...HEALTH_LIVE_PROBE_NOTES,
      "Machine-local probe output is written to docs/release/measurements.local.json and must not replace the tracked example.",
      "Playwright E2E (`pnpm test:e2e`) is a required release gate in CI and before production sign-off.",
      "Phase 8 (pro subscriptions) remains blocked on ADR 0001 decisions 10 and 11. Version 1 launches Free-only.",
      "Deterministic rule-based scoring, 90-day retention, and the 100 MiB source+production-dependency footprint remain binding.",
    ],
  };
}

export function runGate(label, script, options = {}) {
  const cwd = options.cwd ?? root;
  const spawn = options.spawnSyncImpl ?? spawnSync;
  console.log(`\n==> ${label}`);
  const result = spawn(`corepack pnpm ${script}`, {
    cwd,
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
  for (const [label, script] of RELEASE_GATES) {
    runGate(label, script);
  }

  const probe = await measureApiMemoryAndLatency({ rounds: 50 });
  const report = buildReleaseReport({
    startedAt,
    completedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    gates: RELEASE_GATES.map(([name]) => name),
    probe,
  });
  const reportPath = resolveMeasurementsOutputPath(root);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nWrote machine-local probe output to ${path.relative(root, reportPath)}`);
  console.log(
    `In-process health/live inject latency p50/p95/max ms (not production API latency): ${probe.latencyMs.p50} / ${probe.latencyMs.p95} / ${probe.latencyMs.max}`,
  );
  console.log(`Workstation RSS after in-process probe: ${probe.memory.afterRss} bytes`);
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
