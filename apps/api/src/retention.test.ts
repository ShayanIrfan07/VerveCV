import { PGlite } from "@electric-sql/pglite";
import { PDF_MIME, samplePdfBytes } from "@vervecv/documents";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { Database } from "./infrastructure/db/client.js";
import * as schema from "./infrastructure/db/schema.js";
import { MemoryStorage, type ObjectStorage } from "./infrastructure/storage/memory.js";
import {
  computeRetentionBackoffMs,
  getRetentionBacklogSummary,
  PURGED_OBJECT_KEY_PREFIX,
  requeueFailedRetentionTasks,
  runRetentionPass,
  startRetentionScheduler,
  type PermanentRetentionFailure,
  type RetentionLogger,
} from "./modules/retention/worker.js";
import { parseRequeueCliArgs } from "./modules/retention/requeue-cli.js";
import { attachRetentionRuntime } from "./retention-runtime.js";
import { ParseGate } from "./modules/uploads/parse-gate.js";
import { deleteResume } from "./modules/uploads/service.js";

const ORIGIN = "http://localhost:5173";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createRetentionTestApp(
  overrides: Partial<AppConfig> = {},
  options: { storage?: ObjectStorage } = {},
) {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder: path.resolve("database/migrations") });
  const memoryStorage = new MemoryStorage();
  const storage = options.storage ?? memoryStorage;
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
    sessionTtlSeconds: 3600,
    signedUrlTtlSeconds: 300,
    pdfPageCap: 5,
    docxEntryCap: 20,
    docxUncompressedBytes: 1_000_000,
    parseTimeoutMs: 10_000,
    parseConcurrency: 4,
    parseMaxQueue: 16,
    parseQueueTimeoutMs: 5_000,
    maxPendingUploadsPerUser: 20,
    ...overrides,
  };
  const parseGate = new ParseGate(config.parseConcurrency ?? 1, {
    maxQueue: config.parseMaxQueue,
    maxWaitMs: config.parseQueueTimeoutMs,
  });
  const db = pgliteDb as unknown as Database;
  const app = await buildApp({ config, db, storage, parseGate });
  return { app, client, db, pgliteDb, memoryStorage, storage, config };
}

async function registerAndSignIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string,
  displayName = "Ada Lovelace",
): Promise<{ cookie: string; userId: string }> {
  const reg = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin: ORIGIN },
    payload: { email, password: "correct-horse", displayName },
  });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json<{ user: { id: string } }>().user.id;

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: ORIGIN },
    payload: { email, password: "correct-horse" },
  });
  expect(login.statusCode).toBe(200);
  const sessionCookie = login.cookies.find((c) => c.name === "vervecv_session");
  return { cookie: `vervecv_session=${sessionCookie?.value ?? ""}`, userId };
}

async function uploadAndVerifyPdf(
  app: Awaited<ReturnType<typeof buildApp>>,
  memoryStorage: MemoryStorage,
  cookie: string,
  filename = "AdaLovelace_Resume.pdf",
) {
  const bytes = samplePdfBytes();
  const intent = await app.inject({
    method: "POST",
    url: "/api/v1/resumes/upload-intents",
    headers: { origin: ORIGIN, cookie },
    payload: { filename, mimeType: PDF_MIME, sizeBytes: bytes.byteLength },
  });
  expect(intent.statusCode).toBe(201);
  const body = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
  const objectKey = body.upload.url.replace("memory://upload/", "");
  await memoryStorage.put(objectKey, bytes);

  const complete = await app.inject({
    method: "POST",
    url: `/api/v1/resumes/${body.resumeId}/versions/${body.versionId}/complete-upload`,
    headers: { origin: ORIGIN, cookie },
    payload: {},
  });
  expect(complete.statusCode).toBe(200);
  return { ...body, objectKey, bytes };
}

