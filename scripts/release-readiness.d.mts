import type { HealthLiveProbeReport } from "./measure-api-memory.mjs";
import type { SpawnSyncReturns } from "node:child_process";

export const LOCAL_MEASUREMENTS_RELATIVE: "docs/release/measurements.local.json";
export const EXAMPLE_MEASUREMENTS_RELATIVE: "docs/release/measurements.example.json";
export const LEGACY_TRACKED_MEASUREMENTS_RELATIVE: "docs/release/measurements.json";
export const RELEASE_GATES: ReadonlyArray<readonly [string, string]>;

export interface ResolveMeasurementsOptions {
  relativePath?: string;
}

export interface ReleaseReport {
  generatedAt: string;
  completedAt: string;
  node: string;
  platform: string;
  gates: string[];
  probe: HealthLiveProbeReport;
  notes: string[];
}

export interface BuildReleaseReportInput {
  startedAt: string;
  completedAt: string;
  node: string;
  platform: string;
  gates: string[];
  probe: HealthLiveProbeReport;
}

export interface RunGateOptions {
  cwd?: string;
  spawnSyncImpl?: (
    command: string,
    options: {
      cwd: string;
      stdio: "inherit";
      shell: boolean;
      env: NodeJS.ProcessEnv;
    },
  ) => Pick<SpawnSyncReturns<string>, "status">;
}

export function resolveMeasurementsOutputPath(rootDir: string, options?: ResolveMeasurementsOptions): string;
export function assertSafeMeasurementsOutputPath(rootDir: string, outputPath: string): void;
export function buildReleaseReport(input: BuildReleaseReportInput): ReleaseReport;
export function runGate(label: string, script: string, options?: RunGateOptions): void;
