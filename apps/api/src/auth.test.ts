import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { Database } from "./infrastructure/db/client.js";
import * as schema from "./infrastructure/db/schema.js";

const ORIGIN = "http://localhost:5173";

async function createTestApp() {
  const client = new PGlite();
  const sqlite = drizzle(client, { schema });
  await migrate(sqlite, { migrationsFolder: path.resolve("database/migrations") });
  const config = {
    ...loadConfig({ LOG_LEVEL: "silent", ALLOWED_ORIGINS: ORIGIN }),
    cookieSecret: "test-cookie-secret-with-32-chars",
    sessionTtlSeconds: 60 * 60,
  };
  const app = await buildApp({ config, db: sqlite as unknown as Database });
  return app;
}

describe("authentication", () => {
  it("registers a free user, logs in, and rejects a second account with the same email", async () => {
    const app = await createTestApp();
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "Person@Example.com", password: "correct-horse", displayName: "Person" },
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.json()).toEqual({
      user: { id: expect.any(String), email: "person@example.com", displayName: "Person" },
    });
    expect(JSON.stringify(registered.json())).not.toContain("password");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "person@example.com", password: "another-password" },
    });
    expect(duplicate.statusCode).toBe(409);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "person@example.com", password: "wrong-password" },
    });
    expect(login.statusCode).toBe(401);

    const success = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "person@example.com", password: "correct-horse" },
    });
    expect(success.statusCode).toBe(200);
    const sessionCookie = success.cookies.find((cookie) => cookie.name === "vervecv_session");
    expect(sessionCookie).toBeDefined();
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${sessionCookie?.value ?? ""}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: "person@example.com" } });

    const usage = await app.inject({
      method: "GET",
      url: "/api/v1/usage",
      headers: { cookie: `vervecv_session=${sessionCookie?.value ?? ""}` },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({ evaluationsUsed: 0, uploadBytesUsed: 0, limits: null });
    await app.close();
  });

  it("rotates refresh tokens and revokes the family when an old token is reused", async () => {
    const app = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "ada@example.com", password: "correct-horse" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "ada@example.com", password: "correct-horse" },
    });
    const originalRefresh = login.cookies.find((cookie) => cookie.name === "vervecv_refresh");
    expect(originalRefresh).toBeDefined();

    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${originalRefresh?.value ?? ""}` },
    });
    expect(rotated.statusCode).toBe(200);
    const nextRefresh = rotated.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${originalRefresh?.value ?? ""}` },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ error: { code: "REFRESH_REUSE" } });

    const afterReuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${nextRefresh?.value ?? ""}` },
    });
    expect(afterReuse.statusCode).toBe(401);
    await app.close();
  });

  it("does not expose another user's session", async () => {
    const app = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "one@example.com", password: "correct-horse" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "two@example.com", password: "correct-horse" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "one@example.com", password: "correct-horse" },
    });
    const session = login.cookies.find((cookie) => cookie.name === "vervecv_session");
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${session?.value ?? ""}` },
    });
    expect(me.json()).toMatchObject({ user: { email: "one@example.com" } });
    expect(JSON.stringify(me.json())).not.toContain("two@example.com");
    await app.close();
  });
});
