export const HEALTH_LIVE_PROBE_KIND: "fastify-inject-health-live";
export const HEALTH_LIVE_PROBE_NOTES: readonly string[];

export interface LatencySummary {
  p50: number;
  p95: number;
  max: number;
}

export interface MemorySnapshot {
  beforeRss: number;
  afterRss: number;
  beforeHeapUsed: number;
  afterHeapUsed: number;
  rssDelta: number;
  heapDelta: number;
}

export interface HealthLiveProbeReport {
  kind: typeof HEALTH_LIVE_PROBE_KIND;
  scope: "in-process-only";
  excludes: readonly string[];
  rounds: number;
  latencyMs: LatencySummary;
  memory: MemorySnapshot;
}

export interface MeasureApiMemoryOptions {
  rounds?: number;
  importApp?: () => Promise<{
    buildApp: (deps: { config: unknown; db: null }) => Promise<{
      inject: (request: { method: string; url: string }) => Promise<{ statusCode: number }>;
      close: () => Promise<void>;
    }>;
    loadConfig: (env?: Record<string, string>) => Record<string, unknown>;
  }>;
}

export function percentile(sortedSamples: readonly number[], fraction: number): number;
export function summarizeLatencyMs(samples: readonly number[]): LatencySummary;
export function measureApiMemoryAndLatency(options?: MeasureApiMemoryOptions): Promise<HealthLiveProbeReport>;
