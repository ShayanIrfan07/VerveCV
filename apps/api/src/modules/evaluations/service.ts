import { createHash } from "node:crypto";
import {
  evaluate,
  getDefaultSpellChecker,
  type CandidateType,
  type EvaluationResult,
} from "@vervecv/evaluation";
import {
  DocumentAbortError,
  DocumentParseError,
  extractDocx,
  extractPdf,
  PDF_MIME,
  type DocxLimits,
  type PdfLimits,
} from "@vervecv/documents";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../infrastructure/db/client.js";
import { evaluationJobs, evaluations, findings, ignoredTerms, resumes, resumeVersions, users } from "../../infrastructure/db/schema.js";
import type { ObjectStorage } from "../../infrastructure/storage/memory.js";
import type { ParseGate } from "../uploads/parse-gate.js";
import { EvaluationError } from "./errors.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const DEFAULT_EVALUATION_LIST_LIMIT = 20;
export const MAX_EVALUATION_LIST_LIMIT = 100;

export interface EvaluationRequest {
  resumeVersionId: string;
  candidateType: CandidateType;
  jobDescription: string | null;
  idempotencyKey: string;
}

export interface EvaluationDeps {
  db: Database;
  storage: ObjectStorage;
  config: AppConfig;
  parseGate: ParseGate | null;
}

