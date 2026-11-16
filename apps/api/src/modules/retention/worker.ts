import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import {
  auditEvents,
  evaluationJobs,
  evaluations,
  findings,
  resumes,
  resumeVersions,
  retentionTasks,
} from "../../infrastructure/db/schema.js";
import type { ObjectStorage } from "../../infrastructure/storage/memory.js";

export const DEFAULT_RETENTION_LEASE_MS = 60_000;
export const DEFAULT_RETENTION_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_RETENTION_MAX_BACKOFF_MS = 60 * 60 * 1000;
export const DEFAULT_RETENTION_MAX_ATTEMPTS = 8;
export const DEFAULT_PRODUCTION_RETENTION_POLL_MS = 5 * 60 * 1000;

const DUE_STATES = ["pending", "retryable_failure"] as const;
const OPEN_TASK_STATES = ["pending", "running", "retryable_failure"] as const;
const EXPIRED_BATCH_SIZE = 100;

export interface RetentionLogger {
  info?: (bindings: Record<string, unknown>, msg?: string) => void;
  warn: (bindings: Record<string, unknown>, msg?: string) => void;
  error: (bindings: Record<string, unknown>, msg?: string) => void;
}

export interface PermanentRetentionFailure {
  taskId: string;
  resumeVersionId: string;
  attempts: number;
  maxAttempts: number;
  errorCode: string;
}

export interface RetentionDeps {
  db: Database;
  storage: ObjectStorage;
  logger?: RetentionLogger;
}

export interface RetentionPassOptions {
  now?: Date;
  workerId?: string;
  leaseMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAttempts?: number;
  maxTasks?: number;
  random?: () => number;
  onPermanentFailure?: (failure: PermanentRetentionFailure) => void;
}

export interface RetentionPassResult {
  workerId: string;
  expiredEnqueued: number;
  processed: number;
  succeeded: number;
  retried: number;
  permanentlyFailed: number;
}

export interface RetentionBacklogSummary {
  pending: number;
  running: number;
  retryableFailure: number;
  permanentlyFailed: number;
}

export interface RetentionSchedulerHandle {
  readonly workerId: string;
  stop(): Promise<void>;
}

/**
 * Computes bounded exponential backoff with equal jitter in `[ceil(cap/2), cap]`.
 * Guarantees positive delay (`>= 1 ms`) and strict upper bound `<= maxBackoffMs`.
 */
export function computeRetentionBackoffMs(
  attempt: number,
  options: {
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    random?: () => number;
  } = {},
): number {
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_RETENTION_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_RETENTION_MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;

  if (!Number.isInteger(baseBackoffMs) || baseBackoffMs < 1) {
    throw new Error("baseBackoffMs must be a positive integer");
  }
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < baseBackoffMs) {
    throw new Error("maxBackoffMs must be an integer >= baseBackoffMs");
  }

  const exponent = Math.min(30, Math.max(0, Math.trunc(attempt) - 1));
  const rawExponential = baseBackoffMs * 2 ** exponent;
  const capped = Math.min(maxBackoffMs, rawExponential);
  const floorHalf = Math.max(1, Math.floor(capped / 2));
  const sample = Math.min(0.999999999999, Math.max(0, random()));
  const jitterSpan = capped - floorHalf + 1;
  const delay = floorHalf + Math.floor(sample * jitterSpan);
  return Math.min(maxBackoffMs, Math.max(1, delay));
}

export async function getRetentionBacklogSummary(db: Database): Promise<RetentionBacklogSummary> {
  const rows = await db
    .select({
      state: retentionTasks.state,
      total: count(),
    })
    .from(retentionTasks)
    .groupBy(retentionTasks.state);

  const summary: RetentionBacklogSummary = {
    pending: 0,
    running: 0,
    retryableFailure: 0,
    permanentlyFailed: 0,
  };

  for (const row of rows) {
    const value = Number(row.total);
    if (row.state === "pending") {
      summary.pending = value;
    } else if (row.state === "running") {
      summary.running = value;
    } else if (row.state === "retryable_failure") {
      summary.retryableFailure = value;
    } else if (row.state === "failed") {
      summary.permanentlyFailed = value;
    }
  }

  return summary;
}

