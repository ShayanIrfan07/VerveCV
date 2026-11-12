import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("binds to all interfaces, port 3000, and non-secure cookies outside production", () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      databaseUrl: null,
      secureCookies: false,
    });
    expect(cfg.authRateLimits.register.max).toBe(5);
    expect(cfg.authRateLimits.loginIp.max).toBe(10);
    expect(cfg.authRateLimits.loginAccount.max).toBe(5);
    expect(cfg.authRateLimits.refresh.max).toBe(20);
  });

  it("enables Secure cookies in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).secureCookies).toBe(true);
  });

  it("rejects an invalid port or invalid rate-limit configuration", () => {
    expect(() => loadConfig({ PORT: "0" })).toThrow(/PORT/);
    expect(() => loadConfig({ AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: "0" })).toThrow(
      /AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX/,
    );
  });
});
