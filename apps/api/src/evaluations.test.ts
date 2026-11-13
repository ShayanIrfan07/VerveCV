import { PGlite } from "@electric-sql/pglite";
import { PDF_MIME, samplePdfBytes } from "@vervecv/documents";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { Database } from "./infrastructure/db/client.js";
import * as schema from "./infrastructure/db/schema.js";
import { MemoryStorage } from "./infrastructure/storage/memory.js";
import { ParseGate } from "./modules/uploads/parse-gate.js";

const ORIGIN = "http://localhost:5173";

async function createTestApp() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: path.resolve("database/migrations") });
  const storage = new MemoryStorage();
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
    maxPendingUploadsPerUser: 20,
  };
  const parseGate = new ParseGate(config.parseConcurrency ?? 1, {
    maxQueue: config.parseMaxQueue,
    maxWaitMs: config.parseQueueTimeoutMs,
  });
  const app = await buildApp({
    config,
    db: database as unknown as Database,
    storage,
    parseGate,
  });
  return { app, client, pgliteDb: database, storage };
}

async function sessionFor(app: Awaited<ReturnType<typeof buildApp>>, email: string): Promise<string> {
  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin: ORIGIN },
    payload: { email, password: "correct-horse", displayName: "Ada Lovelace" },
  });
  expect(registered.statusCode).toBe(201);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { origin: ORIGIN },
    payload: { email, password: "correct-horse" },
  });
  const cookie = login.cookies.find((item) => item.name === "vervecv_session");
  return `vervecv_session=${cookie?.value ?? ""}`;
}

async function createPendingVersion(
  app: Awaited<ReturnType<typeof buildApp>>,
  storage: MemoryStorage,
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
  const created = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
  const objectKey = created.upload.url.replace("memory://upload/", "");
  await storage.put(objectKey, bytes);
  return { ...created, objectKey, bytes };
}

async function verifiedVersion(
  app: Awaited<ReturnType<typeof buildApp>>,
  storage: MemoryStorage,
  cookie: string,
  filename = "AdaLovelace_Resume.pdf",
) {
  const created = await createPendingVersion(app, storage, cookie, filename);
  const completed = await app.inject({
    method: "POST",
    url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
    headers: { origin: ORIGIN, cookie },
    payload: {},
  });
  expect(completed.statusCode).toBe(200);
  return created;
}

