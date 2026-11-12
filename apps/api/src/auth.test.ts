import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { Database } from "./infrastructure/db/client.js";
import * as schema from "./infrastructure/db/schema.js";
import { SlidingWindowRateLimiter } from "./modules/auth/rate-limit.js";

const ORIGIN = "http://localhost:5173";

async function createTestApp(
  configOverrides: Partial<AppConfig> = {},
  options: { rateLimiter?: SlidingWindowRateLimiter } = {},
) {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: path.resolve("database/migrations") });
  const base = loadConfig({
    LOG_LEVEL: "silent",
    ALLOWED_ORIGINS: ORIGIN,
    AUTH_RATE_LIMIT_REGISTER_MAX: "100",
    AUTH_RATE_LIMIT_LOGIN_IP_MAX: "100",
    AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX: "100",
    AUTH_RATE_LIMIT_REFRESH_MAX: "100",
  });
  const config: AppConfig = {
    ...base,
    cookieSecret: "test-cookie-secret-with-32-chars",
    sessionTtlSeconds: 60 * 60,
    ...configOverrides,
  };
  const app = await buildApp({
    config,
    db: pgliteDb as unknown as Database,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
  });
  return { app, client, db: pgliteDb };
}

describe("database migrations", () => {
  it("applies all schema tables, indexes, and constraints cleanly on a fresh database", async () => {
    const client = new PGlite();
    const pgliteDb = drizzle(client, { schema });
    await migrate(pgliteDb, { migrationsFolder: path.resolve("database/migrations") });

    const tablesResult = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    const tableNames = tablesResult.rows.map((row) => row.tablename);
    expect(tableNames).toEqual([
      "audit_events",
      "evaluation_jobs",
      "evaluations",
      "findings",
      "ignored_terms",
      "plans",
      "resume_versions",
      "resumes",
      "retention_tasks",
      "sessions",
      "subscriptions",
      "usage_counters",
      "users",
    ]);

    // Re-running migrate is idempotent
    await migrate(pgliteDb, { migrationsFolder: path.resolve("database/migrations") });
    await client.close();
  });
});

