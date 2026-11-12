import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { MAX_SIGNED_URL_TTL_SECONDS } from "./infrastructure/storage/r2.js";

describe("loadConfig", () => {
  it("binds to all interfaces, port 3000, and sensible operational defaults", () => {
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
      r2: null,
    });
    expect(cfg.authRateLimits.register.max).toBe(5);
    expect(cfg.authRateLimits.loginIp.max).toBe(10);
    expect(cfg.authRateLimits.loginAccount.max).toBe(5);
    expect(cfg.authRateLimits.refresh.max).toBe(20);
  });

  it("enables Secure cookies in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).secureCookies).toBe(true);
  });

  it("validates port, rate-limit, parse-queue, signed URL TTL, and R2 settings", () => {
    expect(() => loadConfig({ PORT: "0" })).toThrow(/PORT/);
    expect(() => loadConfig({ AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: "0" })).toThrow(
      /AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX/,
    );
    expect(() => loadConfig({ PARSE_MAX_QUEUE: "-1" })).toThrow(/PARSE_MAX_QUEUE/);
    expect(loadConfig({ PARSE_MAX_QUEUE: "0" }).parseMaxQueue).toBe(0);
    expect(() => loadConfig({ PARSE_QUEUE_TIMEOUT_MS: "0" })).toThrow(/PARSE_QUEUE_TIMEOUT_MS/);
    expect(() =>
      loadConfig({ SIGNED_URL_TTL_SECONDS: String(MAX_SIGNED_URL_TTL_SECONDS + 1) }),
    ).toThrow(/SIGNED_URL_TTL_SECONDS/);
    expect(() => loadConfig({ R2_ACCOUNT_ID: "only-one-field" })).toThrow(/R2 configuration/);
  });
});
