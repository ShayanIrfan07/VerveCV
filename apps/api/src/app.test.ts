import { describe, expect, it } from "vitest";
import { buildApp, MAX_REQUEST_ID_LENGTH, resolveRequestId } from "./app.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("health endpoints", () => {
  it("reports the process as live", async () => {
    const app = buildApp({ databaseUrl: null, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
    expect(response.headers["x-request-id"]).toMatch(UUID_V4_PATTERN);
    await app.close();
  });

  it("is not ready when the database is not configured", async () => {
    const app = buildApp({ databaseUrl: null, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "DATABASE_NOT_CONFIGURED", message: "Database is not configured" },
    });
    await app.close();
  });

  it("does not claim the database is reachable before the check exists", async () => {
    const app = buildApp({ databaseUrl: "postgres://example", logger: false });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "DATABASE_CHECK_NOT_IMPLEMENTED" },
    });
    await app.close();
  });

  it("returns the standard error envelope for unknown routes", async () => {
    const app = buildApp({ databaseUrl: null, logger: false });
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
});

describe("x-request-id validation", () => {
  it("preserves safe alphanumeric, hyphen, underscore, and dot request IDs up to max length", async () => {
    const app = buildApp({ databaseUrl: null, logger: false });
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
    const app = buildApp({ databaseUrl: null, logger: false });
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
    const app = buildApp({ databaseUrl: null, logger: false });
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
