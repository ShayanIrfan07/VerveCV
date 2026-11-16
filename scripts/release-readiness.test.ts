import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { percentile, summarizeLatencyMs } from "./measure-api-memory.mjs";
import {
  EXAMPLE_MEASUREMENTS_RELATIVE,
  LEGACY_TRACKED_MEASUREMENTS_RELATIVE,
  LOCAL_MEASUREMENTS_RELATIVE,
  assertSafeMeasurementsOutputPath,
  buildReleaseReport,
  resolveMeasurementsOutputPath,
  runGate,
} from "./release-readiness.mjs";

describe("in-process health/live probe helpers", () => {
  it("computes percentile indexes without claiming production latency", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(samples, 0.5)).toBe(6);
    expect(percentile(samples, 0.95)).toBe(10);
    expect(summarizeLatencyMs([10, 1, 2])).toEqual({ p50: 2, p95: 10, max: 10 });
  });

  it("rejects empty sample sets", () => {
    expect(() => percentile([], 0.5)).toThrow(/at least one sample/);
    expect(() => summarizeLatencyMs([])).toThrow(/at least one sample/);
  });
});

describe("release measurement output paths", () => {
  it("defaults to the gitignored machine-local measurements file", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "vervecv-release-"));
    mkdirSync(path.join(rootDir, "docs", "release"), { recursive: true });
    const output = resolveMeasurementsOutputPath(rootDir);
    expect(output).toBe(path.resolve(rootDir, LOCAL_MEASUREMENTS_RELATIVE));
  });

  it("refuses to overwrite tracked example or legacy measurements.json", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "vervecv-release-"));
    mkdirSync(path.join(rootDir, "docs", "release"), { recursive: true });
    writeFileSync(path.join(rootDir, EXAMPLE_MEASUREMENTS_RELATIVE), "{}\n");
    writeFileSync(path.join(rootDir, LEGACY_TRACKED_MEASUREMENTS_RELATIVE), "{}\n");

    expect(() =>
      assertSafeMeasurementsOutputPath(rootDir, path.join(rootDir, EXAMPLE_MEASUREMENTS_RELATIVE)),
    ).toThrow(/Refusing to overwrite tracked release measurements/);
    expect(() =>
      assertSafeMeasurementsOutputPath(rootDir, path.join(rootDir, LEGACY_TRACKED_MEASUREMENTS_RELATIVE)),
    ).toThrow(/Refusing to overwrite tracked release measurements/);
    expect(() => resolveMeasurementsOutputPath(rootDir, { relativePath: EXAMPLE_MEASUREMENTS_RELATIVE })).toThrow(
      /Refusing to overwrite/,
    );
  });
});

describe("release report contract", () => {
  it("labels the probe as in-process-only and keeps Free-only / footprint constraints in notes", () => {
    const report = buildReleaseReport({
      startedAt: "2026-11-16T00:00:00.000Z",
      completedAt: "2026-11-16T00:01:00.000Z",
      node: "v24.18.0",
      platform: "win32/x64",
      gates: ["lint", "test"],
      probe: {
        kind: "fastify-inject-health-live",
        scope: "in-process-only",
        excludes: ["database", "upload", "evaluation", "parse", "r2"],
        rounds: 2,
        latencyMs: { p50: 1, p95: 2, max: 2 },
        memory: {
          beforeRss: 1,
          afterRss: 2,
          beforeHeapUsed: 1,
          afterHeapUsed: 2,
          rssDelta: 1,
          heapDelta: 1,
        },
      },
    });

    expect(report.probe.scope).toBe("in-process-only");
    expect(report.probe.excludes).toEqual(expect.arrayContaining(["database", "upload", "evaluation", "r2"]));
    expect(report.notes.join(" ")).toMatch(/not representative of production API latency/i);
    expect(report.notes.join(" ")).toMatch(/measurements\.local\.json/);
    expect(report.notes.join(" ")).toMatch(/Playwright E2E/);
    expect(report.notes.join(" ")).toMatch(/Free-only/);
    expect(report.notes.join(" ")).toMatch(/100 MiB/);
    expect(report.notes.join(" ")).toMatch(/90-day retention/);
  });
});

describe("release gate runner", () => {
  it("fails when a pnpm gate exits non-zero", () => {
    const spawnSyncImpl = vi.fn(() => ({ status: 7 }));
    expect(() => runGate("lint", "lint", { cwd: os.tmpdir(), spawnSyncImpl })).toThrow(/lint failed with exit code 7/);
    expect(spawnSyncImpl).toHaveBeenCalledOnce();
  });
});
