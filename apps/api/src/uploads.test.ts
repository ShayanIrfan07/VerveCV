import { PGlite } from "@electric-sql/pglite";
import {
  corruptPdfBytes,
  emptyPdfBytes,
  encryptedDocxBytes,
  PDF_MIME,
  sampleDocxBytes,
  samplePdfBytes,
} from "@vervecv/documents";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { Database } from "./infrastructure/db/client.js";
import * as schema from "./infrastructure/db/schema.js";
import { MemoryStorage, type ObjectStorage } from "./infrastructure/storage/memory.js";
import { ParseGate } from "./modules/uploads/parse-gate.js";
import { cleanupAbandonedUploadIntents, completeUpload, createUploadIntent } from "./modules/uploads/service.js";
import { createDeflateZip } from "../../../packages/documents/src/zip-node.js";

const ORIGIN = "http://localhost:5173";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function createTestApp(
  overrides: Partial<AppConfig> = {},
  options: { storage?: ObjectStorage; parseGate?: ParseGate | null } = {},
) {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: path.resolve("database/migrations") });
  const defaultStorage = new MemoryStorage();
  const storage = options.storage ?? defaultStorage;
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
    signedUrlTtlSeconds: 300,
    pdfPageCap: 5,
    docxEntryCap: 20,
    docxUncompressedBytes: 1_000_000,
    parseTimeoutMs: 10_000,
    parseConcurrency: 4,
    parseMaxQueue: 16,
    parseQueueTimeoutMs: 5_000,
    ...overrides,
  };
  const parseGate =
    options.parseGate !== undefined
      ? options.parseGate
      : config.parseConcurrency === null
        ? null
        : new ParseGate(config.parseConcurrency, {
            maxQueue: config.parseMaxQueue,
            maxWaitMs: config.parseQueueTimeoutMs,
          });
  const db = database as unknown as Database;
  const app = await buildApp({
    config,
    db,
    storage,
    parseGate,
  });
  return { app, client, db, pgliteDb: database, storage: defaultStorage, config, parseGate };
}

async function sessionFor(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin: ORIGIN },
    payload: { email, password: "correct-horse" },
  });
  expect(registered.statusCode).toBe(201);
  const userId = registered.json<{ user: { id: string } }>().user.id;
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: ORIGIN },
    payload: { email, password: "correct-horse" },
  });
  const cookie = login.cookies.find((item) => item.name === "vervecv_session");
  return { cookie: `vervecv_session=${cookie?.value ?? ""}`, userId };
}