describe("authentication", () => {
  it("registers a free user, logs in, sets HttpOnly/Secure cookies in production, and rejects duplicate emails", async () => {
    const { app, client } = await createTestApp({ secureCookies: true });
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
    expect(duplicate.json()).toMatchObject({ error: { code: "EMAIL_IN_USE" } });

    const badPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "person@example.com", password: "wrong-password" },
    });
    expect(badPassword.statusCode).toBe(401);
    expect(badPassword.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });

    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "nobody@example.com", password: "correct-horse" },
    });
    expect(unknownEmail.statusCode).toBe(401);
    expect(unknownEmail.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });

    const success = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "person@example.com", password: "correct-horse" },
    });
    expect(success.statusCode).toBe(200);
    const sessionCookie = success.cookies.find((cookie) => cookie.name === "vervecv_session");
    const refreshCookie = success.cookies.find((cookie) => cookie.name === "vervecv_refresh");
    expect(sessionCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api/v1",
    });
    expect(refreshCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api/v1/auth",
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${sessionCookie?.value ?? ""}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: "person@example.com" } });

    const tamperedMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: "vervecv_session=tampered-unsigned-value" },
    });
    expect(tamperedMe.statusCode).toBe(401);

    const usage = await app.inject({
      method: "GET",
      url: "/api/v1/usage",
      headers: { cookie: `vervecv_session=${sessionCookie?.value ?? ""}` },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({ evaluationsUsed: 0, uploadBytesUsed: 0, limits: null });

    await app.close();
    await client.close();
  });

  it("handles concurrent registrations for the same email with exactly one 201 and the rest 409", async () => {
    const { app, client } = await createTestApp();
    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/register",
          headers: { origin: ORIGIN },
          payload: {
            email: "race@example.com",
            password: `correct-horse-${index}`,
          },
        }),
      ),
    );

    const statuses = attempts.map((res) => res.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);

    await app.close();
    await client.close();
  });

  it("rotates refresh tokens atomically under concurrent requests so at most one succeeds", async () => {
    const { app, client } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "atomic@example.com", password: "correct-horse" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "atomic@example.com", password: "correct-horse" },
    });
    const initialRefresh = login.cookies.find((cookie) => cookie.name === "vervecv_refresh");
    expect(initialRefresh).toBeDefined();

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/refresh",
          headers: {
            origin: ORIGIN,
            cookie: `vervecv_refresh=${initialRefresh?.value ?? ""}`,
          },
        }),
      ),
    );

    const successes = concurrent.filter((res) => res.statusCode === 200);
    const rejections = concurrent.filter((res) => res.statusCode === 401);
    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(4);
    for (const rejected of rejections) {
      expect(rejected.json()).toMatchObject({ error: { code: "REFRESH_REUSE" } });
    }

    // Because concurrent reuse occurred on the same token family, even the rotated token
    // issued to the first request is revoked by family reuse detection.
    const issuedRefresh = successes[0]?.cookies.find((cookie) => cookie.name === "vervecv_refresh");
    const issuedSession = successes[0]?.cookies.find((cookie) => cookie.name === "vervecv_session");
    const followUpRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: {
        origin: ORIGIN,
        cookie: `vervecv_refresh=${issuedRefresh?.value ?? ""}`,
      },
    });
    expect(followUpRefresh.statusCode).toBe(401);

    const followUpMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${issuedSession?.value ?? ""}` },
    });
    expect(followUpMe.statusCode).toBe(401);

    await app.close();
    await client.close();
  });

  it("revokes only the compromised token family on reuse and preserves independent device sessions", async () => {
    const { app, client } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "ada@example.com", password: "correct-horse" },
    });

    // Device A logs in and rotates
    const deviceALogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "ada@example.com", password: "correct-horse" },
    });
    const deviceARefresh1 = deviceALogin.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    // Device B logs in independently
    const deviceBLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "ada@example.com", password: "correct-horse" },
    });
    const deviceBSession = deviceBLogin.cookies.find((cookie) => cookie.name === "vervecv_session");
    const deviceBRefresh = deviceBLogin.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    const rotatedA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${deviceARefresh1?.value ?? ""}` },
    });
    expect(rotatedA.statusCode).toBe(200);
    const deviceARefresh2 = rotatedA.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    // Replay old Device A token -> revokes Device A family
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${deviceARefresh1?.value ?? ""}` },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ error: { code: "REFRESH_REUSE" } });

    const afterReuseA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${deviceARefresh2?.value ?? ""}` },
    });
    expect(afterReuseA.statusCode).toBe(401);

    // Device B remains valid
    const meB = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${deviceBSession?.value ?? ""}` },
    });
    expect(meB.statusCode).toBe(200);

    const refreshB = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${deviceBRefresh?.value ?? ""}` },
    });
    expect(refreshB.statusCode).toBe(200);

    await app.close();
    await client.close();
  });

  it("invalidates session and refresh lineage on logout, including refresh/logout races, without logging out other devices", async () => {
    const { app, client } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "logout@example.com", password: "correct-horse" },
    });

    // Device 1
    const login1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "logout@example.com", password: "correct-horse" },
    });
    const session1 = login1.cookies.find((cookie) => cookie.name === "vervecv_session");
    const refresh1 = login1.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    // Device 2 (independent login)
    const login2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "logout@example.com", password: "correct-horse" },
    });
    const session2 = login2.cookies.find((cookie) => cookie.name === "vervecv_session");

    // Race refresh and logout on Device 1 using stale session1 + refresh1
    const [refreshRace, logoutRace] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        headers: {
          origin: ORIGIN,
          cookie: `vervecv_refresh=${refresh1?.value ?? ""}`,
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          origin: ORIGIN,
          cookie: `vervecv_session=${session1?.value ?? ""}; vervecv_refresh=${refresh1?.value ?? ""}`,
        },
      }),
    ]);

    expect(logoutRace.statusCode).toBe(204);

    // Regardless of whether refresh or logout ran first, the entire Device 1 lineage must now be dead
    const postRaceMe1 = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${session1?.value ?? ""}` },
    });
    expect(postRaceMe1.statusCode).toBe(401);

    const postRaceRefresh1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${refresh1?.value ?? ""}` },
    });
    expect(postRaceRefresh1.statusCode).toBe(401);

    if (refreshRace.statusCode === 200) {
      const childSession = refreshRace.cookies.find((cookie) => cookie.name === "vervecv_session");
      const childRefresh = refreshRace.cookies.find((cookie) => cookie.name === "vervecv_refresh");

      const childMe = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { cookie: `vervecv_session=${childSession?.value ?? ""}` },
      });
      expect(childMe.statusCode).toBe(401);

      const childRefreshAttempt = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        headers: { origin: ORIGIN, cookie: `vervecv_refresh=${childRefresh?.value ?? ""}` },
      });
      expect(childRefreshAttempt.statusCode).toBe(401);
    }

    // Also verify logout when ONLY the refresh cookie is sent (e.g. expired/missing session cookie)
    const login3 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "logout@example.com", password: "correct-horse" },
    });
    const session3 = login3.cookies.find((cookie) => cookie.name === "vervecv_session");
    const refresh3 = login3.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    const refreshOnlyLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${refresh3?.value ?? ""}` },
    });
    expect(refreshOnlyLogout.statusCode).toBe(204);

    const me3AfterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${session3?.value ?? ""}` },
    });
    expect(me3AfterLogout.statusCode).toBe(401);

    // Device 2 remains active (single-device logout, not logout-all-devices)
    const me2 = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${session2?.value ?? ""}` },
    });
    expect(me2.statusCode).toBe(200);

    await app.close();
    await client.close();
  });

  it("enforces CSRF origin checks on cookie-authenticated mutating endpoints", async () => {
    const { app, client } = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "csrf@example.com", password: "correct-horse" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "csrf@example.com", password: "correct-horse" },
    });
    const sessionCookie = login.cookies.find((cookie) => cookie.name === "vervecv_session");
    const refreshCookie = login.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    const crossSiteRefresh = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: {
        origin: "https://attacker.example",
        cookie: `vervecv_refresh=${refreshCookie?.value ?? ""}`,
      },
    });
    expect(crossSiteRefresh.statusCode).toBe(403);
    expect(crossSiteRefresh.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });

    const crossSiteFormLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `vervecv_session=${sessionCookie?.value ?? ""}; vervecv_refresh=${refreshCookie?.value ?? ""}`,
      },
      payload: "logout=1",
    });
    expect(crossSiteFormLogout.statusCode).toBe(403);

    // Session was NOT revoked by cross-site CSRF attempt
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: `vervecv_session=${sessionCookie?.value ?? ""}` },
    });
    expect(me.statusCode).toBe(200);

    await app.close();
    await client.close();
  });

  it("rate limits registration, login, and refresh with 429 and Retry-After", async () => {
    let fakeNow = 1_700_000_000_000;
    const limiter = new SlidingWindowRateLimiter({ now: () => fakeNow });
    const { app, client } = await createTestApp(
      {
        authRateLimits: {
          register: { max: 2, windowMs: 60_000 },
          loginIp: { max: 4, windowMs: 60_000 },
          loginAccount: { max: 2, windowMs: 60_000 },
          refresh: { max: 2, windowMs: 60_000 },
        },
      },
      { rateLimiter: limiter },
    );

    // Register limit = 2 per window
    const r1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "rl1@example.com", password: "correct-horse" },
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "rl2@example.com", password: "correct-horse" },
    });
    const r3 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "rl3@example.com", password: "correct-horse" },
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r3.statusCode).toBe(429);
    expect(r3.headers["retry-after"]).toBe("60");
    expect(r3.json()).toMatchObject({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });

    // Login per-account limit = 2 per window
    const l1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "rl1@example.com", password: "wrong-password" },
    });
    const l2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "RL1@example.com", password: "wrong-password" },
    });
    const l3 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "rl1@example.com", password: "correct-horse" },
    });
    expect(l1.statusCode).toBe(401);
    expect(l2.statusCode).toBe(401);
    expect(l3.statusCode).toBe(429);
    expect(l3.headers["retry-after"]).toBe("60");
    expect(l3.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });

    // Second account still allowed under per-IP limit (loginIp max = 4)
    const lOther = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "rl2@example.com", password: "correct-horse" },
    });
    expect(lOther.statusCode).toBe(200);
    const refreshCookie = lOther.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    // 5th login from same IP hits loginIp limit (max = 4)
    const lIpBlocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "rl2@example.com", password: "correct-horse" },
    });
    expect(lIpBlocked.statusCode).toBe(429);

    // Refresh limit = 2 per window
    const ref1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${refreshCookie?.value ?? ""}` },
    });
    expect(ref1.statusCode).toBe(200);
    const nextRefresh = ref1.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    const ref2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${nextRefresh?.value ?? ""}` },
    });
    expect(ref2.statusCode).toBe(200);
    const thirdRefresh = ref2.cookies.find((cookie) => cookie.name === "vervecv_refresh");

    const ref3 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${thirdRefresh?.value ?? ""}` },
    });
    expect(ref3.statusCode).toBe(429);
    expect(ref3.headers["retry-after"]).toBe("60");
    expect(ref3.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });

    // Advance past rate-limit window -> requests succeed again
    fakeNow += 61_000;
    const refAfterWindow = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { origin: ORIGIN, cookie: `vervecv_refresh=${thirdRefresh?.value ?? ""}` },
    });
    expect(refAfterWindow.statusCode).toBe(200);

    await app.close();
    await client.close();
  });

  it("does not leak database SQL, table names, or credentials on unexpected database failures", async () => {
    const brokenDb = {
      select: () => {
        throw new Error(
          'relation "users" failed on postgres://vervecv_admin:secret_pw_123@neon.tech/neondb',
        );
      },
      transaction: async () => {
        throw new Error(
          'insert into "users" ("email", "password_hash") values ($1, $2) failed: secret_pw_123',
        );
      },
    } as unknown as Database;

    const config = {
      ...loadConfig({ LOG_LEVEL: "silent", ALLOWED_ORIGINS: ORIGIN }),
      cookieSecret: "test-cookie-secret-with-32-chars",
    };
    const app = await buildApp({ config, db: brokenDb });

    const regFailure = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      headers: { origin: ORIGIN },
      payload: { email: "leak@example.com", password: "correct-horse" },
    });
    expect(regFailure.statusCode).toBe(500);
    expect(regFailure.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal error",
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(regFailure.json())).not.toContain("secret_pw_123");
    expect(JSON.stringify(regFailure.json())).not.toContain("password_hash");

    const loginFailure = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: ORIGIN },
      payload: { email: "leak@example.com", password: "correct-horse" },
    });
    expect(loginFailure.statusCode).toBe(500);
    expect(loginFailure.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal error",
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(loginFailure.json())).not.toContain("neon.tech");

    await app.close();
  });

  it("does not expose another user's session", async () => {
    const { app, client } = await createTestApp();
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
    await client.close();
  });
});
