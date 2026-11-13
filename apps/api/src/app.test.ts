import type { Database } from "./infrastructure/db/client.js";
import { describe, expect, it } from "vitest";
import { buildApp, MAX_REQUEST_ID_LENGTH, resolveRequestId } from "./app.js";
import { loadConfig } from "./config.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function testConfig(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  return {
    ...loadConfig({ LOG_LEVEL: "silent", ALLOWED_ORIGINS: "http://localhost:5173" }),
    cookieSecret: "test-cookie-secret-with-32-chars",
    ...overrides,
  };
}

describe("health and HTTP security headers", () => {
  it("reports the process as live and sets defensive response headers", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
    expect(response.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    expect(String(response.headers["content-security-policy"])).not.toContain("lottie");
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

  it("reports unavailable without leaking connection details when the database check fails", async () => {
    const db = {
      execute: async () => {
        throw new Error("connection refused: postgres://admin:supersecret@db.internal:5432/vervecv");
      },
    } as unknown as Database;
    const app = await buildApp({ config: testConfig(), db });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "DATABASE_UNAVAILABLE", message: "Database is unavailable" },
    });
    expect(JSON.stringify(response.json())).not.toContain("supersecret");
    expect(JSON.stringify(response.json())).not.toContain("db.internal");
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
    expect(response.headers["x-request-id"]).toBe("req-404");
    await app.close();
  });

  it("rejects a mutating request from an unknown or missing origin", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const badOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { email: "a@example.com", password: "correct-horse" },
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: "vervecv_session=fake" },
    });
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    await app.close();
  });
});

describe("x-request-id validation", () => {
  it("preserves safe alphanumeric, hyphen, underscore, and dot request IDs up to max length", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const maxLenId = "r".repeat(MAX_REQUEST_ID_LENGTH);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/missing",
      headers: { "x-request-id": maxLenId },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.requestId).toBe(maxLenId);
    expect(response.headers["x-request-id"]).toBe(maxLenId);
    await app.close();
  });

  it("replaces empty or excessive-length x-request-id headers with a generated UUID", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const oversized = "a".repeat(MAX_REQUEST_ID_LENGTH + 1);

    for (const candidate of ["", oversized, "x".repeat(4096)]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/missing",
        headers: { "x-request-id": candidate },
      });

      const requestId = response.json().error.requestId as string;
      expect(requestId).not.toBe(candidate);
      expect(requestId).toMatch(UUID_V4_PATTERN);
      expect(response.headers["x-request-id"]).toBe(requestId);
    }

    await app.close();
  });

  it("rejects malformed x-request-id formats and multiple header values by generating a safe UUID", async () => {
    const app = await buildApp({ config: testConfig(), db: null });
    const httpInjectableInvalidInputs: Array<string | string[]> = [
      "   ",
      "req with spaces",
      "<script>alert(1)</script>",
      "../etc/passwd",
      "req;drop-table",
      "id-émoji-🚀",
      ["req-1", "req-2"],
    ];

    for (const invalid of httpInjectableInvalidInputs) {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/missing",
        headers: { "x-request-id": invalid },
      });

      const requestId = response.json().error.requestId as string;
      expect(requestId).toMatch(UUID_V4_PATTERN);
      expect(response.headers["x-request-id"]).toBe(requestId);
    }

    for (const rawInvalid of [undefined, "req\r\ninjected: true", "id-\u0000-null", ["a", "b"]]) {
      expect(resolveRequestId(rawInvalid)).toMatch(UUID_V4_PATTERN);
    }

    await app.close();
  });
});