export async function runRetentionPass(
  deps: RetentionDeps,
  options: RetentionPassOptions = {},
): Promise<RetentionPassResult> {
  const leaseMs = options.leaseMs ?? DEFAULT_RETENTION_LEASE_MS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_RETENTION_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_RETENTION_MAX_BACKOFF_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETENTION_MAX_ATTEMPTS;
  const maxTasks = options.maxTasks ?? Number.POSITIVE_INFINITY;
  const workerId = options.workerId ?? `retention-worker-${randomUUID()}`;

  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new Error("leaseMs must be a positive integer");
  }
  if (!Number.isInteger(baseBackoffMs) || baseBackoffMs < 1) {
    throw new Error("baseBackoffMs must be a positive integer");
  }
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < baseBackoffMs) {
    throw new Error("maxBackoffMs must be an integer >= baseBackoffMs");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (maxTasks !== Number.POSITIVE_INFINITY && (!Number.isInteger(maxTasks) || maxTasks < 1)) {
    throw new Error("maxTasks must be a positive integer");
  }

  const currentNow = (): Date => options.now ?? new Date();
  const expiredEnqueued = await enqueueExpiredVersions(deps.db, currentNow());

  const seen = new Set<string>();
  let processed = 0;
  let succeeded = 0;
  let retried = 0;
  let permanentlyFailed = 0;

  while (processed < maxTasks) {
    const stepNow = currentNow();
    const claim = await claimTask(deps.db, stepNow, workerId, leaseMs, maxAttempts, seen);
    if (claim.kind === "none") {
      break;
    }

    seen.add(claim.task.id);
    processed += 1;

    if (claim.kind === "expired_exhausted") {
      permanentlyFailed += 1;
      reportPermanentFailure(deps.logger, options.onPermanentFailure, {
        taskId: claim.task.id,
        resumeVersionId: claim.task.resumeVersionId,
        attempts: claim.task.attempts,
        maxAttempts,
        errorCode: "LEASE_EXPIRED_MAX_ATTEMPTS",
      });
      continue;
    }

    const outcome = await purgeTask(deps, claim.task, {
      now: stepNow,
      workerId,
      baseBackoffMs,
      maxBackoffMs,
      maxAttempts,
      ...(options.random ? { random: options.random } : {}),
      ...(options.onPermanentFailure ? { onPermanentFailure: options.onPermanentFailure } : {}),
    });

    if (outcome === "succeeded") {
      succeeded += 1;
    } else if (outcome === "retried") {
      retried += 1;
    } else if (outcome === "failed") {
      permanentlyFailed += 1;
    }
  }

  return {
    workerId,
    expiredEnqueued,
    processed,
    succeeded,
    retried,
    permanentlyFailed,
  };
}

export function startRetentionScheduler(
  deps: RetentionDeps,
  config: {
    pollMs: number;
    leaseMs?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    maxAttempts?: number;
    workerId?: string;
    runOnStart?: boolean;
  },
): RetentionSchedulerHandle {
  if (!Number.isInteger(config.pollMs) || config.pollMs < 1) {
    throw new Error("Retention scheduler pollMs must be a positive integer");
  }

  const workerId = config.workerId ?? `retention-scheduler-${randomUUID()}`;
  let stopped = false;
  let activeRun: Promise<void> | null = null;

  const executeTick = (): Promise<void> => {
    if (stopped || activeRun !== null) {
      return activeRun ?? Promise.resolve();
    }

    const run = (async () => {
      try {
        const result = await runRetentionPass(deps, {
          workerId,
          ...(config.leaseMs !== undefined ? { leaseMs: config.leaseMs } : {}),
          ...(config.baseBackoffMs !== undefined ? { baseBackoffMs: config.baseBackoffMs } : {}),
          ...(config.maxBackoffMs !== undefined ? { maxBackoffMs: config.maxBackoffMs } : {}),
          ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
        });

        const backlog = await getRetentionBacklogSummary(deps.db);
        if (backlog.permanentlyFailed > 0) {
          deps.logger?.error(
            {
              event: "retention.dead_letter_backlog",
              workerId,
              permanentlyFailed: backlog.permanentlyFailed,
              retryableFailure: backlog.retryableFailure,
              pending: backlog.pending,
            },
            "permanently failed retention tasks require operator attention",
          );
        } else if (result.processed > 0 || result.expiredEnqueued > 0) {
          deps.logger?.info?.(
            {
              event: "retention.pass_completed",
              workerId,
              expiredEnqueued: result.expiredEnqueued,
              succeeded: result.succeeded,
              retried: result.retried,
            },
            "retention pass completed",
          );
        }
      } catch (error) {
        deps.logger?.error(
          { event: "retention.pass_error", workerId, err: error },
          "retention pass failed unexpectedly",
        );
      } finally {
        activeRun = null;
      }
    })();

    activeRun = run;
    return run;
  };

  if (config.runOnStart !== false) {
    void executeTick();
  }

  const timer = setInterval(() => {
    void executeTick();
  }, config.pollMs);
  timer.unref();

  return {
    workerId,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (activeRun) {
        await activeRun;
      }
    },
  };
}