describe("evaluation dashboard API", () => {
  it("scores only server-verified resume bytes, enforces fingerprint idempotency (200 replay vs 409 conflict), and isolates users", async () => {
    const { app, client, storage } = await createTestApp();
    const owner = await sessionFor(app, "owner@example.com");
    const other = await sessionFor(app, "other@example.com");

    // Unverified resume version cannot be scored
    const pending = await createPendingVersion(app, storage, owner, "Unverified_Resume.pdf");
    const scoreUnverified = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: pending.versionId,
        candidateType: "FRESHER",
        jobDescription: null,
        idempotencyKey: "unverified-key-1",
      },
    });
    expect(scoreUnverified.statusCode).toBe(409);
    expect(scoreUnverified.json()).toMatchObject({ error: { code: "NOT_VERIFIED" } });

    const verified = await verifiedVersion(app, storage, owner);
    const secondVerified = await verifiedVersion(app, storage, owner, "Second_Resume.pdf");

    // Client-provided score is rejected by schema validation
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: verified.versionId,
        candidateType: "FRESHER",
        jobDescription: null,
        idempotencyKey: "score-key-1",
        score: 99,
      },
    });
    expect(rejected.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: verified.versionId,
        candidateType: "FRESHER",
        jobDescription: "  TypeScript  ",
        idempotencyKey: "score-key-1",
      },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json<{
      evaluation: {
        id: string;
        resumeId: string;
        resumeVersionId: string;
        originalFilename: string;
        scoreStatus: string;
        baseScore: number;
        denominator: number;
        penaltyTotal: number | null;
        penaltyStatus: string;
        finalScore: number | null;
        criteria: Array<{ status: string; score: number | null; maxScore: number }>;
        jdMatch: { status: string; appliedToScore: boolean } | null;
      };
      job: { id: string; status: string };
    }>();

    expect(body.evaluation.resumeId).toBe(verified.resumeId);
    expect(body.evaluation.resumeVersionId).toBe(verified.versionId);
    expect(body.evaluation.originalFilename).toBe("AdaLovelace_Resume.pdf");
    expect(body.evaluation.scoreStatus).toBe("PROVISIONAL");
    expect(body.evaluation.penaltyTotal).toBeNull();
    expect(body.evaluation.penaltyStatus).toBe("not_evaluated");
    expect(body.evaluation.finalScore).toBeNull();
    expect(body.evaluation.baseScore).toBeLessThanOrEqual(body.evaluation.denominator);
    expect(body.evaluation.denominator).toBeLessThan(100);
    expect(body.evaluation.jdMatch).toEqual({ status: "not_implemented", appliedToScore: false });
    expect(body.job.status).toBe("succeeded");

    const scoredMax = body.evaluation.criteria.reduce(
      (sum, criterion) => sum + (criterion.status === "scored" ? criterion.maxScore : 0),
      0,
    );
    expect(body.evaluation.denominator).toBe(scoredMax);
    for (const criterion of body.evaluation.criteria) {
      if (criterion.status === "scored" && criterion.score !== null) {
        expect(criterion.score).toBeGreaterThanOrEqual(0);
        expect(criterion.score).toBeLessThanOrEqual(criterion.maxScore);
      }
    }

    // Identical replay (canonicalized whitespace in jobDescription) returns the original evaluation
    const identicalReplay = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: verified.versionId,
        candidateType: "FRESHER",
        jobDescription: "TypeScript",
        idempotencyKey: "score-key-1",
      },
    });
    expect(identicalReplay.statusCode).toBe(200);
    expect(identicalReplay.json<{ evaluation: { id: string } }>().evaluation.id).toBe(
      body.evaluation.id,
    );

    // Reusing the same idempotencyKey with different candidateType -> 409 IDEMPOTENCY_CONFLICT
    const candidateMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: verified.versionId,
        candidateType: "EXPERIENCED",
        jobDescription: "TypeScript",
        idempotencyKey: "score-key-1",
      },
    });
    expect(candidateMismatch.statusCode).toBe(409);
    expect(candidateMismatch.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    // Reusing the same idempotencyKey with different jobDescription -> 409 IDEMPOTENCY_CONFLICT
    const jdMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: verified.versionId,
        candidateType: "FRESHER",
        jobDescription: null,
        idempotencyKey: "score-key-1",
      },
    });
    expect(jdMismatch.statusCode).toBe(409);
    expect(jdMismatch.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    // Reusing the same idempotencyKey with different resumeVersionId -> 409 IDEMPOTENCY_CONFLICT
    const versionMismatch = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: secondVerified.versionId,
        candidateType: "FRESHER",
        jobDescription: "TypeScript",
        idempotencyKey: "score-key-1",
      },
    });
    expect(versionMismatch.statusCode).toBe(409);
    expect(versionMismatch.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    // Cross-user isolation on GET /evaluations/:id, GET /evaluation-jobs/:id, and POST /evaluations
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/evaluations/${body.evaluation.id}`,
      headers: { cookie: other },
    });
    expect(hidden.statusCode).toBe(404);

    const hiddenJob = await app.inject({
      method: "GET",
      url: `/api/v1/evaluation-jobs/${body.job.id}`,
      headers: { cookie: other },
    });
    expect(hiddenJob.statusCode).toBe(404);

    const crossUserScore = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: other },
      payload: {
        resumeVersionId: verified.versionId,
        candidateType: "FRESHER",
        jobDescription: null,
        idempotencyKey: "other-user-key-1",
      },
    });
    expect(crossUserScore.statusCode).toBe(404);

    await app.close();
    await client.close();
  });

  it("handles simultaneous identical and conflicting evaluation submissions safely without duplicating rows or usage counts", async () => {
    const { app, client, pgliteDb, storage } = await createTestApp();
    const owner = await sessionFor(app, "concurrent@example.com");
    const verified = await verifiedVersion(app, storage, owner);

    // 4 concurrent identical requests with the same idempotencyKey
    const identicalConcurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/evaluations",
          headers: { origin: ORIGIN, cookie: owner },
          payload: {
            resumeVersionId: verified.versionId,
            candidateType: "FRESHER",
            jobDescription: "PostgreSQL",
            idempotencyKey: "concurrent-same-key",
          },
        }),
      ),
    );

    for (const res of identicalConcurrent) {
      expect(res.statusCode).toBe(200);
    }
    const returnedIds = new Set(
      identicalConcurrent.map(
        (res) => res.json<{ evaluation: { id: string } }>().evaluation.id,
      ),
    );
    expect(returnedIds.size).toBe(1);

    const storedEvals = await pgliteDb.select().from(schema.evaluations);
    expect(storedEvals).toHaveLength(1);

    const usageAfterSameKey = await app.inject({
      method: "GET",
      url: "/api/v1/usage",
      headers: { cookie: owner },
    });
    expect(usageAfterSameKey.json()).toMatchObject({ evaluationsUsed: 1 });

    // 2 concurrent conflicting requests sharing one new idempotencyKey -> one 200, one 409
    const conflictingConcurrent = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/v1/evaluations",
        headers: { origin: ORIGIN, cookie: owner },
        payload: {
          resumeVersionId: verified.versionId,
          candidateType: "FRESHER",
          jobDescription: null,
          idempotencyKey: "concurrent-conflict-key",
        },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/evaluations",
        headers: { origin: ORIGIN, cookie: owner },
        payload: {
          resumeVersionId: verified.versionId,
          candidateType: "EXPERIENCED",
          jobDescription: null,
          idempotencyKey: "concurrent-conflict-key",
        },
      }),
    ]);

    const conflictStatuses = conflictingConcurrent.map((res) => res.statusCode).sort();
    expect(conflictStatuses).toEqual([200, 409]);

    await app.close();
    await client.close();
  });

  it("hides individual evaluations, findings, jobs, idempotent replays, and history entries once a resume or version is deleted/inactive", async () => {
    const { app, client, pgliteDb, storage } = await createTestApp();
    const owner = await sessionFor(app, "delete@example.com");
    const v1 = await verifiedVersion(app, storage, owner, "DeleteMe_Resume.pdf");
    const v2 = await verifiedVersion(app, storage, owner, "VersionInactive_Resume.pdf");

    const eval1Res = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: v1.versionId,
        candidateType: "FRESHER",
        jobDescription: null,
        idempotencyKey: "del-eval-1",
      },
    });
    expect(eval1Res.statusCode).toBe(200);
    const eval1 = eval1Res.json<{ evaluation: { id: string }; job: { id: string } }>();

    const eval2Res = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: v2.versionId,
        candidateType: "EXPERIENCED",
        jobDescription: null,
        idempotencyKey: "del-eval-2",
      },
    });
    expect(eval2Res.statusCode).toBe(200);
    const eval2 = eval2Res.json<{ evaluation: { id: string }; job: { id: string } }>();

    // Before deletion: both evaluations and jobs are retrievable
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/evaluations/${eval1.evaluation.id}`,
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/evaluation-jobs/${eval1.job.id}`,
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(200);

    // Soft-delete resume 1 via DELETE /api/v1/resumes/:resumeId
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/resumes/${v1.resumeId}`,
      headers: { origin: ORIGIN, cookie: owner },
    });
    expect(deleted.statusCode).toBe(204);

    // Individual evaluation retrieval, job retrieval, history listing, and idempotent replay must all hide eval1
    const getDeletedEval = await app.inject({
      method: "GET",
      url: `/api/v1/evaluations/${eval1.evaluation.id}`,
      headers: { cookie: owner },
    });
    expect(getDeletedEval.statusCode).toBe(404);

    const getDeletedJob = await app.inject({
      method: "GET",
      url: `/api/v1/evaluation-jobs/${eval1.job.id}`,
      headers: { cookie: owner },
    });
    expect(getDeletedJob.statusCode).toBe(404);

    const replayDeleted = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: v1.versionId,
        candidateType: "FRESHER",
        jobDescription: null,
        idempotencyKey: "del-eval-1",
      },
    });
    expect(replayDeleted.statusCode).toBe(404);

    // Also mark v2's version inactive directly while keeping its parent resume non-deleted
    await pgliteDb
      .update(schema.resumeVersions)
      .set({ deletionState: "delete_requested" })
      .where(eq(schema.resumeVersions.id, v2.versionId));

    const getInactiveVersionEval = await app.inject({
      method: "GET",
      url: `/api/v1/evaluations/${eval2.evaluation.id}`,
      headers: { cookie: owner },
    });
    expect(getInactiveVersionEval.statusCode).toBe(404);

    const getInactiveVersionJob = await app.inject({
      method: "GET",
      url: `/api/v1/evaluation-jobs/${eval2.job.id}`,
      headers: { cookie: owner },
    });
    expect(getInactiveVersionJob.statusCode).toBe(404);

    const historyAfterDeletes = await app.inject({
      method: "GET",
      url: "/api/v1/evaluations",
      headers: { cookie: owner },
    });
    expect(historyAfterDeletes.statusCode).toBe(200);
    expect(historyAfterDeletes.json<{ evaluations: unknown[] }>().evaluations).toEqual([]);

    await app.close();
    await client.close();
  });

  it("paginates evaluation history stably in reverse-chronological order", async () => {
    const { app, client, storage } = await createTestApp();
    const owner = await sessionFor(app, "history@example.com");
    const verified = await verifiedVersion(app, storage, owner);

    const ids: string[] = [];
    for (const index of [1, 2, 3]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/evaluations",
        headers: { origin: ORIGIN, cookie: owner },
        payload: {
          resumeVersionId: verified.versionId,
          candidateType: "FRESHER",
          jobDescription: `Role ${index}`,
          idempotencyKey: `page-eval-${index}`,
        },
      });
      expect(created.statusCode).toBe(200);
      ids.push(created.json<{ evaluation: { id: string } }>().evaluation.id);
    }

    const page1 = await app.inject({
      method: "GET",
      url: "/api/v1/evaluations?limit=2&offset=0",
      headers: { cookie: owner },
    });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json<{
      evaluations: Array<{ id: string }>;
      pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
    }>();
    expect(p1.evaluations).toHaveLength(2);
    expect(p1.pagination).toEqual({
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });

    const page2 = await app.inject({
      method: "GET",
      url: "/api/v1/evaluations?limit=2&offset=2",
      headers: { cookie: owner },
    });
    expect(page2.statusCode).toBe(200);
    const p2 = page2.json<{
      evaluations: Array<{ id: string }>;
      pagination: { limit: number; offset: number; hasMore: boolean; nextOffset: number | null };
    }>();
    expect(p2.evaluations).toHaveLength(1);
    expect(p2.pagination).toEqual({
      limit: 2,
      offset: 2,
      hasMore: false,
      nextOffset: null,
    });

    const combined = [...p1.evaluations, ...p2.evaluations].map((item) => item.id);
    expect(new Set(combined)).toEqual(new Set(ids));

    await app.close();
    await client.close();
  });
});
