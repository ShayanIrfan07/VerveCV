import { PGlite } from "@electric-sql/pglite";
import { PDF_MIME, samplePdfBytes } from "@vervecv/documents";
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
  };
  const parseGate = new ParseGate(config.parseConcurrency ?? 1, {
    maxQueue: config.parseMaxQueue,
    maxWaitMs: config.parseQueueTimeoutMs,
  });
  const app = await buildApp({ config, db: database as unknown as Database, storage, parseGate });
  return { app, client, storage };
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

async function verifiedVersion(app: Awaited<ReturnType<typeof buildApp>>, storage: MemoryStorage, cookie: string) {
  const bytes = samplePdfBytes();
  const intent = await app.inject({
    method: "POST",
    url: "/api/v1/resumes/upload-intents",
    headers: { origin: ORIGIN, cookie },
    payload: { filename: "AdaLovelace_Resume.pdf", mimeType: PDF_MIME, sizeBytes: bytes.byteLength },
  });
  expect(intent.statusCode).toBe(201);
  const created = intent.json<{ resumeId: string; versionId: string; upload: { url: string } }>();
  await storage.put(created.upload.url.replace("memory://upload/", ""), bytes);
  const completed = await app.inject({
    method: "POST",
    url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
    headers: { origin: ORIGIN, cookie },
    payload: {},
  });
  expect(completed.statusCode).toBe(200);
  return created.versionId;
}

describe("evaluation dashboard API", () => {
  it("scores a verified resume, hides it from another user, and keeps history stable", async () => {
    const { app, client, storage } = await createTestApp();
    const owner = await sessionFor(app, "owner@example.com");
    const other = await sessionFor(app, "other@example.com");
    const versionId = await verifiedVersion(app, storage, owner);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: versionId,
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
        resumeVersionId: versionId,
        candidateType: "FRESHER",
        jobDescription: "TypeScript",
        idempotencyKey: "score-key-1",
      },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json<{
      evaluation: {
        id: string;
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
    expect(body.evaluation.scoreStatus).toBe("PROVISIONAL");
    expect(body.evaluation.penaltyTotal).toBeNull();
    expect(body.evaluation.penaltyStatus).toBe("not_evaluated");
    expect(body.evaluation.finalScore).toBeNull();
    expect(body.evaluation.baseScore).toBeLessThanOrEqual(body.evaluation.denominator);
    expect(body.evaluation.denominator).toBeLessThan(100);
    expect(body.evaluation.jdMatch).toEqual({ status: "not_implemented", appliedToScore: false });
    expect(body.job.status).toBe("succeeded");
    const scoredMax = body.evaluation.criteria.reduce((sum, criterion) => sum + (criterion.status === "scored" ? criterion.maxScore : 0), 0);
    expect(body.evaluation.denominator).toBe(scoredMax);
    for (const criterion of body.evaluation.criteria) {
      if (criterion.status === "scored" && criterion.score !== null) {
        expect(criterion.score).toBeGreaterThanOrEqual(0);
        expect(criterion.score).toBeLessThanOrEqual(criterion.maxScore);
      }
    }

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/evaluations",
      headers: { origin: ORIGIN, cookie: owner },
      payload: {
        resumeVersionId: versionId,
        candidateType: "EXPERIENCED",
        jobDescription: null,
        idempotencyKey: "score-key-1",
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ evaluation: { id: string } }>().evaluation.id).toBe(body.evaluation.id);

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

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/evaluations",
      headers: { cookie: owner },
    });
    expect(listed.statusCode).toBe(200);
    const history = listed.json<{ evaluations: Array<{ id: string; finalScore: number | null; penaltyTotal: number | null }> }>();
    expect(history.evaluations.map((item) => item.id)).toContain(body.evaluation.id);
    expect(history.evaluations[0]?.finalScore).toBeNull();
    expect(history.evaluations[0]?.penaltyTotal).toBeNull();
    await client.close();
  });
});
