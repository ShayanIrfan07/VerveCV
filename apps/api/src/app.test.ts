import type { Database } from "./infrastructure/db/client.js";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

function testConfig(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  return {
    ...loadConfig({ LOG_LEVEL: "silent", ALLOWED_ORIGINS: "http://localhost:5173" }),
    cookieSecret: "test-cookie-secret-with-32-chars",
    ...overrides,
  };
}

describe("health endpoints", () => {
  it("reports the process as live", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
    await app.close();
  });

  it("is not ready when the database is not configured", async () => {
    const app = await buildApp({ config: testConfig({ databaseUrl: null }), db: null });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "DATABASE_NOT_CONFIGURED", message: "Database is not configured" },
    });
    await app.close();
  });

  it("reports ready when the database answers", async () => {
    const db = { execute: async () => ({}) } as unknown as Database;
    const app = await buildApp({ config: testConfig(), db });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    await app.close();
  });

  it("reports unavailable when the database check fails", async () => {
    const db = {
      execute: async () => {
        throw new Error("connection refused");
      },
    } as unknown as Database;
    const app = await buildApp({ config: testConfig(), db });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "DATABASE_UNAVAILABLE" } });
    await app.close();
  });

  it("returns the standard error envelope for unknown routes", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/missing",
      headers: { "x-request-id": "req-404" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Not found", requestId: "req-404" },
    });
    await app.close();
  });

  it("rejects a mutating request from an unknown origin", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { email: "a@example.com", password: "correct-horse" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    await app.close();
  });
});
