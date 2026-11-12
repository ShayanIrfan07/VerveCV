import { PGlite } from "@electric-sql/pglite";
import {
  corruptPdfBytes,
  emptyPdfBytes,
  encryptedDocxBytes,
  PDF_MIME,
  sampleDocxBytes,
  samplePdfBytes,
} from "@vervecv/documents";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { Database } from "./infrastructure/db/client.js";
import * as schema from "./infrastructure/db/schema.js";
import { MemoryStorage } from "./infrastructure/storage/memory.js";
import { ParseGate } from "./modules/uploads/parse-gate.js";
import { createDeflateZip } from "../../../packages/documents/src/zip-node.js";

const ORIGIN = "http://localhost:5173";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function createTestApp(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: path.resolve("database/migrations") });
  const storage = new MemoryStorage();
  const config = {
    ...loadConfig({ LOG_LEVEL: "silent", ALLOWED_ORIGINS: ORIGIN }),
    cookieSecret: "test-cookie-secret-with-32-chars",
    sessionTtlSeconds: 60 * 60,
    signedUrlTtlSeconds: 300,
    pdfPageCap: 5,
    docxEntryCap: 20,
    docxUncompressedBytes: 1_000_000,
    parseTimeoutMs: 10_000,
    parseConcurrency: 2,
    ...overrides,
  };
  const app = await buildApp({
    config,
    db: database as unknown as Database,
    storage,
    parseGate: config.parseConcurrency === null ? null : new ParseGate(config.parseConcurrency),
  });
  return { app, storage };
}

async function sessionFor(app: Awaited<ReturnType<typeof buildApp>>, email: string): Promise<string> {
  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    headers: { origin: ORIGIN },
    payload: { email, password: "correct-horse" },
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

describe("resume upload", () => {
  it("verifies a PDF, hides it from another user, and deletes it", async () => {
    const { app, storage } = await createTestApp();
    const owner = await sessionFor(app, "owner@example.com");
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
    await storage.put(created.upload.url.replace("memory://upload/", ""), bytes);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/complete-upload`,
      headers: { origin: ORIGIN, cookie: owner },
      payload: {},
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ verificationState: "verified", officialScore: null });

    const usage = await app.inject({ method: "GET", url: "/api/v1/usage", headers: { cookie: owner } });
    expect(usage.json()).toMatchObject({ uploadBytesUsed: bytes.byteLength, limits: null });

    const view = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}/versions/${created.versionId}/view-url`,
      headers: { cookie: owner },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().url).not.toContain("Resume_Owner");

    const other = await sessionFor(app, "other@example.com");
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
    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/resumes/${created.resumeId}`,
      headers: { cookie: owner },
    });
    expect(afterDelete.statusCode).toBe(404);
    await app.close();
  });

  it("rejects legacy DOC, oversize, wrong magic, unreadable files, and a client score", async () => {
    const { app, storage } = await createTestApp();
    const cookie = await sessionFor(app, "files@example.com");
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

    const scored = await upload(app, storage, cookie, "resume.pdf", PDF_MIME, samplePdfBytes(), { score: 99 });
    expect(scored.statusCode).toBe(400);

    const disguised = await upload(app, storage, cookie, "resume.pdf", PDF_MIME, sampleDocxBytes());
    expect(disguised.statusCode).toBe(415);
    const corrupt = await upload(app, storage, cookie, "resume.pdf", PDF_MIME, corruptPdfBytes());
    expect(corrupt.statusCode).toBe(422);
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
    const bombCookie = await sessionFor(limited.app, "bomb@example.com");
    const exploded = await upload(limited.app, limited.storage, bombCookie, "resume.docx", DOCX_MIME, bomb);
    expect(exploded.json()).toMatchObject({ error: { code: "ZIP_LIMIT_EXCEEDED" } });
    await app.close();
    await limited.app.close();
  });

  it("leaves the upload pending when parse limits are not configured", async () => {
    const { app, storage } = await createTestApp({
      pdfPageCap: null,
      parseTimeoutMs: null,
      parseConcurrency: null,
    });
    const cookie = await sessionFor(app, "limits@example.com");
    const completed = await upload(app, storage, cookie, "resume.pdf", PDF_MIME, samplePdfBytes());
    expect(completed.statusCode).toBe(503);
    expect(completed.json()).toMatchObject({ error: { code: "PARSE_LIMITS_UNSET" } });
    const listed = await app.inject({ method: "GET", url: "/api/v1/resumes", headers: { cookie } });
    expect(listed.json()).toMatchObject({ resumes: [{ versions: [{ verificationState: "pending" }] }] });
    await app.close();
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