async function enqueueExpiredVersions(db: Database, now: Date): Promise<number> {
  let totalEnqueued = 0;

  for (;;) {
    const batchCount = await db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: resumeVersions.id, resumeId: resumeVersions.resumeId })
        .from(resumeVersions)
        .where(and(eq(resumeVersions.deletionState, "active"), lte(resumeVersions.expiresAt, now)))
        .limit(EXPIRED_BATCH_SIZE)
        .for("update", { skipLocked: true });

      if (candidates.length === 0) {
        return 0;
      }

      const candidateIds = candidates.map((row) => row.id);
      const transitioned = await tx
        .update(resumeVersions)
        .set({ deletionState: "delete_requested" })
        .where(
          and(
            inArray(resumeVersions.id, candidateIds),
            eq(resumeVersions.deletionState, "active"),
          ),
        )
        .returning({ id: resumeVersions.id, resumeId: resumeVersions.resumeId });

      if (transitioned.length === 0) {
        return 0;
      }

      const transitionedIds = transitioned.map((row) => row.id);
      const open = await tx
        .select({ resumeVersionId: retentionTasks.resumeVersionId })
        .from(retentionTasks)
        .where(
          and(
            inArray(retentionTasks.resumeVersionId, transitionedIds),
            inArray(retentionTasks.state, [...OPEN_TASK_STATES]),
          ),
        );
      const queued = new Set(open.map((row) => row.resumeVersionId));

      let insertedCount = 0;
      for (const versionId of transitionedIds) {
        if (!queued.has(versionId)) {
          await tx.insert(retentionTasks).values({
            resumeVersionId: versionId,
            state: "pending",
            attempts: 0,
            nextAttemptAt: now,
          });
          insertedCount += 1;
        }
      }

      const resumeIds = [...new Set(transitioned.map((row) => row.resumeId))];
      for (const resumeId of resumeIds) {
        await tx
          .select({ id: resumes.id })
          .from(resumes)
          .where(eq(resumes.id, resumeId))
          .for("update");

        const active = await tx
          .select({ id: resumeVersions.id })
          .from(resumeVersions)
          .where(
            and(
              eq(resumeVersions.resumeId, resumeId),
              eq(resumeVersions.deletionState, "active"),
            ),
          )
          .limit(1);

        if (active.length === 0) {
          await tx
            .update(resumes)
            .set({
              deletedAt: now,
              updatedAt: now,
              title: "deleted",
              candidateType: null,
            })
            .where(eq(resumes.id, resumeId));
        }
      }

      return insertedCount;
    });

    totalEnqueued += batchCount;
    if (batchCount < EXPIRED_BATCH_SIZE) {
      break;
    }
  }

  return totalEnqueued;
}

type ClaimOutcome =
  | { kind: "none" }
  | {
      kind: "expired_exhausted";
      task: { id: string; resumeVersionId: string; attempts: number };
    }
  | {
      kind: "claimed";
      task: { id: string; resumeVersionId: string; attempts: number };
    };

