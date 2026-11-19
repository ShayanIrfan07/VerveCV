import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { MAX_SIGNED_URL_TTL_SECONDS } from "./infrastructure/storage/r2.js";

describe("loadConfig", () => {
  it("binds to all interfaces, port 3000, and configurable development defaults", () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      databaseUrl: null,
      secureCookies: false,
      uploadLimitBytes: 5 * 1024 * 1024,
      signedUrlTtlSeconds: null,
      parseMaxQueue: 16,
      parseQueueTimeoutMs: 5_000,
      maxPendingUploadsPerUser: 10,
      uploadIntentGraceSeconds: 60,
      uploadRateLimit: null,
      evaluateRateLimit: null,
      retentionPollMs: null,
      retentionLeaseMs: 60_000,
      retentionBaseBackoffMs: 5_000,
      retentionMaxBackoffMs: 3_600_000,
      retentionMaxAttempts: 8,
      r2: null,
    });
    expect(cfg.authRateLimits.register.max).toBe(5);
    expect(cfg.authRateLimits.loginIp.max).toBe(10);
    expect(cfg.authRateLimits.loginAccount.max).toBe(5);
    expect(cfg.authRateLimits.refresh.max).toBe(20);
  });

  it("enables Secure cookies, periodic retention polling, and upload/evaluation rate limits by default in production", () => {
    const prod = loadConfig({ NODE_ENV: "production" });
    expect(prod.secureCookies).toBe(true);
    expect(prod.retentionPollMs).toBe(300_000);
    expect(prod.uploadRateLimit).toEqual({ max: 10, windowMs: 60_000 });
    expect(prod.evaluateRateLimit).toEqual({ max: 10, windowMs: 60_000 });

    const overridden = loadConfig({
      NODE_ENV: "production",
      RETENTION_POLL_MS: "120000",
      UPLOAD_RATE_LIMIT_MAX: "25",
      UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "120",
      EVALUATE_RATE_LIMIT_MAX: "15",
      EVALUATE_RATE_LIMIT_WINDOW_SECONDS: "120",
    });
    expect(overridden.retentionPollMs).toBe(120_000);
    expect(overridden.uploadRateLimit).toEqual({ max: 25, windowMs: 120_000 });
    expect(overridden.evaluateRateLimit).toEqual({ max: 15, windowMs: 120_000 });
  });

  it("validates port, rate-limit, retention backoff, parse-queue, signed URL TTL, and R2 settings", () => {
    expect(() => loadConfig({ PORT: "0" })).toThrow(/PORT/);
    expect(() => loadConfig({ UPLOAD_RATE_LIMIT_MAX: "2" })).toThrow(
      /UPLOAD_RATE_LIMIT_MAX and UPLOAD_RATE_LIMIT_WINDOW_SECONDS/,
    );
    expect(() => loadConfig({ NODE_ENV: "production", EVALUATE_RATE_LIMIT_MAX: "5" })).toThrow(
      /EVALUATE_RATE_LIMIT_MAX and EVALUATE_RATE_LIMIT_WINDOW_SECONDS/,
    );
    expect(() => loadConfig({ AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: "0" })).toThrow(
      /AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX/,
    );
    expect(() => loadConfig({ RETENTION_POLL_MS: "0" })).toThrow(/RETENTION_POLL_MS/);
    expect(() => loadConfig({ RETENTION_LEASE_MS: "0" })).toThrow(/RETENTION_LEASE_MS/);
    expect(() => loadConfig({ RETENTION_MAX_ATTEMPTS: "0" })).toThrow(/RETENTION_MAX_ATTEMPTS/);
    expect(() =>
      loadConfig({
        RETENTION_BASE_BACKOFF_MS: "10000",
        RETENTION_MAX_BACKOFF_MS: "5000",
      }),
    ).toThrow(/RETENTION_MAX_BACKOFF_MS/);
    expect(() => loadConfig({ PARSE_MAX_QUEUE: "-1" })).toThrow(/PARSE_MAX_QUEUE/);
    expect(loadConfig({ PARSE_MAX_QUEUE: "0" }).parseMaxQueue).toBe(0);
    expect(() => loadConfig({ PARSE_QUEUE_TIMEOUT_MS: "0" })).toThrow(/PARSE_QUEUE_TIMEOUT_MS/);
    expect(() =>
      loadConfig({ SIGNED_URL_TTL_SECONDS: String(MAX_SIGNED_URL_TTL_SECONDS + 1) }),
    ).toThrow(/SIGNED_URL_TTL_SECONDS/);
    expect(() => loadConfig({ R2_ACCOUNT_ID: "only-one-field" })).toThrow(/R2 configuration/);
    expect(() =>
      loadConfig({
        R2_ACCOUNT_ID: "evil.example#",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "vervecv-private",
      }),
    ).toThrow(/R2_ACCOUNT_ID/);
    expect(
      loadConfig({
        R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "vervecv-private",
      }).r2?.bucket,
    ).toBe("vervecv-private");
  });
});
