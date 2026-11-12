import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("health endpoints", () => {
  it("reports the process as live", async () => {
    const app = buildApp({ databaseUrl: null, logger: false });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
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
    await app.close();
  });
});