async function claimTask(
  db: Database,
  now: Date,
  workerId: string,
  leaseMs: number,
  maxAttempts: number,
  seen: Set<string>,
): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    const dueOrExpiredCondition = or(
      and(
        inArray(retentionTasks.state, [...DUE_STATES]),
        lte(retentionTasks.nextAttemptAt, now),
      ),
      and(
        eq(retentionTasks.state, "running"),
        or(isNull(retentionTasks.leaseUntil), lte(retentionTasks.leaseUntil, now)),
      ),
    );

    const rows = await tx
      .select({
        id: retentionTasks.id,
        resumeVersionId: retentionTasks.resumeVersionId,
        state: retentionTasks.state,
        attempts: retentionTasks.attempts,
      })
      .from(retentionTasks)
      .where(
        and(
          dueOrExpiredCondition,
          seen.size > 0 ? notInArray(retentionTasks.id, [...seen]) : undefined,
        ),
      )
      .orderBy(asc(retentionTasks.nextAttemptAt), asc(retentionTasks.id))
      .limit(1)
      .for("update", { skipLocked: true });

    const candidate = rows[0];
    if (!candidate) {
      return { kind: "none" };
    }

    if (candidate.attempts >= maxAttempts) {
      await tx
        .update(retentionTasks)
        .set({
          state: "failed",
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode:
            candidate.state === "running"
              ? "LEASE_EXPIRED_MAX_ATTEMPTS"
              : "MAX_ATTEMPTS_EXCEEDED",
        })
        .where(eq(retentionTasks.id, candidate.id));

      await tx.insert(auditEvents).values({
        userId: null,
        eventType: "retention_task_failed",
        targetId: candidate.resumeVersionId,
        safeMetadata: {
          attempts: candidate.attempts,
          errorCode:
            candidate.state === "running"
              ? "LEASE_EXPIRED_MAX_ATTEMPTS"
              : "MAX_ATTEMPTS_EXCEEDED",
        },
      });

      return {
        kind: "expired_exhausted",
        task: {
          id: candidate.id,
          resumeVersionId: candidate.resumeVersionId,
          attempts: candidate.attempts,
        },
      };
    }

    const nextAttemptNumber = candidate.attempts + 1;
    const leaseUntil = new Date(now.getTime() + leaseMs);

    await tx
      .update(retentionTasks)
      .set({
        state: "running",
        attempts: nextAttemptNumber,
        leaseOwner: workerId,
        leaseUntil,
      })
      .where(eq(retentionTasks.id, candidate.id));

    return {
      kind: "claimed",
      task: {
        id: candidate.id,
        resumeVersionId: candidate.resumeVersionId,
        attempts: nextAttemptNumber,
      },
    };
  });
}

async function purgeTask(
  deps: RetentionDeps,
  task: { id: string; resumeVersionId: string; attempts: number },
  context: {
    now: Date;
    workerId: string;
    baseBackoffMs: number;
    maxBackoffMs: number;
    maxAttempts: number;
    random?: () => number;
    onPermanentFailure?: (failure: PermanentRetentionFailure) => void;
  },
): Promise<"succeeded" | "retried" | "failed" | "fenced"> {
  const versions = await deps.db
    .select({
      id: resumeVersions.id,
      objectKey: resumeVersions.objectKey,
      resumeId: resumeVersions.resumeId,
      deletionState: resumeVersions.deletionState,
    })
    .from(resumeVersions)
    .where(eq(resumeVersions.id, task.resumeVersionId))
    .limit(1);

  const version = versions[0];
  if (!version) {
    const updated = await deps.db
      .update(retentionTasks)
      .set({
        state: "succeeded",
        completedAt: context.now,
        leaseOwner: null,
        leaseUntil: null,
        lastErrorCode: null,
      })
      .where(
        and(
          eq(retentionTasks.id, task.id),
          eq(retentionTasks.state, "running"),
          eq(retentionTasks.leaseOwner, context.workerId),
        ),
      )
      .returning({ id: retentionTasks.id });
    return updated.length > 0 ? "succeeded" : "fenced";
  }

  try {
    await deps.storage.delete(version.objectKey);
  } catch {
    return handleTaskError(deps, task, version.id, context, "STORAGE_DELETE_FAILED");
  }

  try {
    const committed = await deps.db.transaction(async (tx) => {
      const leaseCheck = await tx
        .select({ id: retentionTasks.id })
        .from(retentionTasks)
        .where(
          and(
            eq(retentionTasks.id, task.id),
            eq(retentionTasks.state, "running"),
            eq(retentionTasks.leaseOwner, context.workerId),
          ),
        )
        .for("update")
        .limit(1);

      if (leaseCheck.length === 0) {
        return false;
      }

      const evaluationRows = await tx
        .select({ id: evaluations.id })
        .from(evaluations)
        .where(eq(evaluations.resumeVersionId, version.id));
      const evaluationIds = evaluationRows.map((row) => row.id);
      if (evaluationIds.length > 0) {
        await tx.delete(findings).where(inArray(findings.evaluationId, evaluationIds));
      }
      await tx.delete(evaluations).where(eq(evaluations.resumeVersionId, version.id));
      await tx.delete(evaluationJobs).where(eq(evaluationJobs.resumeVersionId, version.id));

      await tx
        .update(resumeVersions)
        .set({
          deletionState: "deleted",
          originalFilename: "deleted",
          sha256: "deleted",
          sizeBytes: 0,
          parserVersion: null,
        })
        .where(eq(resumeVersions.id, version.id));

      const activeSiblings = await tx
        .select({ id: resumeVersions.id })
        .from(resumeVersions)
        .where(
          and(
            eq(resumeVersions.resumeId, version.resumeId),
            eq(resumeVersions.deletionState, "active"),
          ),
        )
        .limit(1);

      if (activeSiblings.length === 0) {
        const parentRows = await tx
          .select({ deletedAt: resumes.deletedAt })
          .from(resumes)
          .where(eq(resumes.id, version.resumeId))
          .for("update")
          .limit(1);
        const parent = parentRows[0];
        if (parent) {
          await tx
            .update(resumes)
            .set({
              deletedAt: parent.deletedAt ?? context.now,
              updatedAt: context.now,
              title: "deleted",
              candidateType: null,
            })
            .where(eq(resumes.id, version.resumeId));
        }
      }

      await tx
        .update(retentionTasks)
        .set({
          state: "succeeded",
          completedAt: context.now,
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: null,
        })
        .where(eq(retentionTasks.id, task.id));

      if (version.deletionState !== "deleted") {
        await tx.insert(auditEvents).values({
          userId: null,
          eventType: "resume_version_purged",
          targetId: version.id,
          safeMetadata: {},
        });
      }

      return true;
    });

    return committed ? "succeeded" : "fenced";
  } catch {
    return handleTaskError(deps, task, version.id, context, "DB_PURGE_FAILED");
  }
}

