export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export interface AuthRateLimits {
  register: RateLimitRule;
  loginIp: RateLimitRule;
  loginAccount: RateLimitRule;
  refresh: RateLimitRule;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface BucketEntry {
  timestamps: number[];
  windowMs: number;
}

const DEFAULT_MAX_KEYS = 10_000;
const CLEANUP_INTERVAL = 256;

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly maxKeys: number;
  private readonly nowFn: () => number;
  private operationsSinceCleanup = 0;

  constructor(options: { maxKeys?: number; now?: () => number } = {}) {
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.nowFn = options.now ?? (() => Date.now());
  }

  consume(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = this.nowFn();
    this.maybeSweepExpired(now);

    const cutoff = now - rule.windowMs;
    const existing = this.buckets.get(key);
    const active = existing ? existing.timestamps.filter((ts) => ts > cutoff) : [];

    if (active.length >= rule.max) {
      if (existing) {
        existing.timestamps = active;
        existing.windowMs = rule.windowMs;
        this.buckets.delete(key);
        this.buckets.set(key, existing);
      }
      const oldest = active[0] ?? now;
      const retryAfterMs = Math.max(1, oldest + rule.windowMs - now);
      return {
        allowed: false,
        limit: rule.max,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    active.push(now);
    if (existing) {
      this.buckets.delete(key);
    }
    this.buckets.set(key, { timestamps: active, windowMs: rule.windowMs });
    this.enforceCapacity(now);

    return {
      allowed: true,
      limit: rule.max,
      remaining: Math.max(0, rule.max - active.length),
      retryAfterSeconds: 0,
    };
  }

  private maybeSweepExpired(now: number): void {
    this.operationsSinceCleanup += 1;
    if (this.operationsSinceCleanup < CLEANUP_INTERVAL) {
      return;
    }
    this.operationsSinceCleanup = 0;
    this.sweepExpired(now);
  }

  private sweepExpired(now: number): void {
    for (const [key, entry] of this.buckets.entries()) {
      const cutoff = now - entry.windowMs;
      const active = entry.timestamps.filter((ts) => ts > cutoff);
      if (active.length === 0) {
        this.buckets.delete(key);
      } else {
        entry.timestamps = active;
      }
    }
  }

  private enforceCapacity(now: number): void {
    if (this.buckets.size <= this.maxKeys) {
      return;
    }
    this.sweepExpired(now);
    while (this.buckets.size > this.maxKeys) {
      const oldestInsertedKey = this.buckets.keys().next().value;
      if (oldestInsertedKey === undefined) {
        break;
      }
      this.buckets.delete(oldestInsertedKey);
    }
  }
}
