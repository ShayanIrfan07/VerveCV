import { createHash, randomUUID } from "node:crypto";
import {
  DOCX_MIME,
  DOC_MIME,
  DocumentParseError,
  PDF_MIME,
  PARSER_VERSION,
  basenameOf,
  extensionOf,
  extractDocx,
  extractPdf,
  matchesMagic,
  type DocxLimits,
  type PdfLimits,
} from "@vervecv/documents";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../infrastructure/db/client.js";
import { auditEvents, resumes, resumeVersions, retentionTasks, usageCounters } from "../../infrastructure/db/schema.js";
import type { ObjectStorage } from "../../infrastructure/storage/memory.js";
import { currentPeriodStart } from "../auth/service.js";
import { UploadError } from "./errors.js";
import type { ParseGate } from "./parse-gate.js";

const RETENTION_DAYS = 90;

export interface UploadIntentInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadDeps {
  db: Database;
  storage: ObjectStorage;
  config: AppConfig;
  parseGate: ParseGate | null;
}

export async function createUploadIntent(deps: UploadDeps, userId: string, input: UploadIntentInput) {
  const filename = basenameOf(input.filename);
  if (filename.length === 0 || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new UploadError(400, "VALIDATION_ERROR", "Invalid request");
  }
  assertSupportedFile(filename, input.mimeType);
  if (input.sizeBytes > deps.config.uploadLimitBytes) {
    throw new UploadError(413, "PAYLOAD_TOO_LARGE", "The file is larger than the upload limit.");
  }
  const ttl = requireSignedUrlTtl(deps.config);
  const objectKey = `obj_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const inserted = await deps.db.transaction(async (tx) => {
    const resume = await tx
      .insert(resumes)
      .values({ userId, title: filename })
      .returning({ id: resumes.id });
    const created = resume[0];
    if (!created) {
      throw new UploadError(500, "INTERNAL_ERROR", "Internal error");
    }
    const version = await tx
      .insert(resumeVersions)
      .values({
        resumeId: created.id,
        versionNumber: 1,
        originalFilename: filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: "pending",
        objectKey,
        expiresAt,
        deletionState: "active",
        verificationState: "pending",
      })
      .returning({ id: resumeVersions.id });
    const createdVersion = version[0];
    if (!createdVersion) {
      throw new UploadError(500, "INTERNAL_ERROR", "Internal error");
    }
    return { resumeId: created.id, versionId: createdVersion.id };
  });
  const uploadUrl = await deps.storage.createUploadUrl({
    key: objectKey,
    contentType: input.mimeType,
    contentLength: input.sizeBytes,
    expiresInSeconds: ttl,
  });
  return {
    resumeId: inserted.resumeId,
    versionId: inserted.versionId,
    upload: {
      method: "PUT" as const,
      url: uploadUrl,
      headers: { "content-type": input.mimeType },
    },
  };
}

export async function completeUpload(deps: UploadDeps, userId: string, resumeId: string, versionId: string) {
  const version = await ownedVersion(deps.db, userId, resumeId, versionId);
  if (version.verificationState === "verified") {
    return verifiedBody(version.resumeId, version.id, version.parserVersion);
  }
  if (version.verificationState === "rejected") {
    throw new UploadError(422, "UNREADABLE", "The file could not be read.");
  }
  const bytes = await deps.storage.get(version.objectKey);
  if (!bytes) {
    throw new UploadError(422, "UPLOAD_INCOMPLETE", "The upload has not finished.");
  }
  if (bytes.byteLength > deps.config.uploadLimitBytes) {
    await markRejected(deps.db, version.id);
    throw new UploadError(413, "PAYLOAD_TOO_LARGE", "The file is larger than the upload limit.");
  }
  if (bytes.byteLength !== version.sizeBytes) {
    await markRejected(deps.db, version.id);
    throw new UploadError(422, "SIZE_MISMATCH", "The stored file size does not match the upload.");
  }
  if (version.mimeType === PDF_MIME && !matchesMagic(bytes, "pdf")) {
    await markRejected(deps.db, version.id);
    throw new UploadError(415, "UNSUPPORTED_TYPE", "This file type is not supported.");
  }
  if (version.mimeType === DOCX_MIME && !matchesMagic(bytes, "docx")) {
    await markRejected(deps.db, version.id);
    throw new UploadError(415, "UNSUPPORTED_TYPE", "This file type is not supported.");
  }

  const limits = limitsFor(version.mimeType, deps.config);
  if (!limits || !deps.parseGate) {
    throw new UploadError(503, "PARSE_LIMITS_UNSET", "Parse limits are not configured.");
  }
  const meta = {
    filename: version.originalFilename,
    mimeType: version.mimeType,
    sourceHash: sha256(bytes),
    metadata: {},
  };
  try {
    await deps.parseGate.run(async () => {
      if (version.mimeType === PDF_MIME && limits.kind === "pdf") {
        await extractPdf(bytes, meta, limits.limits);
        return;
      }
      if (limits.kind === "docx") {
        await extractDocx(bytes, meta, limits.limits);
      }
    });
  } catch (error) {
    if (error instanceof DocumentParseError) {
      await markRejected(deps.db, version.id);
      const status = error.code === "UNSUPPORTED_TYPE" ? 415 : 422;
      throw new UploadError(status, error.code, error.message);
    }
    throw error;
  }

  const hash = meta.sourceHash;
  await deps.db.transaction(async (tx) => {
    await tx
      .update(resumeVersions)
      .set({ verificationState: "verified", sha256: hash, parserVersion: PARSER_VERSION })
      .where(eq(resumeVersions.id, version.id));
    await tx
      .insert(usageCounters)
      .values({
        userId,
        periodStart: currentPeriodStart(),
        evaluationsUsed: 0,
        uploadBytesUsed: bytes.byteLength,
      })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.periodStart],
        set: {
          uploadBytesUsed: sql`${usageCounters.uploadBytesUsed} + ${bytes.byteLength}`,
          updatedAt: new Date(),
        },
      });
    await tx.insert(auditEvents).values({
      userId,
      eventType: "resume_upload_verified",
      targetId: version.id,
      safeMetadata: { mimeType: version.mimeType, sizeBytes: bytes.byteLength },
    });
  });
  return verifiedBody(version.resumeId, version.id, PARSER_VERSION);
}

export async function listResumes(db: Database, userId: string) {
  const rows = await db
    .select({
      id: resumes.id,
      title: resumes.title,
      createdAt: resumes.createdAt,
      versionId: resumeVersions.id,
      versionNumber: resumeVersions.versionNumber,
      originalFilename: resumeVersions.originalFilename,
      mimeType: resumeVersions.mimeType,
      sizeBytes: resumeVersions.sizeBytes,
      verificationState: resumeVersions.verificationState,
      versionCreatedAt: resumeVersions.createdAt,
    })
    .from(resumes)
    .leftJoin(resumeVersions, eq(resumeVersions.resumeId, resumes.id))
    .where(and(eq(resumes.userId, userId), isNull(resumes.deletedAt)))
    .orderBy(desc(resumes.createdAt));
  return { resumes: groupResumes(rows) };
}

export async function getResume(db: Database, userId: string, resumeId: string) {
  const listed = await listResumes(db, userId);
  const resume = listed.resumes.find((item) => item.id === resumeId);
  if (!resume) {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }
  return { resume };
}

export async function createViewUrl(deps: UploadDeps, userId: string, resumeId: string, versionId: string) {
  const version = await ownedVersion(deps.db, userId, resumeId, versionId);
  if (version.verificationState !== "verified" || version.deletionState !== "active") {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }
  const ttl = requireSignedUrlTtl(deps.config);
  const url = await deps.storage.createDownloadUrl({ key: version.objectKey, expiresInSeconds: ttl });
  return { url };
}

export async function deleteResume(db: Database, userId: string, resumeId: string) {
  const found = await db
    .select({ id: resumes.id, versionId: resumeVersions.id })
    .from(resumes)
    .leftJoin(resumeVersions, eq(resumeVersions.resumeId, resumes.id))
    .where(and(eq(resumes.id, resumeId), eq(resumes.userId, userId), isNull(resumes.deletedAt)));
  if (found.length === 0) {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }
  const versionIds = found.flatMap((row) => (row.versionId ? [row.versionId] : []));
  await db.transaction(async (tx) => {
    await tx.update(resumes).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(resumes.id, resumeId));
    if (versionIds.length > 0) {
      for (const versionId of versionIds) {
        await tx
          .update(resumeVersions)
          .set({ deletionState: "delete_requested" })
          .where(eq(resumeVersions.id, versionId));
        await tx.insert(retentionTasks).values({
          resumeVersionId: versionId,
          state: "pending",
          nextAttemptAt: new Date(),
        });
      }
    }
    await tx.insert(auditEvents).values({
      userId,
      eventType: "resume_delete_requested",
      targetId: resumeId,
      safeMetadata: { versionCount: versionIds.length },
    });
  });
}

function verifiedBody(resumeId: string, versionId: string, parserVersion: string | null) {
  return {
    resumeId,
    versionId,
    verificationState: "verified" as const,
    parserVersion,
    officialScore: null,
  };
}

async function ownedVersion(db: Database, userId: string, resumeId: string, versionId: string) {
  const rows = await db
    .select({
      id: resumeVersions.id,
      resumeId: resumes.id,
      mimeType: resumeVersions.mimeType,
      sizeBytes: resumeVersions.sizeBytes,
      objectKey: resumeVersions.objectKey,
      originalFilename: resumeVersions.originalFilename,
      verificationState: resumeVersions.verificationState,
      deletionState: resumeVersions.deletionState,
      parserVersion: resumeVersions.parserVersion,
    })
    .from(resumeVersions)
    .innerJoin(resumes, eq(resumes.id, resumeVersions.resumeId))
    .where(
      and(
        eq(resumes.id, resumeId),
        eq(resumeVersions.id, versionId),
        eq(resumes.userId, userId),
        isNull(resumes.deletedAt),
      ),
    )
    .limit(1);
  const version = rows[0];
  if (!version) {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }
  return version;
}

async function markRejected(db: Database, versionId: string): Promise<void> {
  await db.update(resumeVersions).set({ verificationState: "rejected" }).where(eq(resumeVersions.id, versionId));
}

function assertSupportedFile(filename: string, mimeType: string): void {
  const extension = extensionOf(filename);
  if (extension === ".doc" || mimeType === DOC_MIME) {
    throw new UploadError(415, "UNSUPPORTED_TYPE", "This file type is not supported.");
  }
  const pdf = extension === ".pdf" && mimeType === PDF_MIME;
  const docx = extension === ".docx" && mimeType === DOCX_MIME;
  if (!pdf && !docx) {
    throw new UploadError(415, "UNSUPPORTED_TYPE", "This file type is not supported.");
  }
}

function requireSignedUrlTtl(config: AppConfig): number {
  if (config.signedUrlTtlSeconds === null) {
    throw new UploadError(503, "SIGNED_URL_TTL_UNSET", "The signed URL lifetime is not configured.");
  }
  return config.signedUrlTtlSeconds;
}

function limitsFor(
  mimeType: string,
  config: AppConfig,
): { kind: "pdf"; limits: PdfLimits } | { kind: "docx"; limits: DocxLimits } | null {
  if (config.parseTimeoutMs === null || config.parseConcurrency === null) {
    return null;
  }
  if (mimeType === PDF_MIME) {
    if (config.pdfPageCap === null) {
      return null;
    }
    return { kind: "pdf", limits: { pageCap: config.pdfPageCap, timeoutMs: config.parseTimeoutMs } };
  }
  if (config.docxEntryCap === null || config.docxUncompressedBytes === null) {
    return null;
  }
  return {
    kind: "docx",
    limits: {
      entryCap: config.docxEntryCap,
      uncompressedBytes: config.docxUncompressedBytes,
      timeoutMs: config.parseTimeoutMs,
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function groupResumes(
  rows: {
    id: string;
    title: string;
    createdAt: Date;
    versionId: string | null;
    versionNumber: number | null;
    originalFilename: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    verificationState: string | null;
    versionCreatedAt: Date | null;
  }[],
) {
  const grouped = new Map<
    string,
    {
      id: string;
      title: string;
      createdAt: string;
      versions: {
        id: string;
        versionNumber: number;
        originalFilename: string;
        mimeType: string;
        sizeBytes: number;
        verificationState: string;
        createdAt: string;
      }[];
    }
  >();
  for (const row of rows) {
    const current = grouped.get(row.id) ?? {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      versions: [],
    };
    if (
      row.versionId &&
      row.versionNumber !== null &&
      row.originalFilename &&
      row.mimeType &&
      row.sizeBytes !== null &&
      row.verificationState &&
      row.versionCreatedAt
    ) {
      current.versions.push({
        id: row.versionId,
        versionNumber: row.versionNumber,
        originalFilename: row.originalFilename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        verificationState: row.verificationState,
        createdAt: row.versionCreatedAt.toISOString(),
      });
    }
    grouped.set(row.id, current);
  }
  return [...grouped.values()];
}