async function handleTaskError(
  deps: RetentionDeps,
  task: { id: string; resumeVersionId: string; attempts: number },
  versionId: string,
  context: {
    now: Date;
    workerId: string;
    baseBackoffMs: number;
    maxBackoffMs: number;
    maxAttempts: number;
    random?: () => number;
    onPermanentFailure?: (failure: PermanentRetentionFailure) => void;
  },
  errorCode: string,
): Promise<"retried" | "failed" | "fenced"> {
  if (task.attempts >= context.maxAttempts) {
    const markedFailed = await deps.db.transaction(async (tx) => {
      const updated = await tx
        .update(retentionTasks)
        .set({
          state: "failed",
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: errorCode,
        })
        .where(
          and(
            eq(retentionTasks.id, task.id),
            eq(retentionTasks.state, "running"),
            eq(retentionTasks.leaseOwner, context.workerId),
          ),
        )
        .returning({ id: retentionTasks.id });

      if (updated.length === 0) {
        return false;
      }

      await tx.insert(auditEvents).values({
        userId: null,
        eventType: "retention_task_failed",
        targetId: versionId,
        safeMetadata: {
          attempts: task.attempts,
          errorCode,
        },
      });

      return true;
    });

    if (!markedFailed) {
      return "fenced";
    }

    reportPermanentFailure(deps.logger, context.onPermanentFailure, {
      taskId: task.id,
      resumeVersionId: versionId,
      attempts: task.attempts,
      maxAttempts: context.maxAttempts,
      errorCode,
    });
    return "failed";
  }

  const backoffMs = computeRetentionBackoffMs(task.attempts, {
    baseBackoffMs: context.baseBackoffMs,
    maxBackoffMs: context.maxBackoffMs,
    ...(context.random ? { random: context.random } : {}),
  });
  const nextAttemptAt = new Date(context.now.getTime() + backoffMs);

  const updated = await deps.db
    .update(retentionTasks)
    .set({
      state: "retryable_failure",
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt,
      lastErrorCode: errorCode,
    })
    .where(
      and(
        eq(retentionTasks.id, task.id),
        eq(retentionTasks.state, "running"),
        eq(retentionTasks.leaseOwner, context.workerId),
      ),
    )
    .returning({ id: retentionTasks.id });

  if (updated.length === 0) {
    return "fenced";
  }

  deps.logger?.warn(
    {
      event: "retention.retry_scheduled",
      taskId: task.id,
      resumeVersionId: versionId,
      attempts: task.attempts,
      maxAttempts: context.maxAttempts,
      backoffMs,
      nextAttemptAt: nextAttemptAt.toISOString(),
      errorCode,
    },
    "retention task scheduled for retry with exponential backoff",
  );
  return "retried";
}

function reportPermanentFailure(
  logger: RetentionLogger | undefined,
  callback: ((failure: PermanentRetentionFailure) => void) | undefined,
  failure: PermanentRetentionFailure,
): void {
  logger?.error(
    {
      event: "retention.permanent_failure",
      taskId: failure.taskId,
      resumeVersionId: failure.resumeVersionId,
      attempts: failure.attempts,
      maxAttempts: failure.maxAttempts,
      errorCode: failure.errorCode,
    },
    "retention task exhausted maximum retry attempts",
  );
  callback?.(failure);
}
