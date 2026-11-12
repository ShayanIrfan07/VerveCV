export const LIMIT_BYTES: number;

export interface MeasuredDependency {
  name: string;
  version: string;
  bytes: number;
  path: string;
}

export interface AnalyzeFootprintOptions {
  rootDir?: string;
  limitBytes?: number;
  trackedFiles?: readonly string[];
}

export interface MeasureSourceOptions {
  trackedFiles?: readonly string[];
}

export interface FootprintReport {
  sourceBytes: number;
  dependencyBytes: number;
  totalBytes: number;
  limitBytes: number;
  headroomBytes: number;
  exceeded: boolean;
  dependencies: MeasuredDependency[];
  frontendBundleBytes: number | null;
  backendArtifactBytes: number | null;
}

export interface RunSizeCheckOptions extends AnalyzeFootprintOptions {
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

export interface RunSizeCheckResult extends FootprintReport {
  exitCode: number;
}

export function isExcludedSource(file: string): boolean;
export function listGitTrackedFiles(rootDir: string): string[];
export function measureSourceBytes(rootDir: string, options?: MeasureSourceOptions): number;
export function measureProductionDependencies(rootDir: string): MeasuredDependency[];
export function analyzeFootprint(options?: AnalyzeFootprintOptions): FootprintReport;
export function runSizeCheck(options?: RunSizeCheckOptions): RunSizeCheckResult;
export function formatBytes(bytes: number): string;
