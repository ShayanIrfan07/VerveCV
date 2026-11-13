import { createHash, randomUUID } from "node:crypto";
import {
  DOCX_MIME,
  DOC_MIME,
  DocumentAbortError,
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
import { and, count, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../infrastructure/db/client.js";
import {
  auditEvents,
  resumes,
  resumeVersions,
  retentionTasks,
  usageCounters,
  users,
} from "../../infrastructure/db/schema.js";
import { StorageObjectTooLargeError, type ObjectStorage } from "../../infrastructure/storage/memory.js";
import { MAX_SIGNED_URL_TTL_SECONDS } from "../../infrastructure/storage/r2.js";
import { currentPeriodStart } from "../auth/service.js";
import { UploadError } from "./errors.js";
import { ParseGateError, type ParseGate } from "./parse-gate.js";

const RETENTION_DAYS = 90;
const ABANDONED_SWEEP_BATCH_SIZE = 50;

export const DEFAULT_RESUME_LIST_LIMIT = 20;
export const MAX_RESUME_LIST_LIMIT = 100;

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

export interface ResumeListPagination {
  limit?: number;
  offset?: number;
}

export interface CompleteUploadOptions {
  signal?: AbortSignal;
  now?: Date;
}

export async function createUploadIntent(
  deps: UploadDeps,
  userId: string,
  input: UploadIntentInput,
  options: { now?: Date } = {},
) {
  const filename = basenameOf(input.filename);
  if (filename.length === 0 || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1) {
    throw new UploadError(400, "VALIDATION_ERROR", "Invalid request");
  }
  assertSupportedFile(filename, input.mimeType);
  if (input.sizeBytes > deps.config.uploadLimitBytes) {
    throw new UploadError(413, "PAYLOAD_TOO_LARGE", "The file is larger than the upload limit.");
  }

  const ttl = requireSignedUrlTtl(deps.config);
  const now = options.now ?? new Date();

  // Sweep stale abandoned upload intents before checking per-user pending bounds.
  await cleanupAbandonedUploadIntents(deps, { userId, now });

  const objectKey = `obj_${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Generate the signed upload URL BEFORE opening the database transaction so
  // signing or storage configuration failures never leave orphaned pending DB rows.
  const uploadUrl = await deps.storage.createUploadUrl({
    key: objectKey,
    contentType: input.mimeType,
    contentLength: input.sizeBytes,
    expiresInSeconds: ttl,
  });

  const inserted = await deps.db.transaction(async (tx) => {
    const lockedUser = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for("update")
      .limit(1);
    if (lockedUser.length === 0) {
      throw new UploadError(401, "UNAUTHORIZED", "Unauthorized");
    }

    const pendingCountRows = await tx
      .select({ total: count() })
      .from(resumeVersions)
      .innerJoin(resumes, eq(resumes.id, resumeVersions.resumeId))
      .where(
        and(
          eq(resumes.userId, userId),
          isNull(resumes.deletedAt),
          eq(resumeVersions.verificationState, "pending"),
          eq(resumeVersions.deletionState, "active"),
        ),
      );
    const activePending = Number(pendingCountRows[0]?.total ?? 0);
    if (activePending >= deps.config.maxPendingUploadsPerUser) {
      throw new UploadError(
        429,
        "TOO_MANY_PENDING_UPLOADS",
        "Too many pending uploads. Complete or wait for existing upload intents to expire.",
      );
    }

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
        createdAt: now,
      })
      .returning({ id: resumeVersions.id });
    const createdVersion = version[0];
    if (!createdVersion) {
      throw new UploadError(500, "INTERNAL_ERROR", "Internal error");
    }

    return { resumeId: created.id, versionId: createdVersion.id };
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

export async function cleanupAbandonedUploadIntents(
  deps: Pick<UploadDeps, "db" | "storage" | "config">,
  options: { userId?: string; now?: Date } = {},
): Promise<number> {
  const ttlSeconds = deps.config.signedUrlTtlSeconds;
  if (ttlSeconds === null) {
    return 0;
  }

  const now = options.now ?? new Date();
  const maxAgeMs = (ttlSeconds + deps.config.uploadIntentGraceSeconds) * 1000;
  const cutoff = new Date(now.getTime() - maxAgeMs);

  const conditions = [
    eq(resumeVersions.verificationState, "pending"),
    eq(resumeVersions.deletionState, "active"),
    lte(resumeVersions.createdAt, cutoff),
  ];
  if (options.userId !== undefined) {
    conditions.push(eq(resumes.userId, options.userId));
  }

  const staleRows = await deps.db
    .select({
      versionId: resumeVersions.id,
      resumeId: resumes.id,
      objectKey: resumeVersions.objectKey,
    })
    .from(resumeVersions)
    .innerJoin(resumes, eq(resumes.id, resumeVersions.resumeId))
    .where(and(...conditions))
    .limit(ABANDONED_SWEEP_BATCH_SIZE);

  let cleaned = 0;
  for (const stale of staleRows) {
    const didClean = await cleanupSingleAbandonedVersion(deps, stale, cutoff, now);
    if (didClean) {
      cleaned += 1;
    }
  }
  return cleaned;
}

async function cleanupSingleAbandonedVersion(
  deps: Pick<UploadDeps, "db" | "storage">,
  stale: { versionId: string; resumeId: string; objectKey: string },
  cutoff: Date,
  now: Date,
): Promise<boolean> {
  let objectRemoved = false;
  try {
    await deps.storage.delete(stale.objectKey);
    objectRemoved = true;
  } catch {
    objectRemoved = false;
  }

  return deps.db.transaction(async (tx) => {
    const locked = await tx
      .select({
        id: resumeVersions.id,
        verificationState: resumeVersions.verificationState,
        deletionState: resumeVersions.deletionState,
        createdAt: resumeVersions.createdAt,
      })
      .from(resumeVersions)
      .where(eq(resumeVersions.id, stale.versionId))
      .for("update")
      .limit(1);
    const row = locked[0];
    if (
      !row ||
      row.verificationState !== "pending" ||
      row.deletionState !== "active" ||
      row.createdAt.getTime() > cutoff.getTime()
    ) {
      return false;
    }

    if (objectRemoved) {
      await tx.delete(resumeVersions).where(eq(resumeVersions.id, stale.versionId));
      const remaining = await tx
        .select({ total: count() })
        .from(resumeVersions)
        .where(eq(resumeVersions.resumeId, stale.resumeId));
      if (Number(remaining[0]?.total ?? 0) === 0) {
        await tx.delete(resumes).where(eq(resumes.id, stale.resumeId));
      }
      return true;
    }

    // Storage delete failed transiently: transition out of pending and enqueue a
    // retention task for Phase 7's retryable deletion worker so no R2 object is leaked.
    await tx
      .update(resumeVersions)
      .set({ verificationState: "rejected", deletionState: "delete_requested" })
      .where(eq(resumeVersions.id, stale.versionId));
    await tx.insert(retentionTasks).values({
      resumeVersionId: stale.versionId,
      state: "pending",
      nextAttemptAt: now,
    });
    const activeSiblings = await tx
      .select({ total: count() })
      .from(resumeVersions)
      .where(
        and(
          eq(resumeVersions.resumeId, stale.resumeId),
          eq(resumeVersions.deletionState, "active"),
        ),
      );
    if (Number(activeSiblings[0]?.total ?? 0) === 0) {
      await tx
        .update(resumes)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(resumes.id, stale.resumeId), isNull(resumes.deletedAt)));
    }
    return true;
  });
}

export async function completeUpload(
  deps: UploadDeps,
  userId: string,
  resumeId: string,
  versionId: string,
  options: CompleteUploadOptions = {},
) {
  const version = await ownedVersion(deps.db, userId, resumeId, versionId);
  if (version.deletionState !== "active") {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }
  if (version.verificationState === "verified") {
    return verifiedBody(version.resumeId, version.id, version.parserVersion);
  }
  if (version.verificationState === "rejected") {
    throw new UploadError(422, "UNREADABLE", "The file could not be read.");
  }

  const now = options.now ?? new Date();
  if (deps.config.signedUrlTtlSeconds !== null) {
    const maxAgeMs =
      (deps.config.signedUrlTtlSeconds + deps.config.uploadIntentGraceSeconds) * 1000;
    const cutoff = new Date(now.getTime() - maxAgeMs);
    if (version.createdAt.getTime() <= cutoff.getTime()) {
      await cleanupSingleAbandonedVersion(
        deps,
        { versionId: version.id, resumeId: version.resumeId, objectKey: version.objectKey },
        cutoff,
        now,
      );
      throw new UploadError(410, "UPLOAD_EXPIRED", "The upload intent has expired.");
    }
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await deps.storage.get(version.objectKey, {
      maxBytes: deps.config.uploadLimitBytes,
    });
  } catch (error) {
    if (error instanceof StorageObjectTooLargeError) {
      await markRejectedIfPending(deps.db, version.id);
      throw new UploadError(413, "PAYLOAD_TOO_LARGE", "The file is larger than the upload limit.");
    }
    throw error;
  }

  if (!bytes) {
    throw new UploadError(422, "UPLOAD_INCOMPLETE", "The upload has not finished.");
  }
  if (bytes.byteLength > deps.config.uploadLimitBytes) {
    await markRejectedIfPending(deps.db, version.id);
    throw new UploadError(413, "PAYLOAD_TOO_LARGE", "The file is larger than the upload limit.");
  }
  if (bytes.byteLength !== version.sizeBytes) {
    await markRejectedIfPending(deps.db, version.id);
    throw new UploadError(422, "SIZE_MISMATCH", "The stored file size does not match the upload.");
  }
  if (version.mimeType === PDF_MIME && !matchesMagic(bytes, "pdf")) {
    await markRejectedIfPending(deps.db, version.id);
    throw new UploadError(415, "UNSUPPORTED_TYPE", "This file type is not supported.");
  }
  if (version.mimeType === DOCX_MIME && !matchesMagic(bytes, "docx")) {
    await markRejectedIfPending(deps.db, version.id);
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
    await deps.parseGate.run(
      async (gateSignal) => {
        if (version.mimeType === PDF_MIME && limits.kind === "pdf") {
          await extractPdf(bytes, meta, { ...limits.limits, signal: gateSignal });
          return;
        }
        if (limits.kind === "docx") {
          await extractDocx(bytes, meta, { ...limits.limits, signal: gateSignal });
        }
      },
      options.signal ? { signal: options.signal } : {},
    );
  } catch (error) {
    if (error instanceof ParseGateError) {
      if (error.reason === "ABORTED") {
        throw new UploadError(499, "REQUEST_ABORTED", "Request was cancelled.");
      }
      throw new UploadError(
        503,
        "PARSE_OVERLOADED",
        "Document verification is temporarily overloaded. Please retry shortly.",
      );
    }
    if (error instanceof DocumentAbortError) {
      throw new UploadError(499, "REQUEST_ABORTED", "Request was cancelled.");
    }
    if (error instanceof DocumentParseError) {
      await markRejectedIfPending(deps.db, version.id);
      const status = error.code === "UNSUPPORTED_TYPE" ? 415 : 422;
      throw new UploadError(status, error.code, error.message);
    }
    throw error;
  }

  const hash = meta.sourceHash;
  return deps.db.transaction(async (tx) => {
    const lockedRows = await tx
      .select({
        verificationState: resumeVersions.verificationState,
        deletionState: resumeVersions.deletionState,
        parserVersion: resumeVersions.parserVersion,
        resumeDeletedAt: resumes.deletedAt,
      })
      .from(resumeVersions)
      .innerJoin(resumes, eq(resumes.id, resumeVersions.resumeId))
      .where(
        and(
          eq(resumeVersions.id, version.id),
          eq(resumes.id, resumeId),
          eq(resumes.userId, userId),
        ),
      )
      .for("update")
      .limit(1);

    const locked = lockedRows[0];
    if (!locked || locked.resumeDeletedAt !== null || locked.deletionState !== "active") {
      throw new UploadError(404, "NOT_FOUND", "Not found");
    }
    if (locked.verificationState === "verified") {
      return verifiedBody(version.resumeId, version.id, locked.parserVersion);
    }
    if (locked.verificationState === "rejected") {
      throw new UploadError(422, "UNREADABLE", "The file could not be read.");
    }

    const transitioned = await tx
      .update(resumeVersions)
      .set({
        verificationState: "verified",
        sha256: hash,
        parserVersion: PARSER_VERSION,
      })
      .where(
        and(
          eq(resumeVersions.id, version.id),
          eq(resumeVersions.verificationState, "pending"),
          eq(resumeVersions.deletionState, "active"),
        ),
      )
      .returning({
        id: resumeVersions.id,
        parserVersion: resumeVersions.parserVersion,
      });

    if (transitioned.length === 0) {
      const recheck = await tx
        .select({
          verificationState: resumeVersions.verificationState,
          parserVersion: resumeVersions.parserVersion,
        })
        .from(resumeVersions)
        .where(eq(resumeVersions.id, version.id))
        .limit(1);
      if (recheck[0]?.verificationState === "verified") {
        return verifiedBody(version.resumeId, version.id, recheck[0].parserVersion);
      }
      throw new UploadError(422, "UNREADABLE", "The file could not be read.");
    }

    await tx
      .insert(usageCounters)
      .values({
        userId,
        periodStart: currentPeriodStart(now),
        evaluationsUsed: 0,
        uploadBytesUsed: bytes.byteLength,
      })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.periodStart],
        set: {
          uploadBytesUsed: sql`${usageCounters.uploadBytesUsed} + ${bytes.byteLength}`,
          updatedAt: now,
        },
      });

    await tx.insert(auditEvents).values({
      userId,
      eventType: "resume_upload_verified",
      targetId: version.id,
      safeMetadata: { mimeType: version.mimeType, sizeBytes: bytes.byteLength },
    });

    return verifiedBody(version.resumeId, version.id, PARSER_VERSION);
  });
}

export async function listResumes(
  db: Database,
  userId: string,
  pagination: ResumeListPagination = {},
  cleanupDeps?: Pick<UploadDeps, "db" | "storage" | "config"> | null,
) {
  const limit = normalizeLimit(pagination.limit);
  const offset = normalizeOffset(pagination.offset);

  if (cleanupDeps) {
    await cleanupAbandonedUploadIntents(cleanupDeps, { userId });
  }

  const fetchedResumes = await db
    .select({
      id: resumes.id,
      title: resumes.title,
      createdAt: resumes.createdAt,
    })
    .from(resumes)
    .where(and(eq(resumes.userId, userId), isNull(resumes.deletedAt)))
    .orderBy(desc(resumes.createdAt), desc(resumes.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = fetchedResumes.length > limit;
  const pageResumes = fetchedResumes.slice(0, limit);
  const pageResumeIds = pageResumes.map((row) => row.id);

  const versionRows =
    pageResumeIds.length === 0
      ? []
      : await db
          .select({
            id: resumeVersions.id,
            resumeId: resumeVersions.resumeId,
            versionNumber: resumeVersions.versionNumber,
            originalFilename: resumeVersions.originalFilename,
            mimeType: resumeVersions.mimeType,
            sizeBytes: resumeVersions.sizeBytes,
            verificationState: resumeVersions.verificationState,
            createdAt: resumeVersions.createdAt,
          })
          .from(resumeVersions)
          .where(
            and(
              inArray(resumeVersions.resumeId, pageResumeIds),
              eq(resumeVersions.deletionState, "active"),
            ),
          )
          .orderBy(desc(resumeVersions.versionNumber));

  const versionsByResume = new Map<string, ReturnType<typeof formatVersion>[]>();
  for (const row of versionRows) {
    const list = versionsByResume.get(row.resumeId) ?? [];
    list.push(formatVersion(row));
    versionsByResume.set(row.resumeId, list);
  }

  return {
    resumes: pageResumes.map((resumeRow) => ({
      id: resumeRow.id,
      title: resumeRow.title,
      createdAt: resumeRow.createdAt.toISOString(),
      versions: versionsByResume.get(resumeRow.id) ?? [],
    })),
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
  };
}

export async function getResume(db: Database, userId: string, resumeId: string) {
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
    .leftJoin(
      resumeVersions,
      and(
        eq(resumeVersions.resumeId, resumes.id),
        eq(resumeVersions.deletionState, "active"),
      ),
    )
    .where(
      and(
        eq(resumes.id, resumeId),
        eq(resumes.userId, userId),
        isNull(resumes.deletedAt),
      ),
    )
    .orderBy(desc(resumeVersions.versionNumber));

  if (rows.length === 0) {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }

  const grouped = groupResumes(rows);
  const resume = grouped[0];
  if (!resume) {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }
  return { resume };
}

export async function createViewUrl(
  deps: UploadDeps,
  userId: string,
  resumeId: string,
  versionId: string,
) {
  const version = await ownedVersion(deps.db, userId, resumeId, versionId);
  if (version.verificationState !== "verified" || version.deletionState !== "active") {
    throw new UploadError(404, "NOT_FOUND", "Not found");
  }
  const ttl = requireSignedUrlTtl(deps.config);
  const url = await deps.storage.createDownloadUrl({
    key: version.objectKey,
    expiresInSeconds: ttl,
  });
  return { url };
}

/**
 * Revoke access and enqueue a retention task. The deletion route then runs the retention
 * worker, which removes the stored object and derived evaluation rows. A failed object
 * delete stays retryable. No attempt cap is applied until ADR 0001 item A7 approves one.
 */
export async function deleteResume(db: Database, userId: string, resumeId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const resumeRows = await tx
      .select({ id: resumes.id })
      .from(resumes)
      .where(and(eq(resumes.id, resumeId), eq(resumes.userId, userId), isNull(resumes.deletedAt)))
      .for("update")
      .limit(1);
    if (resumeRows.length === 0) {
      throw new UploadError(404, "NOT_FOUND", "Not found");
    }

    const versionRows = await tx
      .select({ id: resumeVersions.id })
      .from(resumeVersions)
      .where(eq(resumeVersions.resumeId, resumeId))
      .for("update");
    const versionIds = versionRows.map((row) => row.id);

    await tx
      .update(resumes)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(resumes.id, resumeId));

    if (versionIds.length > 0) {
      await tx
        .update(resumeVersions)
        .set({ deletionState: "delete_requested" })
        .where(inArray(resumeVersions.id, versionIds));

      const existingTasks = await tx
        .select({ resumeVersionId: retentionTasks.resumeVersionId })
        .from(retentionTasks)
        .where(
          and(
            inArray(retentionTasks.resumeVersionId, versionIds),
            inArray(retentionTasks.state, ["pending", "running", "retryable_failure"]),
          ),
        );
      const alreadyQueued = new Set(existingTasks.map((task) => task.resumeVersionId));

      for (const versionId of versionIds) {
        if (!alreadyQueued.has(versionId)) {
          await tx.insert(retentionTasks).values({
            resumeVersionId: versionId,
            state: "pending",
            nextAttemptAt: now,
          });
        }
      }
    }

    await tx.insert(auditEvents).values({
      userId,
      eventType: "resume_delete_requested",
      targetId: resumeId,
      safeMetadata: {
        versionCount: versionIds.length,
        physicalDeletionComplete: false,
      },
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
      createdAt: resumeVersions.createdAt,
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

async function markRejectedIfPending(db: Database, versionId: string): Promise<void> {
  await db
    .update(resumeVersions)
    .set({ verificationState: "rejected" })
    .where(
      and(
        eq(resumeVersions.id, versionId),
        eq(resumeVersions.verificationState, "pending"),
      ),
    );
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
    throw new UploadError(
      503,
      "SIGNED_URL_TTL_UNSET",
      "The signed URL lifetime is not configured.",
    );
  }
  if (
    !Number.isInteger(config.signedUrlTtlSeconds) ||
    config.signedUrlTtlSeconds < 1 ||
    config.signedUrlTtlSeconds > MAX_SIGNED_URL_TTL_SECONDS
  ) {
    throw new UploadError(
      503,
      "SIGNED_URL_TTL_UNSET",
      "The signed URL lifetime is not configured.",
    );
  }
  return config.signedUrlTtlSeconds;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_RESUME_LIST_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESUME_LIST_LIMIT) {
    throw new UploadError(400, "VALIDATION_ERROR", "Invalid request");
  }
  return limit;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new UploadError(400, "VALIDATION_ERROR", "Invalid request");
  }
  return offset;
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
    return {
      kind: "pdf",
      limits: { pageCap: config.pdfPageCap, timeoutMs: config.parseTimeoutMs },
    };
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

function formatVersion(row: {
  id: string;
  versionNumber: number;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  verificationState: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    verificationState: row.verificationState,
    createdAt: row.createdAt.toISOString(),
  };
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
      versions: ReturnType<typeof formatVersion>[];
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
      current.versions.push(
        formatVersion({
          id: row.versionId,
          versionNumber: row.versionNumber,
          originalFilename: row.originalFilename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          verificationState: row.verificationState,
          createdAt: row.versionCreatedAt,
        }),
      );
    }
    grouped.set(row.id, current);
  }
  return [...grouped.values()];
}