export async function createEvaluation(deps: EvaluationDeps, userId: string, request: EvaluationRequest) {
  const existing = await findByIdempotency(deps.db, userId, request.idempotencyKey);
  if (existing) {
    return existing;
  }

  const version = await ownedVersion(deps.db, userId, request.resumeVersionId);
  if (version.verificationState !== "verified" || version.deletionState !== "active") {
    throw new EvaluationError(409, "NOT_VERIFIED", "The resume version is not verified.");
  }
  const limits = limitsFor(version.mimeType, deps.config);
  if (!limits || !deps.parseGate) {
    throw new EvaluationError(503, "PARSE_LIMITS_UNSET", "Parse limits are not configured.");
  }
  const bytes = await deps.storage.get(version.objectKey);
  if (!bytes) {
    throw new EvaluationError(422, "CORRUPT", "The stored file could not be read.");
  }

  const meta = {
    filename: version.originalFilename,
    mimeType: version.mimeType,
    sourceHash: sha256(bytes),
    metadata: {},
  };
  let document;
  try {
    document = await deps.parseGate.run((gateSignal) => {
      if (limits.kind === "pdf") {
        return extractPdf(bytes, meta, { ...limits.limits, signal: gateSignal });
      }
      return extractDocx(bytes, meta, { ...limits.limits, signal: gateSignal });
    });
  } catch (error) {
    if (error instanceof DocumentAbortError) {
      throw new EvaluationError(499, "REQUEST_ABORTED", "Request was cancelled.");
    }
    if (error instanceof DocumentParseError) {
      const status = error.code === "UNSUPPORTED_TYPE" ? 415 : 422;
      throw new EvaluationError(status, error.code, error.message);
    }
    throw error;
  }

  const ignored = await deps.db
    .select({ normalizedTerm: ignoredTerms.normalizedTerm })
    .from(ignoredTerms)
    .where(eq(ignoredTerms.userId, userId));
  const owner = await deps.db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const result = evaluate(document, {
    candidateType: request.candidateType,
    candidateName: owner[0]?.displayName ?? null,
    jobDescription: request.jobDescription,
    ignoredTerms: ignored.map((row) => row.normalizedTerm),
    spellChecker: getDefaultSpellChecker(),
  });
  if (result.scoreStatus !== "PROVISIONAL") {
    throw new EvaluationError(500, "INTERNAL_ERROR", "Internal error");
  }

  let evaluationId: string;
  try {
    evaluationId = await deps.db.transaction(async (tx) => {
      const jobRows = await tx
        .insert(evaluationJobs)
        .values({
          userId,
          resumeVersionId: version.id,
          status: "succeeded",
          attempts: 1,
          idempotencyKey: request.idempotencyKey,
          startedAt: new Date(),
          finishedAt: new Date(),
        })
        .returning({ id: evaluationJobs.id, status: evaluationJobs.status });
      const job = jobRows[0];
      if (!job) {
        throw new EvaluationError(500, "INTERNAL_ERROR", "Internal error");
      }
      const stored = await insertEvaluation(tx, userId, version.id, job.id, document.parserVersion, result);
      return stored.id;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const replay = await findByIdempotency(deps.db, userId, request.idempotencyKey);
    if (!replay) {
      throw error;
    }
    return replay;
  }
  const loaded = await loadEvaluation(deps.db, userId, evaluationId);
  if (!loaded) {
    throw new EvaluationError(500, "INTERNAL_ERROR", "Internal error");
  }
  return loaded;
}

export async function getEvaluation(db: Database, userId: string, evaluationId: string) {
  const row = await db
    .select({ id: evaluations.id })
    .from(evaluations)
    .where(and(eq(evaluations.id, evaluationId), eq(evaluations.userId, userId)))
    .limit(1);
  if (!row[0]) {
    throw new EvaluationError(404, "NOT_FOUND", "Not found");
  }
  const loaded = await loadEvaluation(db, userId, evaluationId);
  if (!loaded) {
    throw new EvaluationError(404, "NOT_FOUND", "Not found");
  }
  return loaded;
}

export async function getEvaluationJob(db: Database, userId: string, jobId: string) {
  const rows = await db
    .select({
      id: evaluationJobs.id,
      status: evaluationJobs.status,
      errorCode: evaluationJobs.errorCode,
      evaluationId: evaluations.id,
    })
    .from(evaluationJobs)
    .leftJoin(evaluations, eq(evaluations.jobId, evaluationJobs.id))
    .where(and(eq(evaluationJobs.id, jobId), eq(evaluationJobs.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new EvaluationError(404, "NOT_FOUND", "Not found");
  }
  return {
    job: {
      id: row.id,
      status: row.status,
      errorCode: row.errorCode,
      evaluationId: row.evaluationId,
    },
  };
}

export async function listEvaluations(db: Database, userId: string, pagination: { limit?: number; offset?: number }) {
  const limit = normalizeLimit(pagination.limit);
  const offset = normalizeOffset(pagination.offset);
  const rows = await db
    .select({
      id: evaluations.id,
      resumeVersionId: evaluations.resumeVersionId,
      rubricVersion: evaluations.rubricVersion,
      parserVersion: evaluations.parserVersion,
      baseScore: evaluations.baseScore,
      penaltyTotal: evaluations.penaltyTotal,
      finalScore: evaluations.finalScore,
      scoreStatus: evaluations.scoreStatus,
      categoriesJson: evaluations.categoriesJson,
      createdAt: evaluations.createdAt,
    })
    .from(evaluations)
    .innerJoin(resumeVersions, eq(resumeVersions.id, evaluations.resumeVersionId))
    .innerJoin(resumes, eq(resumes.id, resumeVersions.resumeId))
    .where(and(eq(evaluations.userId, userId), isNull(resumes.deletedAt), eq(resumeVersions.deletionState, "active")))
    .orderBy(desc(evaluations.createdAt), desc(evaluations.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  return {
    evaluations: rows.slice(0, limit).map((row) => summaryOf(row)),
    pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null },
  };
}

async function ownedVersion(db: Database, userId: string, resumeVersionId: string) {
  const rows = await db
    .select({
      id: resumeVersions.id,
      mimeType: resumeVersions.mimeType,
      originalFilename: resumeVersions.originalFilename,
      objectKey: resumeVersions.objectKey,
      verificationState: resumeVersions.verificationState,
      deletionState: resumeVersions.deletionState,
    })
    .from(resumeVersions)
    .innerJoin(resumes, eq(resumes.id, resumeVersions.resumeId))
    .where(and(eq(resumeVersions.id, resumeVersionId), eq(resumes.userId, userId), isNull(resumes.deletedAt)))
    .limit(1);
  const version = rows[0];
  if (!version) {
    throw new EvaluationError(404, "NOT_FOUND", "Not found");
  }
  return version;
}

async function findByIdempotency(db: Database, userId: string, idempotencyKey: string) {
  const rows = await db
    .select({ evaluationId: evaluations.id })
    .from(evaluationJobs)
    .innerJoin(evaluations, eq(evaluations.jobId, evaluationJobs.id))
    .where(and(eq(evaluationJobs.userId, userId), eq(evaluationJobs.idempotencyKey, idempotencyKey)))
    .limit(1);
  const evaluationId = rows[0]?.evaluationId;
  if (!evaluationId) {
    return null;
  }
  return loadEvaluation(db, userId, evaluationId);
}

async function loadEvaluation(db: Database, userId: string, evaluationId: string) {
  const rows = await db
    .select({
      id: evaluations.id,
      resumeVersionId: evaluations.resumeVersionId,
      rubricVersion: evaluations.rubricVersion,
      parserVersion: evaluations.parserVersion,
      baseScore: evaluations.baseScore,
      penaltyTotal: evaluations.penaltyTotal,
      finalScore: evaluations.finalScore,
      scoreStatus: evaluations.scoreStatus,
      categoriesJson: evaluations.categoriesJson,
      jdMatchJson: evaluations.jdMatchJson,
      createdAt: evaluations.createdAt,
      jobId: evaluationJobs.id,
      jobStatus: evaluationJobs.status,
    })
    .from(evaluations)
    .innerJoin(evaluationJobs, eq(evaluationJobs.id, evaluations.jobId))
    .where(and(eq(evaluations.id, evaluationId), eq(evaluations.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  const findingRows = await db
    .select({
      id: findings.id,
      ruleId: findings.ruleId,
      category: findings.category,
      severity: findings.severity,
      message: findings.message,
      suggestion: findings.suggestion,
      evidenceJson: findings.evidenceJson,
      confidence: findings.confidence,
    })
    .from(findings)
    .where(eq(findings.evaluationId, evaluationId))
    .orderBy(findings.createdAt, findings.id);
  const categories = categoryRecord(row.categoriesJson);
  return {
    evaluation: {
      id: row.id,
      resumeVersionId: row.resumeVersionId,
      rubricVersion: row.rubricVersion,
      parserVersion: row.parserVersion,
      scoreStatus: row.scoreStatus,
      baseScore: row.baseScore,
      denominator: categories.denominator,
      penaltyTotal: row.penaltyTotal,
      penaltyStatus: categories.penaltyStatus,
      finalScore: row.finalScore,
      criteria: categories.criteria,
      penalties: categories.penalties,
      jdMatch: row.jdMatchJson,
      createdAt: row.createdAt.toISOString(),
    },
    findings: findingRows.map((finding) => ({
      id: finding.id,
      ruleId: finding.ruleId,
      category: finding.category,
      severity: finding.severity,
      message: finding.message,
      suggestion: finding.suggestion,
      confidence: finding.confidence,
      evidence: finding.evidenceJson,
    })),
    job: { id: row.jobId, status: row.jobStatus },
  };
}

async function insertEvaluation(
  tx: Database,
  userId: string,
  resumeVersionId: string,
  jobId: string,
  parserVersion: string,
  result: EvaluationResult,
) {
  const criteria = result.criteria.map((criterion) =>
    criterion.status === "scored"
      ? { ruleId: criterion.ruleId, maxScore: criterion.maxScore, status: criterion.status, score: criterion.score }
      : {
          ruleId: criterion.ruleId,
          maxScore: criterion.maxScore,
          status: criterion.status,
          score: null,
          reasonCode: criterion.reasonCode,
        },
  );
  const inserted = await tx
    .insert(evaluations)
    .values({
      userId,
      resumeVersionId,
      jobId,
      rubricVersion: result.rubricVersion,
      parserVersion,
      baseScore: result.baseScore,
      penaltyTotal: result.penaltyTotal,
      finalScore: result.finalScore,
      scoreStatus: result.scoreStatus,
      categoriesJson: {
        denominator: result.denominator,
        penaltyStatus: result.penaltyStatus,
        penalties: result.penalties,
        criteria,
      },
      jdMatchJson: result.jdMatch,
    })
    .returning({ id: evaluations.id, createdAt: evaluations.createdAt });
  const saved = inserted[0];
  if (!saved) {
    throw new EvaluationError(500, "INTERNAL_ERROR", "Internal error");
  }
  const savedId = saved.id;
  const visibleFindings = result.criteria.flatMap((criterion) => criterion.findings);
  if (visibleFindings.length > 0) {
    await tx.insert(findings).values(
      visibleFindings.map((finding) => ({
        evaluationId: savedId,
        ruleId: finding.ruleId,
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
        suggestion: finding.suggestion ?? null,
        evidenceJson: finding.evidence,
        confidence: finding.confidence,
      })),
    );
  }
  return { id: savedId };
}

function summaryOf(row: {
  id: string;
  resumeVersionId: string;
  rubricVersion: string;
  scoreStatus: string;
  baseScore: number | null;
  penaltyTotal: number | null;
  finalScore: number | null;
  categoriesJson: unknown;
  createdAt: Date;
}) {
  const categories = categoryRecord(row.categoriesJson);
  return {
    id: row.id,
    resumeVersionId: row.resumeVersionId,
    rubricVersion: row.rubricVersion,
    scoreStatus: row.scoreStatus,
    baseScore: row.baseScore,
    denominator: categories.denominator,
    penaltyTotal: row.penaltyTotal,
    penaltyStatus: categories.penaltyStatus,
    finalScore: row.finalScore,
    createdAt: row.createdAt.toISOString(),
  };
}

function categoryRecord(value: unknown): {
  denominator: number;
  penaltyStatus: string;
  penalties: unknown;
  criteria: unknown;
} {
  if (typeof value === "object" && value !== null && "denominator" in value && "penaltyStatus" in value) {
    const record = value as { denominator: unknown; penaltyStatus: unknown; penalties?: unknown; criteria?: unknown };
    return {
      denominator: typeof record.denominator === "number" ? record.denominator : 0,
      penaltyStatus: typeof record.penaltyStatus === "string" ? record.penaltyStatus : "not_evaluated",
      penalties: record.penalties ?? [],
      criteria: record.criteria ?? [],
    };
  }
  return { denominator: 0, penaltyStatus: "not_evaluated", penalties: [], criteria: [] };
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
  if (mimeType !== DOCX_MIME || config.docxEntryCap === null || config.docxUncompressedBytes === null) {
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

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_EVALUATION_LIST_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVALUATION_LIST_LIMIT) {
    throw new EvaluationError(400, "VALIDATION_ERROR", "Invalid request");
  }
  return limit;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new EvaluationError(400, "VALIDATION_ERROR", "Invalid request");
  }
  return offset;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