describe("resume upload", () => {
  it("verifies a PDF, hides it from another user, and soft-deletes it while queueing a pending retention task", async () => {
    const { app, client, pgliteDb, storage } = await createTestApp();
    const { cookie: owner } = await sessionFor(app, "owner@example.com");
    const bytes = samplePdfBytes();

    const intent = await app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie: owner },
      payload: { filename: "Resume_Owner.pdf", mimeType: PDF_MIME, sizeBytes: bytes.byteLength },
    });
    expect(intent.statusCode).toBe(201);
    const created = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
    expect(created.upload.url).not.toContain("Resume_Owner");
    const objectKey = created.upload.url.replace("memory://upload/", "");
    await storage.put(objectKey, bytes);

    // Unverified versions cannot generate download URLs yet
    const prematureView = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/view-url`,
      headers: { cookie: owner },
    });
    expect(prematureView.statusCode).toBe(404);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
      headers: { origin: ORIGIN, cookie: owner },
      payload: {},
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ verificationState: "verified", officialScore: null });

    const usage = await app.inject({
      method: "GET",
      url: "/api/v1/usage",
      headers: { cookie: owner },
    });
    expect(usage.json()).toMatchObject({ uploadBytesUsed: bytes.byteLength, limits: null });

    const view = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/view-url`,
      headers: { cookie: owner },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().url).not.toContain("Resume_Owner");

    const { cookie: other } = await sessionFor(app, "other@example.com");
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}`,
      headers: { cookie: other },
    });
    expect(hidden.statusCode).toBe(404);
    const hiddenView = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/view-url`,
      headers: { cookie: other },
    });
    expect(hiddenView.statusCode).toBe(404);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/resumes/${created.resumeId}`,
      headers: { origin: ORIGIN, cookie: owner },
    });
    expect(removed.statusCode).toBe(204);

    // Logical access is immediately revoked across GET, view-url, and complete-upload
    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}`,
      headers: { cookie: owner },
    });
    expect(afterDelete.statusCode).toBe(404);

    const viewAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/view-url`,
      headers: { cookie: owner },
    });
    expect(viewAfterDelete.statusCode).toBe(404);

    // Honest lifecycle verification: retention_tasks is pending and physical object
    // awaits Phase 7's retryable deletion worker (physicalDeletionComplete: false).
    const tasks = await pgliteDb
      .select()
      .from(schema.retentionTasks)
      .where(eq(schema.retentionTasks.resumeVersionId, created.versionId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.state).toBe("pending");
    expect(storage.has(objectKey)).toBe(true);

    const deleteAudits = await pgliteDb
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, "resume_delete_requested"));
    expect(deleteAudits[0]?.safeMetadata).toMatchObject({
      versionCount: 1,
      physicalDeletionComplete: false,
    });

    await app.close();
    await client.close();
  });

  it("is idempotent and concurrency-safe when simultaneous complete-upload requests arrive, never double-counting bytes", async () => {
    const { app, client, pgliteDb, storage } = await createTestApp();
    const { cookie } = await sessionFor(app, "concurrent@example.com");
    const bytes = samplePdfBytes();

    const intent = await app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie },
      payload: { filename: "Concurrent_Resume.pdf", mimeType: PDF_MIME, sizeBytes: bytes.byteLength },
    });
    expect(intent.statusCode).toBe(201);
    const created = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
    await storage.put(created.upload.url.replace("memory://upload/", ""), bytes);

    const concurrentResponses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({
          method: "POST",
          url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
          headers: { origin: ORIGIN, cookie },
          payload: {},
        }),
      ),
    );

    for (const res of concurrentResponses) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        resumeId: created.resumeId,
        versionId: created.versionId,
        verificationState: "verified",
        parserVersion: expect.any(String),
        officialScore: null,
      });
    }

    // Sequential idempotent retry after verification
    const sequentialRetry = await app.inject({
      method: "POST",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
      headers: { origin: ORIGIN, cookie },
      payload: {},
    });
    expect(sequentialRetry.statusCode).toBe(200);

    // Uploaded bytes MUST be counted exactly once, and only 1 verification audit event written
    const usage = await app.inject({ method: "GET", url: "/api/v1/usage", headers: { cookie } });
    expect(usage.json()).toMatchObject({ uploadBytesUsed: bytes.byteLength });

    const verifyAudits = await pgliteDb
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, "resume_upload_verified"));
    expect(verifyAudits).toHaveLength(1);

    await app.close();
    await client.close();
  });

  it("rejects legacy DOC, oversize, wrong magic, unreadable files, client scores, and prevents rejected uploads from later becoming verified", async () => {
    const { app, client, storage } = await createTestApp();
    const { cookie } = await sessionFor(app, "files@example.com");

    const doc = await app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie },
      payload: { filename: "resume.doc", mimeType: "application/msword", sizeBytes: 20 },
    });
    expect(doc.statusCode).toBe(415);

    const oversize = await app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie },
      payload: { filename: "resume.pdf", mimeType: PDF_MIME, sizeBytes: 6 * 1024 * 1024 },
    });
    expect(oversize.statusCode).toBe(413);

    const intentWithScore = await app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie },
      payload: {
        filename: "resume.pdf",
        mimeType: PDF_MIME,
        sizeBytes: samplePdfBytes().byteLength,
        officialScore: 100,
      },
    });
    expect(intentWithScore.statusCode).toBe(400);

    const scored = await upload(app, storage, cookie, "resume.pdf", PDF_MIME, samplePdfBytes(), {
      score: 99,
    });
    expect(scored.statusCode).toBe(400);

    const disguised = await upload(app, storage, cookie, "resume.pdf", PDF_MIME, sampleDocxBytes());
    expect(disguised.statusCode).toBe(415);

    // Corrupt PDF marks the version rejected; even if valid PDF bytes replace the object,
    // retrying complete-upload cannot flip a rejected version to verified.
    const corruptBytes = corruptPdfBytes();
    const validBytes = samplePdfBytes();
    const corruptIntent = await app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie },
      payload: { filename: "corrupt.pdf", mimeType: PDF_MIME, sizeBytes: corruptBytes.byteLength },
    });
    const corruptCreated = corruptIntent.json<{
      resumeId: string;
      versionId: string;
      upload: { url: string };
    }>();
    const corruptKey = corruptCreated.upload.url.replace("memory://upload/", "");
    await storage.put(corruptKey, corruptBytes);

    const corruptRes = await app.inject({
      method: "POST",
      url: `/api/v1/resumes/${corruptCreated.resumeId}/versions/${corruptCreated.versionId}/complete-upload`,
      headers: { origin: ORIGIN, cookie },
      payload: {},
    });
    expect(corruptRes.statusCode).toBe(422);

    await storage.put(corruptKey, validBytes);
    const retryAfterReject = await app.inject({
      method: "POST",
      url: `/api/v1/resumes/${corruptCreated.resumeId}/versions/${corruptCreated.versionId}/complete-upload`,
      headers: { origin: ORIGIN, cookie },
      payload: {},
    });
    expect(retryAfterReject.statusCode).toBe(422);

    const image = await upload(app, storage, cookie, "resume.pdf", PDF_MIME, emptyPdfBytes());
    expect(image.json()).toMatchObject({ error: { code: "NO_EXTRACTABLE_TEXT" } });

    const locked = await upload(app, storage, cookie, "resume.docx", DOCX_MIME, encryptedDocxBytes());
    expect(locked.json()).toMatchObject({ error: { code: "PASSWORD_PROTECTED" } });

    const encoder = new TextEncoder();
    const bomb = createDeflateZip([
      { name: "[Content_Types].xml", data: encoder.encode("<Types></Types>") },
      { name: "word/document.xml", data: new Uint8Array(80_000), declaredUncompressedSize: 20 },
    ]);
    const limited = await createTestApp({ docxUncompressedBytes: 1_000 });
    const { cookie: bombCookie } = await sessionFor(limited.app, "bomb@example.com");
    const exploded = await upload(
      limited.app,
      limited.storage,
      bombCookie,
      "resume.docx",
      DOCX_MIME,
      bomb,
    );
    expect(exploded.json()).toMatchObject({ error: { code: "ZIP_LIMIT_EXCEEDED" } });

    await app.close();
    await client.close();
    await limited.app.close();
    await limited.client.close();
  });

  it("leaves the upload pending when parse limits are unset or ParseGate is overloaded, allowing retry", async () => {
    const unset = await createTestApp({
      pdfPageCap: null,
      parseTimeoutMs: null,
      parseConcurrency: null,
    });
    const { cookie: unsetCookie } = await sessionFor(unset.app, "limits@example.com");
    const completedUnset = await upload(
      unset.app,
      unset.storage,
      unsetCookie,
      "resume.pdf",
      PDF_MIME,
      samplePdfBytes(),
    );
    expect(completedUnset.statusCode).toBe(503);
    expect(completedUnset.json()).toMatchObject({ error: { code: "PARSE_LIMITS_UNSET" } });
    const listedUnset = await unset.app.inject({
      method: "GET",
      url: "/api/v1/resumes",
      headers: { cookie: unsetCookie },
    });
    expect(listedUnset.json()).toMatchObject({
      resumes: [{ versions: [{ verificationState: "pending" }] }],
    });
    await unset.app.close();
    await unset.client.close();

    // ParseGate overload: occupy the single slot with maxQueue: 0 -> completeUpload returns 503 PARSE_OVERLOADED
    // and leaves verificationState = "pending" so retry succeeds after slot release.
    const tightGate = new ParseGate(1, { maxQueue: 0, maxWaitMs: 50 });
    const overloaded = await createTestApp({}, { parseGate: tightGate });
    const { cookie: busyCookie, userId } = await sessionFor(overloaded.app, "busy@example.com");
    const bytes = samplePdfBytes();
    const intent = await overloaded.app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie: busyCookie },
      payload: { filename: "Busy_Resume.pdf", mimeType: PDF_MIME, sizeBytes: bytes.byteLength },
    });
    const created = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
    await overloaded.storage.put(created.upload.url.replace("memory://upload/", ""), bytes);

    let releaseSlot!: () => void;
    const holdPromise = tightGate.run(
      () =>
        new Promise<void>((resolve) => {
          releaseSlot = resolve;
        }),
    );

    const busyRes = await overloaded.app.inject({
      method: "POST",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
      headers: { origin: ORIGIN, cookie: busyCookie },
      payload: {},
    });
    expect(busyRes.statusCode).toBe(503);
    expect(busyRes.headers["retry-after"]).toBe("5");
    expect(busyRes.json()).toMatchObject({ error: { code: "PARSE_OVERLOADED" } });

    releaseSlot();
    await holdPromise;

    // Also verify pre-cancelled signal leaves version pending
    const preCancelled = new AbortController();
    preCancelled.abort();
    await expect(
      completeUpload(
        {
          db: overloaded.db,
          storage: overloaded.storage,
          config: overloaded.config,
          parseGate: tightGate,
        },
        userId,
        created.resumeId,
        created.versionId,
        { signal: preCancelled.signal },
      ),
    ).rejects.toMatchObject({ statusCode: 499, code: "REQUEST_ABORTED" });

    // Retry now succeeds cleanly
    const retryOk = await overloaded.app.inject({
      method: "POST",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
      headers: { origin: ORIGIN, cookie: busyCookie },
      payload: {},
    });
    expect(retryOk.statusCode).toBe(200);
    expect(retryOk.json()).toMatchObject({ verificationState: "verified" });

    await overloaded.app.close();
    await overloaded.client.close();
  });

  it("leaves zero pending DB rows when signed URL generation fails, bounds active pending intents, and sweeps abandoned intents", async () => {
    const failingStorage: ObjectStorage = {
      async createUploadUrl() {
        throw new Error("R2 signing unavailable");
      },
      async createDownloadUrl() {
        throw new Error("R2 signing unavailable");
      },
      async get() {
        return null;
      },
      async delete() {
        return;
      },
    };

    const failing = await createTestApp({}, { storage: failingStorage });
    const { cookie: failCookie } = await sessionFor(failing.app, "signfail@example.com");
    const failedIntent = await failing.app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie: failCookie },
      payload: { filename: "Resume.pdf", mimeType: PDF_MIME, sizeBytes: 128 },
    });
    expect(failedIntent.statusCode).toBe(500);
    expect(await failing.pgliteDb.select().from(schema.resumes)).toHaveLength(0);
    expect(await failing.pgliteDb.select().from(schema.resumeVersions)).toHaveLength(0);
    await failing.app.close();
    await failing.client.close();

    // Per-user pending cap + abandoned intent sweep
    const bounded = await createTestApp({
      signedUrlTtlSeconds: 60,
      uploadIntentGraceSeconds: 10,
      maxPendingUploadsPerUser: 2,
    });
    const { userId } = await sessionFor(bounded.app, "abandoned@example.com");
    const uploadDeps = {
      db: bounded.db,
      storage: bounded.storage,
      config: bounded.config,
      parseGate: bounded.parseGate,
    };

    const t0 = new Date("2026-11-12T10:00:00.000Z");
    const intent1 = await createUploadIntent(
      uploadDeps,
      userId,
      { filename: "One.pdf", mimeType: PDF_MIME, sizeBytes: 100 },
      { now: t0 },
    );
    const key1 = intent1.upload.url.replace("memory://upload/", "");
    await bounded.storage.put(key1, new Uint8Array(100));

    await createUploadIntent(
      uploadDeps,
      userId,
      { filename: "Two.pdf", mimeType: PDF_MIME, sizeBytes: 100 },
      { now: t0 },
    );

    // 3rd concurrent pending intent within TTL window is rejected with 429
    await expect(
      createUploadIntent(
        uploadDeps,
        userId,
        { filename: "Three.pdf", mimeType: PDF_MIME, sizeBytes: 100 },
        { now: t0 },
      ),
    ).rejects.toMatchObject({ statusCode: 429, code: "TOO_MANY_PENDING_UPLOADS" });

    // Advance past signedUrlTtlSeconds (60s) + grace (10s) -> creating a new intent sweeps the 2 abandoned intents
    const tExpired = new Date(t0.getTime() + 75_000);
    const intentAfterExpiry = await createUploadIntent(
      uploadDeps,
      userId,
      { filename: "Fresh.pdf", mimeType: PDF_MIME, sizeBytes: 100 },
      { now: tExpired },
    );
    expect(intentAfterExpiry.resumeId).toBeDefined();
    expect(bounded.storage.has(key1)).toBe(false);

    // Only the 1 fresh resume + version exists in DB (abandoned rows were deleted)
    expect(await bounded.pgliteDb.select().from(schema.resumes)).toHaveLength(1);
    expect(await bounded.pgliteDb.select().from(schema.resumeVersions)).toHaveLength(1);

    // Expiring the fresh intent and calling cleanup removes it too
    const swept = await cleanupAbandonedUploadIntents(uploadDeps, {
      userId,
      now: new Date(tExpired.getTime() + 75_000),
    });
    expect(swept).toBe(1);
    expect(await bounded.pgliteDb.select().from(schema.resumes)).toHaveLength(0);
    expect(await bounded.pgliteDb.select().from(schema.resumeVersions)).toHaveLength(0);

    await bounded.app.close();
    await bounded.client.close();
  });

  it("paginates resume listings and fetches individual resumes with a direct ownership-scoped query", async () => {
    const { app, client, storage } = await createTestApp({ maxPendingUploadsPerUser: 20 });
    const { cookie } = await sessionFor(app, "pager@example.com");
    const bytes = samplePdfBytes();

    const createdIds: string[] = [];
    for (const name of ["First.pdf", "Second.pdf", "Third.pdf"]) {
      const intent = await app.inject({
        method: "POST",
        url: "/api/v1/resumes/upload-intents",
        headers: { origin: ORIGIN, cookie },
        payload: { filename: name, mimeType: PDF_MIME, sizeBytes: bytes.byteLength },
      });
      expect(intent.statusCode).toBe(201);
      const body = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
      await storage.put(body.upload.url.replace("memory://upload/", ""), bytes);
      const complete = await app.inject({
        method: "POST",
        url: `/api/v1/resumes/${body.resumeId}/versions/${body.versionId}/complete-upload`,
        headers: { origin: ORIGIN, cookie },
        payload: {},
      });
      expect(complete.statusCode).toBe(200);
      createdIds.push(body.resumeId);
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/resumes?limit=2&offset=0",
      headers: { cookie },
    });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json<{
      resumes: { id: string; versions: unknown[] }[];
      pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
    }>();
    expect(page1Body.resumes).toHaveLength(2);
    expect(page1Body.resumes[0]?.versions).toHaveLength(1);
    expect(page1Body.pagination).toEqual({
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });

    const page2 = await app.inject({
      method: "GET",
      url: "/api/v1/resumes?limit=2&offset=2",
      headers: { cookie },
    });
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json<{
      resumes: { id: string }[];
      pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
    }>();
    expect(page2Body.resumes).toHaveLength(1);
    expect(page2Body.pagination).toEqual({
      limit: 2,
      offset: 2,
      hasMore: false,
      nextOffset: null,
    });

    const invalidPage = await app.inject({
      method: "GET",
      url: "/api/v1/resumes?limit=0",
      headers: { cookie },
    });
    expect(invalidPage.statusCode).toBe(400);

    // Direct getResume() returns the exact requested resume even if it's beyond page 1
    const oldestId = createdIds[0]!;
    const single = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${oldestId}`,
      headers: { cookie },
    });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toMatchObject({
      resume: { id: oldestId, title: "First.pdf" },
    });

    await app.close();
    await client.close();
  });
});

async function upload(
  app: Awaited<ReturnType<typeof buildApp>>,
  storage: MemoryStorage,
  cookie: string,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
  extra: Record<string, unknown> = {},
) {
  const intent = await app.inject({
    method: "POST",
    url: "/api/v1/resumes/upload-intents",
    headers: { origin: ORIGIN, cookie },
    payload: { filename, mimeType, sizeBytes: bytes.byteLength },
  });
  expect(intent.statusCode).toBe(201);
  const created = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
  await storage.put(created.upload.url.replace("memory://upload/", ""), bytes);
  return app.inject({
    method: "POST",
    url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
    headers: { origin: ORIGIN, cookie },
    payload: extra,
  });
}