describe("retention worker leases, concurrency, crash recovery, backoff, and privacy guarantees", () => {
  it("computes bounded exponential backoff with jitter and never exceeds maxBackoffMs", () => {
    // Attempt 1 with base 1000ms -> cap 1000ms -> range [500, 1000]
    expect(
      computeRetentionBackoffMs(1, { baseBackoffMs: 1_000, maxBackoffMs: 10_000, random: () => 0 }),
    ).toBe(500);
    expect(
      computeRetentionBackoffMs(1, {
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        random: () => 0.999999,
      }),
    ).toBe(1_000);

    // Attempt 3 with base 1000ms -> cap 4000ms -> range [2000, 4000]
    expect(
      computeRetentionBackoffMs(3, { baseBackoffMs: 1_000, maxBackoffMs: 10_000, random: () => 0 }),
    ).toBe(2_000);
    expect(
      computeRetentionBackoffMs(3, {
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        random: () => 0.999999,
      }),
    ).toBe(4_000);

    // Attempt 20 capped strictly at maxBackoffMs (10_000ms -> range [5000, 10000])
    for (let sample = 0; sample <= 1; sample += 0.1) {
      const value = computeRetentionBackoffMs(20, {
        baseBackoffMs: 1_000,
        maxBackoffMs: 10_000,
        random: () => sample,
      });
      expect(value).toBeGreaterThanOrEqual(5_000);
      expect(value).toBeLessThanOrEqual(10_000);
    }
  });

  it("prevents two workers from claiming or concurrently processing the same retention task", async () => {
    const { app, client, db, pgliteDb, memoryStorage } = await createRetentionTestApp();
    const { cookie, userId } = await registerAndSignIn(app, "race@example.com");
    const uploaded = await uploadAndVerifyPdf(app, memoryStorage, cookie);

    await deleteResume(db, userId, uploaded.resumeId);

    const enteredDelete = deferred();
    const finishDelete = deferred();
    let deleteCallCount = 0;

    const gatedStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: async (key) => {
        deleteCallCount += 1;
        enteredDelete.resolve();
        await finishDelete.promise;
        await memoryStorage.delete(key);
      },
    };

    const t0 = new Date("2026-11-16T12:00:00.000Z");
    const workerAPromise = runRetentionPass(
      { db, storage: gatedStorage },
      { now: t0, workerId: "worker-a", leaseMs: 60_000 },
    );

    // Wait until Worker A has claimed the lease in DB and is actively paused inside storage.delete()
    await enteredDelete.promise;

    const leasedRow = (await pgliteDb.select().from(schema.retentionTasks))[0];
    expect(leasedRow?.state).toBe("running");
    expect(leasedRow?.leaseOwner).toBe("worker-a");
    expect(leasedRow?.leaseUntil?.toISOString()).toBe("2026-11-16T12:01:00.000Z");

    // Worker B attempts to run while Worker A's lease is active (t0 + 20s < t0 + 60s):
    // Worker B MUST NOT steal or execute the task!
    const workerBResult = await runRetentionPass(
      { db, storage: gatedStorage },
      { now: new Date(t0.getTime() + 20_000), workerId: "worker-b", leaseMs: 60_000 },
    );
    expect(workerBResult.processed).toBe(0);
    expect(deleteCallCount).toBe(1);

    // Allow Worker A to complete
    finishDelete.resolve();
    const workerAResult = await workerAPromise;
    expect(workerAResult).toMatchObject({
      workerId: "worker-a",
      processed: 1,
      succeeded: 1,
    });
    expect(deleteCallCount).toBe(1);
    expect(memoryStorage.has(uploaded.objectKey)).toBe(false);

    // Also test simultaneous Promise.all starts on a second task
    const secondUploaded = await uploadAndVerifyPdf(app, memoryStorage, cookie, "Second.pdf");
    await deleteResume(db, userId, secondUploaded.resumeId);
    let secondDeleteCalls = 0;
    const countingStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: async (key) => {
        secondDeleteCalls += 1;
        await memoryStorage.delete(key);
      },
    };

    const [sim1, sim2] = await Promise.all([
      runRetentionPass({ db, storage: countingStorage }, { now: t0, workerId: "sim-1" }),
      runRetentionPass({ db, storage: countingStorage }, { now: t0, workerId: "sim-2" }),
    ]);
    expect(sim1.succeeded + sim2.succeeded).toBe(1);
    expect(secondDeleteCalls).toBe(1);

    await app.close();
    await client.close();
  });

  it("recovers automatically after a worker crash or stall once the lease expires, and fences stale workers", async () => {
    const { app, client, db, pgliteDb, memoryStorage } = await createRetentionTestApp();
    const { cookie, userId } = await registerAndSignIn(app, "crash@example.com");
    const uploaded = await uploadAndVerifyPdf(app, memoryStorage, cookie);
    await deleteResume(db, userId, uploaded.resumeId);

    const t0 = new Date("2026-11-16T13:00:00.000Z");

    // Simulate a worker that claimed the lease at t0 (leaseUntil = t0 + 60s) and then crashed
    // hard (SIGKILL / OOM) mid-storage-delete before updating retention_tasks:
    const enteredStall = deferred();
    const releaseZombie = deferred();
    let zombieStallOnce = true;

    const stallingStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: async (key) => {
        if (zombieStallOnce) {
          zombieStallOnce = false;
          enteredStall.resolve();
          await releaseZombie.promise;
        }
        await memoryStorage.delete(key);
      },
    };

    const zombieWorkerPromise = runRetentionPass(
      { db, storage: stallingStorage },
      { now: t0, workerId: "crashed-worker-1", leaseMs: 60_000 },
    );
    await enteredStall.promise;

    // 1. Before lease expires (t0 + 45s): healthy Worker 2 respects the active lease
    const beforeExpiry = await runRetentionPass(
      { db, storage: memoryStorage },
      { now: new Date(t0.getTime() + 45_000), workerId: "healthy-worker-2", leaseMs: 60_000 },
    );
    expect(beforeExpiry.processed).toBe(0);
    expect(memoryStorage.has(uploaded.objectKey)).toBe(true);

    // 2. After lease expires (t0 + 61s, NO application restart required!):
    // healthy Worker 2 automatically reclaims the expired running task and purges everything
    const afterExpiry = await runRetentionPass(
      { db, storage: memoryStorage },
      { now: new Date(t0.getTime() + 61_000), workerId: "healthy-worker-2", leaseMs: 60_000 },
    );
    expect(afterExpiry).toMatchObject({
      workerId: "healthy-worker-2",
      processed: 1,
      succeeded: 1,
    });
    expect(memoryStorage.has(uploaded.objectKey)).toBe(false);

    // 3. Now let the stalled zombie Worker 1 wake up late: fencing prevents it from
    // overwriting Worker 2's completed state or emitting a second resume_version_purged audit!
    releaseZombie.resolve();
    const zombieResult = await zombieWorkerPromise;
    expect(zombieResult.succeeded).toBe(0);

    const finalTask = (await pgliteDb.select().from(schema.retentionTasks))[0];
    expect(finalTask).toMatchObject({
      state: "succeeded",
      attempts: 2,
      leaseOwner: null,
      leaseUntil: null,
    });

    const purgeAudits = await pgliteDb
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, "resume_version_purged"));
    expect(purgeAudits).toHaveLength(1);

    await app.close();
    await client.close();
  });

  it("applies exponential backoff on R2 failures, succeeds on transient recovery, and dead-letters + alerts on permanent failure", async () => {
    const { app, client, db, pgliteDb, memoryStorage } = await createRetentionTestApp();
    const { cookie, userId } = await registerAndSignIn(app, "backoff@example.com");

    // Resume 1: transient failure twice, then succeeds on 3rd attempt
    const transientUpload = await uploadAndVerifyPdf(app, memoryStorage, cookie, "Transient.pdf");
    await deleteResume(db, userId, transientUpload.resumeId);

    let failStorage = true;
    const flakyStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: async (key) => {
        if (failStorage) {
          throw new Error("R2 503 SlowDown");
        }
        await memoryStorage.delete(key);
      },
    };

    const warnLogs: Array<Record<string, unknown>> = [];
    const errorLogs: Array<Record<string, unknown>> = [];
    const logger: RetentionLogger = {
      warn: (bindings) => warnLogs.push(bindings),
      error: (bindings) => errorLogs.push(bindings),
    };

    const t0 = new Date("2026-11-16T14:00:00.000Z");
    // Attempt 1 fails -> backoff with base=2000ms, random=0.999 -> nextAttemptAt = t0 + 2000ms
    const pass1 = await runRetentionPass(
      { db, storage: flakyStorage, logger },
      { now: t0, baseBackoffMs: 2_000, maxBackoffMs: 30_000, maxAttempts: 3, random: () => 0.999999 },
    );
    expect(pass1).toMatchObject({ processed: 1, retried: 1, permanentlyFailed: 0 });
    expect(warnLogs).toHaveLength(1);

    // Polling too early (t0 + 1000ms < t0 + 2000ms) skips the task
    const prematurePass = await runRetentionPass(
      { db, storage: flakyStorage, logger },
      { now: new Date(t0.getTime() + 1_000), baseBackoffMs: 2_000, maxBackoffMs: 30_000, maxAttempts: 3 },
    );
    expect(prematurePass.processed).toBe(0);

    // Attempt 2 at t0 + 2000ms fails -> backoff grows to 4000ms (t0 + 6000ms)
    const pass2 = await runRetentionPass(
      { db, storage: flakyStorage, logger },
      {
        now: new Date(t0.getTime() + 2_000),
        baseBackoffMs: 2_000,
        maxBackoffMs: 30_000,
        maxAttempts: 3,
        random: () => 0.999999,
      },
    );
    expect(pass2).toMatchObject({ processed: 1, retried: 1, permanentlyFailed: 0 });

    const taskAfter2 = (
      await pgliteDb
        .select()
        .from(schema.retentionTasks)
        .where(eq(schema.retentionTasks.resumeVersionId, transientUpload.versionId))
    )[0];
    expect(taskAfter2?.attempts).toBe(2);
    expect(taskAfter2?.nextAttemptAt.getTime()).toBe(t0.getTime() + 6_000);

    // Attempt 3 at t0 + 6000ms with R2 recovered -> succeeds!
    failStorage = false;
    const pass3 = await runRetentionPass(
      { db, storage: flakyStorage, logger },
      {
        now: new Date(t0.getTime() + 6_000),
        baseBackoffMs: 2_000,
        maxBackoffMs: 30_000,
        maxAttempts: 3,
      },
    );
    expect(pass3).toMatchObject({ processed: 1, succeeded: 1, permanentlyFailed: 0 });
    expect(memoryStorage.has(transientUpload.objectKey)).toBe(false);

    // Resume 2: permanent R2 failure across all 3 maxAttempts -> transitions to "failed" + alerts
    const permUpload = await uploadAndVerifyPdf(app, memoryStorage, cookie, "PermanentFail.pdf");
    await deleteResume(db, userId, permUpload.resumeId);
    failStorage = true;
    const permanentAlerts: PermanentRetentionFailure[] = [];

    let cursor = new Date("2026-11-16T15:00:00.000Z");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runRetentionPass(
        { db, storage: flakyStorage, logger },
        {
          now: cursor,
          baseBackoffMs: 1_000,
          maxBackoffMs: 10_000,
          maxAttempts: 3,
          random: () => 0.5,
          onPermanentFailure: (failure) => permanentAlerts.push(failure),
        },
      );
      cursor = new Date(cursor.getTime() + 20_000);
    }

    expect(permanentAlerts).toHaveLength(1);
    expect(permanentAlerts[0]).toMatchObject({
      resumeVersionId: permUpload.versionId,
      attempts: 3,
      maxAttempts: 3,
      errorCode: "STORAGE_DELETE_FAILED",
    });
    expect(errorLogs.some((entry) => entry["event"] === "retention.permanent_failure")).toBe(true);

    const backlog = await getRetentionBacklogSummary(db);
    expect(backlog.permanentlyFailed).toBe(1);

    // Further passes do NOT endlessly retry a permanently failed task
    const afterDeadLetter = await runRetentionPass(
      { db, storage: flakyStorage, logger },
      { now: new Date(cursor.getTime() + 60_000), maxAttempts: 3 },
    );
    expect(afterDeadLetter.processed).toBe(0);

    const failAudits = await pgliteDb
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, "retention_task_failed"));
    expect(failAudits).toHaveLength(1);
    expect(JSON.stringify(failAudits[0]?.safeMetadata)).not.toContain("PermanentFail");

    await app.close();
    await client.close();
  });

  it("enforces 90-day expiration, deletes derived evaluations/findings/jobs, scrubs all filenames/PII, and handles idempotent repeated deletion", async () => {
    const { app, client, db, pgliteDb, memoryStorage } = await createRetentionTestApp();
    const { cookie } = await registerAndSignIn(app, "privacy@example.com", "Ada Lovelace");

    // 1. User-deleted resume with evaluation + findings + sensitive filename
    const deletedTarget = await uploadAndVerifyPdf(
      app,
      memoryStorage,
      cookie,
      "Ada_Lovelace_Confidential_2026.pdf",
    );
    const evalRes = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie },
      payload: {
        resumeVersionId: deletedTarget.versionId,
        candidateType: "FRESHER",
        jobDescription: "Confidential role description",
        idempotencyKey: "privacy-eval-1",
      },
    });
    expect(evalRes.statusCode).toBe(200);
    const evalId = evalRes.json<{ evaluation: { id: string } }>().evaluation.id;

    // Confirm findings & evaluation exist prior to deletion
    expect(
      (await pgliteDb.select().from(schema.evaluations).where(eq(schema.evaluations.id, evalId)))
        .length,
    ).toBe(1);
    expect(
      (
        await pgliteDb
          .select()
          .from(schema.findings)
          .where(eq(schema.findings.evaluationId, evalId))
      ).length,
    ).toBeGreaterThan(0);

    // First DELETE -> 204, purges R2 object + evaluations + findings + evaluation_jobs + scrubs filenames
    const del1 = await app.inject({
      method: "DELETE",
      url: `/api/v1/resumes/${deletedTarget.resumeId}`,
      headers: { origin: ORIGIN, cookie },
    });
    expect(del1.statusCode).toBe(204);

    // Idempotent repeated DELETEs (sequential + concurrent) by owner -> 204 without errors or duplicate tasks/audits
    const [del2, del3] = await Promise.all([
      app.inject({
        method: "DELETE",
        url: `/api/v1/resumes/${deletedTarget.resumeId}`,
        headers: { origin: ORIGIN, cookie },
      }),
      app.inject({
        method: "DELETE",
        url: `/api/v1/resumes/${deletedTarget.resumeId}`,
        headers: { origin: ORIGIN, cookie },
      }),
    ]);
    expect(del2.statusCode).toBe(204);
    expect(del3.statusCode).toBe(204);

    // Cross-user DELETE still returns 404
    const { cookie: otherCookie } = await registerAndSignIn(app, "stranger@example.com");
    const strangerDel = await app.inject({
      method: "DELETE",
      url: `/api/v1/resumes/${deletedTarget.resumeId}`,
      headers: { origin: ORIGIN, cookie: otherCookie },
    });
    expect(strangerDel.statusCode).toBe(404);

    // Repeated retention pass is also a safe idempotent no-op
    const extraPass = await runRetentionPass({ db, storage: memoryStorage });
    expect(extraPass.processed).toBe(0);

    // Verify physical removal of R2 bytes + evaluations + findings + evaluation_jobs
    expect(memoryStorage.has(deletedTarget.objectKey)).toBe(false);
    expect(
      await pgliteDb
        .select()
        .from(schema.evaluations)
        .where(eq(schema.evaluations.resumeVersionId, deletedTarget.versionId)),
    ).toHaveLength(0);
    expect(
      await pgliteDb
        .select()
        .from(schema.findings)
        .where(eq(schema.findings.evaluationId, evalId)),
    ).toHaveLength(0);
    expect(
      await pgliteDb
        .select()
        .from(schema.evaluationJobs)
        .where(eq(schema.evaluationJobs.resumeVersionId, deletedTarget.versionId)),
    ).toHaveLength(0);

    // Verify NO original filenames, SHA-256 hashes, or personal resume metadata remain in DB tables or audit logs
    const resumeRow = (
      await pgliteDb
        .select()
        .from(schema.resumes)
        .where(eq(schema.resumes.id, deletedTarget.resumeId))
    )[0];
    expect(resumeRow?.title).toBe("deleted");
    expect(resumeRow?.candidateType).toBeNull();
    expect(resumeRow?.deletedAt).not.toBeNull();

    const versionRow = (
      await pgliteDb
        .select()
        .from(schema.resumeVersions)
        .where(eq(schema.resumeVersions.id, deletedTarget.versionId))
    )[0];
    expect(versionRow?.deletionState).toBe("deleted");
    expect(versionRow?.originalFilename).toBe("deleted");
    expect(versionRow?.objectKey).toBe(`${PURGED_OBJECT_KEY_PREFIX}${deletedTarget.versionId}`);
    expect(versionRow?.sha256).toBe("deleted");
    expect(versionRow?.sizeBytes).toBe(0);
    expect(versionRow?.parserVersion).toBeNull();

    const allAuditsJson = JSON.stringify(await pgliteDb.select().from(schema.auditEvents));
    expect(allAuditsJson).not.toContain("Ada_Lovelace_Confidential_2026");
    expect(allAuditsJson).not.toContain("Confidential role description");

    // 2. 90-day automatic expiration test
    const expiringUpload = await uploadAndVerifyPdf(
      app,
      memoryStorage,
      cookie,
      "NinetyDay_Secret_Resume.pdf",
    );
    const activeUpload = await uploadAndVerifyPdf(
      app,
      memoryStorage,
      cookie,
      "StillFresh_Resume.pdf",
    );

    const evalExpiring = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie },
      payload: {
        resumeVersionId: expiringUpload.versionId,
        candidateType: "EXPERIENCED",
        jobDescription: null,
        idempotencyKey: "ninety-day-eval-1",
      },
    });
    expect(evalExpiring.statusCode).toBe(200);

    const uploadedVersion = (
      await pgliteDb
        .select()
        .from(schema.resumeVersions)
        .where(eq(schema.resumeVersions.id, expiringUpload.versionId))
    )[0]!;
    const ageDays =
      (uploadedVersion.expiresAt.getTime() - uploadedVersion.createdAt.getTime()) /
      (24 * 60 * 60 * 1000);
    expect(Math.round(ageDays)).toBe(90);

    // Run retention pass 90 days + 1 minute in the future for expiringUpload, while keeping activeUpload fresh
    await pgliteDb
      .update(schema.resumeVersions)
      .set({ expiresAt: new Date("2027-06-01T00:00:00.000Z") })
      .where(eq(schema.resumeVersions.id, activeUpload.versionId));

    const futureAfter90Days = new Date(uploadedVersion.expiresAt.getTime() + 60_000);
    const expiryPass = await runRetentionPass(
      { db, storage: memoryStorage },
      { now: futureAfter90Days },
    );
    expect(expiryPass).toMatchObject({
      expiredEnqueued: 1,
      processed: 1,
      succeeded: 1,
    });

    expect(memoryStorage.has(expiringUpload.objectKey)).toBe(false);
    expect(memoryStorage.has(activeUpload.objectKey)).toBe(true);

    const expiredResumeRow = (
      await pgliteDb
        .select()
        .from(schema.resumes)
        .where(eq(schema.resumes.id, expiringUpload.resumeId))
    )[0];
    expect(expiredResumeRow?.title).toBe("deleted");

    const expiredVersionRow = (
      await pgliteDb
        .select()
        .from(schema.resumeVersions)
        .where(eq(schema.resumeVersions.id, expiringUpload.versionId))
    )[0];
    expect(expiredVersionRow?.originalFilename).toBe("deleted");
    expect(expiredVersionRow?.objectKey).toBe(
      `${PURGED_OBJECT_KEY_PREFIX}${expiringUpload.versionId}`,
    );
    expect(expiredVersionRow?.deletionState).toBe("deleted");

    await app.close();
    await client.close();
  });

  it("handles R2 deletions lasting longer than RETENTION_LEASE_MS via lease renewal, bounded delete timeout, and attempt-fenced ownership changes", async () => {
    const { app, client, db, pgliteDb, memoryStorage } = await createRetentionTestApp();
    const { cookie, userId } = await registerAndSignIn(app, "longlease@example.com");

    // Case A: R2 delete takes ~110ms while leaseMs is only 40ms, with heartbeat renewal every 12ms.
    // Lease renewal keeps lease_until in the future so a second worker polling at +60ms cannot steal the task.
    const slowUpload = await uploadAndVerifyPdf(app, memoryStorage, cookie, "SlowButHealthy.pdf");
    await deleteResume(db, userId, slowUpload.resumeId);

    let worker2CheckedWhileInFlight = false;
    const slowStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        // Past the initial 40ms lease! Run Worker 2 right now -> must see renewed lease and process 0 tasks.
        const worker2 = await runRetentionPass(
          { db, storage: memoryStorage },
          { workerId: "worker-2-check", leaseMs: 40 },
        );
        expect(worker2.processed).toBe(0);
        worker2CheckedWhileInFlight = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await memoryStorage.delete(key);
      },
    };

    const renewedResult = await runRetentionPass(
      { db, storage: slowStorage },
      {
        workerId: "worker-1-renewing",
        leaseMs: 40,
        leaseRenewIntervalMs: 12,
        storageDeleteTimeoutMs: 500,
      },
    );
    expect(worker2CheckedWhileInFlight).toBe(true);
    expect(renewedResult).toMatchObject({ processed: 1, succeeded: 1 });
    expect(memoryStorage.has(slowUpload.objectKey)).toBe(false);

    // Case B: Hung R2 delete exceeds storageDeleteTimeoutMs -> aborts via AbortSignal before lease expiry
    // and schedules retry with STORAGE_DELETE_TIMEOUT.
    const hungUpload = await uploadAndVerifyPdf(app, memoryStorage, cookie, "HungDelete.pdf");
    await deleteResume(db, userId, hungUpload.resumeId);

    let observedAbortSignal = false;
    const hungStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: (_key, options) =>
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              observedAbortSignal = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    };

    const timeoutResult = await runRetentionPass(
      { db, storage: hungStorage },
      {
        workerId: "worker-timeout",
        leaseMs: 200,
        storageDeleteTimeoutMs: 30,
        leaseRenewIntervalMs: null,
        baseBackoffMs: 100,
        maxBackoffMs: 1_000,
      },
    );
    expect(observedAbortSignal).toBe(true);
    expect(timeoutResult).toMatchObject({ processed: 1, retried: 1 });
    const timedOutRow = (
      await pgliteDb
        .select()
        .from(schema.retentionTasks)
        .where(eq(schema.retentionTasks.resumeVersionId, hungUpload.versionId))
    )[0];
    expect(timedOutRow?.state).toBe("retryable_failure");
    expect(timedOutRow?.lastErrorCode).toBe("STORAGE_DELETE_TIMEOUT");

    // Clean up hungUpload so subsequent test cases start with an empty queue
    await runRetentionPass(
      { db, storage: memoryStorage },
      { now: new Date(Date.now() + 10_000) },
    );

    // Case C: Stale worker loses lease (e.g. event-loop freeze disables renewal), SAME or DIFFERENT
    // workerId reclaims at attempt 2, and stale attempt 1 completes late -> fenced by (leaseOwner, attempts)!
    const fencedUpload = await uploadAndVerifyPdf(app, memoryStorage, cookie, "SameWorkerFence.pdf");
    await deleteResume(db, userId, fencedUpload.resumeId);

    const enteredAttempt1 = deferred();
    const releaseAttempt1 = deferred();
    let callNum = 0;

    const pauseFirstAttemptStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: async (key) => {
        callNum += 1;
        if (callNum === 1) {
          enteredAttempt1.resolve();
          await releaseAttempt1.promise;
          throw new Error("late error from attempt 1");
        }
        // Attempt 2 also temporarily fails so the task stays in retryable_failure (or running)
        // when attempt 1 wakes up, testing the exact attempt-number fence!
        if (callNum === 2) {
          enteredAttempt2.resolve();
          await releaseAttempt2.promise;
          await memoryStorage.delete(key);
        }
      },
    };

    const enteredAttempt2 = deferred();
    const releaseAttempt2 = deferred();

    const tStart = new Date("2026-11-16T16:00:00.000Z");
    // Attempt 1 claimed by "shared-worker-id" with renewal disabled (simulating frozen process)
    const attempt1Promise = runRetentionPass(
      { db, storage: pauseFirstAttemptStorage },
      {
        now: tStart,
        workerId: "shared-worker-id",
        leaseMs: 50,
        leaseRenewIntervalMs: null,
        storageDeleteTimeoutMs: 5_000,
      },
    );
    await enteredAttempt1.promise;

    // Lease expires (tStart + 60ms) and a restarted instance WITH THE SAME workerId ("shared-worker-id")
    // reclaims the task at attempt = 2!
    const attempt2Promise = runRetentionPass(
      { db, storage: pauseFirstAttemptStorage },
      {
        now: new Date(tStart.getTime() + 60),
        workerId: "shared-worker-id",
        leaseMs: 60_000,
        leaseRenewIntervalMs: null,
        storageDeleteTimeoutMs: 5_000,
      },
    );
    await enteredAttempt2.promise;

    // Stale attempt 1 finishes with an error while attempt 2 is actively running under the SAME workerId:
    // Because of `attempts` fencing, attempt 1 MUST NOT clobber attempt 2's running state!
    releaseAttempt1.resolve();
    const attempt1Result = await attempt1Promise;
    expect(attempt1Result.retried).toBe(0);
    expect(attempt1Result.succeeded).toBe(0);

    const activeAttempt2Row = (
      await pgliteDb
        .select()
        .from(schema.retentionTasks)
        .where(eq(schema.retentionTasks.resumeVersionId, fencedUpload.versionId))
    )[0];
    expect(activeAttempt2Row?.state).toBe("running");
    expect(activeAttempt2Row?.attempts).toBe(2);

    // Let attempt 2 finish cleanly
    releaseAttempt2.resolve();
    const attempt2Result = await attempt2Promise;
    expect(attempt2Result.succeeded).toBe(1);
    expect(memoryStorage.has(fencedUpload.objectKey)).toBe(false);

    await app.close();
    await client.close();
  });

  it("supports safe operator requeue and dead-letter alerting for permanently failed tasks, and starts the 5-minute production scheduler via attachRetentionRuntime", async () => {
    const { app, client, db, pgliteDb, memoryStorage } = await createRetentionTestApp();
    const { cookie, userId } = await registerAndSignIn(app, "requeue@example.com");
    const uploaded = await uploadAndVerifyPdf(app, memoryStorage, cookie, "DeadLetter.pdf");
    await deleteResume(db, userId, uploaded.resumeId);

    const errorLogs: Array<Record<string, unknown>> = [];
    const infoLogs: Array<Record<string, unknown>> = [];
    const logger: RetentionLogger = {
      info: (bindings) => infoLogs.push(bindings),
      warn: () => undefined,
      error: (bindings) => errorLogs.push(bindings),
    };

    const brokenStorage: ObjectStorage = {
      createUploadUrl: (input) => memoryStorage.createUploadUrl(input),
      createDownloadUrl: (input) => memoryStorage.createDownloadUrl(input),
      get: (key, opts) => memoryStorage.get(key, opts),
      delete: async () => {
        throw new Error("R2 AccessDenied");
      },
    };

    // Exhaust maxAttempts = 2 -> task enters terminal "failed" state
    const t0 = new Date("2026-11-16T18:00:00.000Z");
    await runRetentionPass(
      { db, storage: brokenStorage, logger },
      { now: t0, baseBackoffMs: 100, maxBackoffMs: 1_000, maxAttempts: 2 },
    );
    await runRetentionPass(
      { db, storage: brokenStorage, logger },
      { now: new Date(t0.getTime() + 2_000), baseBackoffMs: 100, maxBackoffMs: 1_000, maxAttempts: 2 },
    );

    const beforeRequeue = await getRetentionBacklogSummary(db);
    expect(beforeRequeue.permanentlyFailed).toBe(1);
    expect(errorLogs.some((e) => e["event"] === "retention.permanent_failure")).toBe(true);

    // Verify attachRetentionRuntime on a fresh unstarted Fastify instance in production config starts
    // the 5-minute (300_000ms) scheduler and emits `retention.dead_letter_backlog` alerting!
    const prodConfig: AppConfig = {
      ...loadConfig({
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
        ALLOWED_ORIGINS: ORIGIN,
      }),
      cookieSecret: "test-cookie-secret-with-32-chars",
    };
    expect(prodConfig.retentionPollMs).toBe(300_000);

    const prodApp = await buildApp({ config: prodConfig, db, storage: memoryStorage });
    const attached = await attachRetentionRuntime(prodApp, {
      config: prodConfig,
      db,
      storage: memoryStorage,
      logger,
    });
    expect(attached.mode).toBe("scheduled");
    expect(attached.scheduler?.pollMs).toBe(300_000);

    // Wait briefly for the immediate startup tick of attachRetentionRuntime to log the dead-letter alert
    const alertDeadline = Date.now() + 2_000;
    while (
      !errorLogs.some((e) => e["event"] === "retention.dead_letter_backlog") &&
      Date.now() < alertDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(errorLogs.some((e) => e["event"] === "retention.dead_letter_backlog")).toBe(true);

    // CLI argument parser validation
    const failedTask = (await pgliteDb.select().from(schema.retentionTasks))[0]!;
    expect(parseRequeueCliArgs(["--task-id", failedTask.id, "--limit", "10", "--no-run"])).toEqual({
      taskIds: [failedTask.id],
      limit: 10,
      runPassNow: false,
    });
    expect(() => parseRequeueCliArgs(["--task-id", "not-a-uuid"])).toThrow(/UUID/);

    // Operator runs requeueFailedRetentionTasks after fixing R2 credentials -> resets attempts to 0 and state to pending
    const requeued = await requeueFailedRetentionTasks(db, {
      taskIds: [failedTask.id],
      now: new Date(t0.getTime() + 5_000),
      logger,
    });
    expect(requeued).toEqual({
      requeuedCount: 1,
      taskIds: [failedTask.id],
    });
    expect(infoLogs.some((e) => e["event"] === "retention.tasks_requeued")).toBe(true);

    const requeueAudit = await pgliteDb
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.eventType, "retention_task_requeued"));
    expect(requeueAudit).toHaveLength(1);
    expect(requeueAudit[0]?.safeMetadata).toEqual({
      previousAttempts: 2,
      previousErrorCode: "STORAGE_DELETE_FAILED",
    });

    // Subsequent retention pass with healthy storage purges the requeued task completely
    const recoveryPass = await runRetentionPass(
      { db, storage: memoryStorage, logger },
      { now: new Date(t0.getTime() + 5_000), maxAttempts: 2 },
    );
    expect(recoveryPass).toMatchObject({ processed: 1, succeeded: 1, permanentlyFailed: 0 });
    expect(memoryStorage.has(uploaded.objectKey)).toBe(false);
    expect((await getRetentionBacklogSummary(db)).permanentlyFailed).toBe(0);

    // Closing the Fastify apps cleanly stops the attached production scheduler via onClose hook
    await prodApp.close();
    await app.close();
    await client.close();
  });

  it("runs periodic retention passes via startRetentionScheduler and enforces production rate-limit defaults", async () => {
    const prodDefaults = loadConfig({
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      ALLOWED_ORIGINS: ORIGIN,
      UPLOAD_RATE_LIMIT_MAX: "1",
      UPLOAD_RATE_LIMIT_WINDOW_SECONDS: "60",
      EVALUATE_RATE_LIMIT_MAX: "1",
      EVALUATE_RATE_LIMIT_WINDOW_SECONDS: "60",
    });
    expect(prodDefaults.retentionPollMs).toBe(300_000);

    const { app, client, db, pgliteDb, memoryStorage } = await createRetentionTestApp({
      uploadRateLimit: prodDefaults.uploadRateLimit,
      evaluateRateLimit: prodDefaults.evaluateRateLimit,
    });
    const { cookie } = await registerAndSignIn(app, "scheduler@example.com");

    // 1st upload succeeds, 2nd upload in same window gets 429
    const uploaded = await uploadAndVerifyPdf(app, memoryStorage, cookie, "ScheduledPurge.pdf");
    const rateLimitedUpload = await app.inject({
      method: "POST",
      url: "/api/v1/resumes/upload-intents",
      headers: { origin: ORIGIN, cookie },
      payload: { filename: "TooFast.pdf", mimeType: PDF_MIME, sizeBytes: 128 },
    });
    expect(rateLimitedUpload.statusCode).toBe(429);

    // 1st evaluation succeeds, 2nd evaluation in same window gets 429
    const eval1 = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie },
      payload: {
        resumeVersionId: uploaded.versionId,
        candidateType: "FRESHER",
        jobDescription: null,
        idempotencyKey: "prod-rl-eval-1",
      },
    });
    expect(eval1.statusCode).toBe(200);

    const eval2 = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie },
      payload: {
        resumeVersionId: uploaded.versionId,
        candidateType: "EXPERIENCED",
        jobDescription: null,
        idempotencyKey: "prod-rl-eval-2",
      },
    });
    expect(eval2.statusCode).toBe(429);
    expect(eval2.headers["retry-after"]).toBeTruthy();

    // Mark uploaded version expired and verify startRetentionScheduler purges it automatically on interval tick
    const infoSpy = vi.fn();
    const scheduler = startRetentionScheduler(
      {
        db,
        storage: memoryStorage,
        logger: {
          info: infoSpy,
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
      { pollMs: 25, runOnStart: false },
    );

    await pgliteDb
      .update(schema.resumeVersions)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.resumeVersions.id, uploaded.versionId));

    // Wait briefly for periodic scheduler tick to pick up and purge the expired resume
    const deadline = Date.now() + 2_000;
    while (memoryStorage.has(uploaded.objectKey) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await scheduler.stop();
    expect(memoryStorage.has(uploaded.objectKey)).toBe(false);
    expect(infoSpy).toHaveBeenCalled();

    await app.close();
    await client.close();
  });
});
