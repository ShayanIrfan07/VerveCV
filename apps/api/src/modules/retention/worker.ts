import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
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
export const PURGED_OBJECT_KEY_PREFIX = "purged_";

const DUE_STATES = ["pending", "retryable_failure"] as const;
const OPEN_TASK_STATES = ["pending", "running", "retryable_failure"] as const;
const EXPIRED_BATCH_SIZE = 100;

export class RetentionStorageTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Object storage delete timed out after ${timeoutMs}ms`);
    this.name = "RetentionStorageTimeoutError";
  }
}

export class RetentionLeaseLostError extends Error {
  constructor() {
    super("Retention task lease was lost or reclaimed by another worker");
    this.name = "RetentionLeaseLostError";
  }
}

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
  clock?: () => Date;
  workerId?: string;
  leaseMs?: number;
  storageDeleteTimeoutMs?: number;
  leaseRenewIntervalMs?: number | null;
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

export interface RequeueFailedTasksOptions {
  taskIds?: readonly string[];
  limit?: number;
  now?: Date;
  dryRun?: boolean;
  logger?: RetentionLogger;
}

export interface RequeueFailedTasksResult {
  dryRun: boolean;
  requeuedCount: number;
  taskIds: string[];
}

export interface RetentionSchedulerHandle {
  readonly workerId: string;
  readonly pollMs: number;
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

/**
 * Safely requeues permanently failed (`state = 'failed'`) retention tasks for operator
 * recovery after fixing an underlying R2 credential, bucket policy, or network outage.
 *
 * Resets `state = 'pending'`, `attempts = 0`, `lease_owner = null`, `lease_until = null`,
 * and `last_error_code = null` under `FOR UPDATE SKIP LOCKED`, and records a minimal
 * non-PII `retention_task_requeued` audit event per requeued version.
 */
export async function requeueFailedRetentionTasks(
  db: Database,
  options: RequeueFailedTasksOptions = {},
): Promise<RequeueFailedTasksResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const dryRun = options.dryRun === true;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (options.taskIds !== undefined && options.taskIds.length === 0) {
    return { dryRun, requeuedCount: 0, taskIds: [] };
  }

  const requeued = await db.transaction(async (tx) => {
    const conditions = [eq(retentionTasks.state, "failed")];
    if (options.taskIds !== undefined) {
      conditions.push(inArray(retentionTasks.id, [...options.taskIds]));
    }

    if (dryRun) {
      return tx
        .select({
          id: retentionTasks.id,
          resumeVersionId: retentionTasks.resumeVersionId,
          previousAttempts: retentionTasks.attempts,
          previousErrorCode: retentionTasks.lastErrorCode,
        })
        .from(retentionTasks)
        .where(and(...conditions))
        .orderBy(asc(retentionTasks.nextAttemptAt), asc(retentionTasks.id))
        .limit(limit);
    }

    const targets = await tx
      .select({
        id: retentionTasks.id,
        resumeVersionId: retentionTasks.resumeVersionId,
        previousAttempts: retentionTasks.attempts,
        previousErrorCode: retentionTasks.lastErrorCode,
      })
      .from(retentionTasks)
      .where(and(...conditions))
      .orderBy(asc(retentionTasks.nextAttemptAt), asc(retentionTasks.id))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (targets.length === 0) {
      return [];
    }

    const targetIds = targets.map((row) => row.id);
    await tx
      .update(retentionTasks)
      .set({
        state: "pending",
        attempts: 0,
        leaseOwner: null,
        leaseUntil: null,
        nextAttemptAt: now,
        lastErrorCode: null,
      })
      .where(and(inArray(retentionTasks.id, targetIds), eq(retentionTasks.state, "failed")));

    await tx.insert(auditEvents).values(
      targets.map((row) => ({
        userId: null,
        eventType: "retention_task_requeued",
        targetId: row.resumeVersionId,
        safeMetadata: {
          previousAttempts: row.previousAttempts,
          previousErrorCode: row.previousErrorCode,
        },
      })),
    );

    return targets;
  });

  if (requeued.length > 0 && !dryRun) {
    options.logger?.info?.(
      {
        event: "retention.tasks_requeued",
        requeuedCount: requeued.length,
      },
      "requeued permanently failed retention tasks",
    );
  }

  return {
    dryRun,
    requeuedCount: requeued.length,
    taskIds: requeued.map((row) => row.id),
  };
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
  const defaultDeleteTimeoutMs = Math.max(1, Math.min(30_000, Math.floor(leaseMs * 0.8)));
  const storageDeleteTimeoutMs = options.storageDeleteTimeoutMs ?? defaultDeleteTimeoutMs;
  if (!Number.isInteger(storageDeleteTimeoutMs) || storageDeleteTimeoutMs < 1) {
    throw new Error("storageDeleteTimeoutMs must be a positive integer");
  }
  const defaultRenewMs = leaseMs >= 30 ? Math.max(10, Math.floor(leaseMs / 3)) : null;
  const leaseRenewIntervalMs =
    options.leaseRenewIntervalMs === undefined ? defaultRenewMs : options.leaseRenewIntervalMs;
  if (
    leaseRenewIntervalMs !== null &&
    (!Number.isInteger(leaseRenewIntervalMs) || leaseRenewIntervalMs < 1)
  ) {
    throw new Error("leaseRenewIntervalMs must be a positive integer or null");
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

  const currentNow = (): Date => (options.clock ? options.clock() : (options.now ?? new Date()));
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
      currentNow,
      workerId,
      leaseMs,
      storageDeleteTimeoutMs,
      leaseRenewIntervalMs,
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
    storageDeleteTimeoutMs?: number;
    leaseRenewIntervalMs?: number | null;
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
          ...(config.storageDeleteTimeoutMs !== undefined
            ? { storageDeleteTimeoutMs: config.storageDeleteTimeoutMs }
            : {}),
          ...(config.leaseRenewIntervalMs !== undefined
            ? { leaseRenewIntervalMs: config.leaseRenewIntervalMs }
            : {}),
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
    pollMs: config.pollMs,
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
    const batch = await db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: resumeVersions.id, resumeId: resumeVersions.resumeId })
        .from(resumeVersions)
        .where(and(eq(resumeVersions.deletionState, "active"), lte(resumeVersions.expiresAt, now)))
        .orderBy(asc(resumeVersions.expiresAt), asc(resumeVersions.id))
        .limit(EXPIRED_BATCH_SIZE)
        .for("update", { skipLocked: true });

      if (candidates.length === 0) {
        return { selectedCount: 0, insertedCount: 0 };
      }

      const candidateIds = candidates.map((row) => row.id);
      const transitioned = await tx
        .update(resumeVersions)
        .set({
          deletionState: "delete_requested",
          originalFilename: "deleted",
        })
        .where(
          and(
            inArray(resumeVersions.id, candidateIds),
            eq(resumeVersions.deletionState, "active"),
          ),
        )
        .returning({ id: resumeVersions.id, resumeId: resumeVersions.resumeId });

      if (transitioned.length === 0) {
        return { selectedCount: candidates.length, insertedCount: 0 };
      }

      const transitionedIds = transitioned.map((row) => row.id);
      const existingTasks = await tx
        .select({
          id: retentionTasks.id,
          resumeVersionId: retentionTasks.resumeVersionId,
          state: retentionTasks.state,
        })
        .from(retentionTasks)
        .where(inArray(retentionTasks.resumeVersionId, transitionedIds))
        .for("update");

      const openVersionIds = new Set(
        existingTasks
          .filter((row) =>
            OPEN_TASK_STATES.includes(row.state as (typeof OPEN_TASK_STATES)[number]),
          )
          .map((row) => row.resumeVersionId),
      );
      const failedTaskByVersion = new Map(
        existingTasks
          .filter((row) => row.state === "failed")
          .map((row) => [row.resumeVersionId, row.id]),
      );

      let insertedCount = 0;
      for (const versionId of transitionedIds) {
        if (openVersionIds.has(versionId)) {
          continue;
        }
        const failedTaskId = failedTaskByVersion.get(versionId);
        if (failedTaskId !== undefined) {
          await tx
            .update(retentionTasks)
            .set({
              state: "pending",
              attempts: 0,
              leaseOwner: null,
              leaseUntil: null,
              nextAttemptAt: now,
              lastErrorCode: null,
            })
            .where(eq(retentionTasks.id, failedTaskId));
          insertedCount += 1;
          continue;
        }
        await tx.insert(retentionTasks).values({
          resumeVersionId: versionId,
          state: "pending",
          attempts: 0,
          nextAttemptAt: now,
        });
        insertedCount += 1;
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

      return { selectedCount: candidates.length, insertedCount };
    });

    totalEnqueued += batch.insertedCount;
    if (batch.selectedCount < EXPIRED_BATCH_SIZE) {
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
      const errorCode =
        candidate.state === "running"
          ? "LEASE_EXPIRED_MAX_ATTEMPTS"
          : "MAX_ATTEMPTS_EXCEEDED";

      await tx
        .update(retentionTasks)
        .set({
          state: "failed",
          leaseOwner: null,
          leaseUntil: null,
          lastErrorCode: errorCode,
        })
        .where(eq(retentionTasks.id, candidate.id));

      await tx.insert(auditEvents).values({
        userId: null,
        eventType: "retention_task_failed",
        targetId: candidate.resumeVersionId,
        safeMetadata: {
          attempts: candidate.attempts,
          errorCode,
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

function ownerAttemptFence(taskId: string, workerId: string, attempts: number) {
  return and(
    eq(retentionTasks.id, taskId),
    eq(retentionTasks.state, "running"),
    eq(retentionTasks.leaseOwner, workerId),
    eq(retentionTasks.attempts, attempts),
  );
}

/**
 * Extends an active task lease ONLY while `(id, state = 'running', lease_owner, attempts)`
 * still match AND `lease_until > now`. If `lease_until` has already passed (e.g., a delayed
 * heartbeat firing after an event-loop stall), renewal returns `false` so the worker aborts
 * immediately instead of resurrecting an expired lease that another worker can reclaim.
 */
export async function renewTaskLease(
  db: Database,
  task: { id: string; attempts: number },
  workerId: string,
  now: Date,
  leaseUntil: Date,
): Promise<boolean> {
  const renewed = await db
    .update(retentionTasks)
    .set({ leaseUntil })
    .where(
      and(
        ownerAttemptFence(task.id, workerId, task.attempts),
        gt(retentionTasks.leaseUntil, now),
      ),
    )
    .returning({ id: retentionTasks.id });
  return renewed.length > 0;
}

async function deleteObjectWithLeaseProtection(
  deps: RetentionDeps,
  objectKey: string,
  task: { id: string; attempts: number },
  context: {
    currentNow: () => Date;
    workerId: string;
    leaseMs: number;
    storageDeleteTimeoutMs: number;
    leaseRenewIntervalMs: number | null;
  },
): Promise<void> {
  // Already scrubbed placeholder keys require no R2 network call.
  if (objectKey.startsWith(PURGED_OBJECT_KEY_PREFIX)) {
    return;
  }

  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let renewInFlight = false;
  let leaseLost = false;
  let rejectLeaseLost: ((error: Error) => void) | null = null;

  const leaseLostPromise = new Promise<never>((_, reject) => {
    rejectLeaseLost = reject;
  });

  if (context.leaseRenewIntervalMs !== null) {
    renewTimer = setInterval(() => {
      if (renewInFlight || abortController.signal.aborted) {
        return;
      }
      renewInFlight = true;
      const renewNow = context.currentNow();
      const nextLeaseUntil = new Date(renewNow.getTime() + context.leaseMs);
      void renewTaskLease(deps.db, task, context.workerId, renewNow, nextLeaseUntil)
        .then((stillOwned) => {
          if (!stillOwned && !abortController.signal.aborted) {
            leaseLost = true;
            abortController.abort();
            rejectLeaseLost?.(new RetentionLeaseLostError());
          }
        })
        .catch((error: unknown) => {
          deps.logger?.warn(
            { event: "retention.lease_renew_failed", taskId: task.id, err: error },
            "failed to extend retention task lease during storage delete",
          );
        })
        .finally(() => {
          renewInFlight = false;
        });
    }, context.leaseRenewIntervalMs);
    renewTimer.unref();
  }

  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      reject(new RetentionStorageTimeoutError(context.storageDeleteTimeoutMs));
    }, context.storageDeleteTimeoutMs);
    timeoutHandle.unref();
  });

  try {
    await Promise.race([
      deps.storage.delete(objectKey, { signal: abortController.signal }),
      timeoutPromise,
      leaseLostPromise,
    ]);
  } catch (error) {
    if (leaseLost) {
      throw new RetentionLeaseLostError();
    }
    if (timedOut) {
      throw new RetentionStorageTimeoutError(context.storageDeleteTimeoutMs);
    }
    throw error;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    if (renewTimer !== undefined) {
      clearInterval(renewTimer);
    }
  }
}

async function purgeTask(
  deps: RetentionDeps,
  task: { id: string; resumeVersionId: string; attempts: number },
  context: {
    currentNow: () => Date;
    workerId: string;
    leaseMs: number;
    storageDeleteTimeoutMs: number;
    leaseRenewIntervalMs: number | null;
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
    const commitNow = context.currentNow();
    const updated = await deps.db
      .update(retentionTasks)
      .set({
        state: "succeeded",
        completedAt: commitNow,
        leaseOwner: null,
        leaseUntil: null,
        lastErrorCode: null,
      })
      .where(ownerAttemptFence(task.id, context.workerId, task.attempts))
      .returning({ id: retentionTasks.id });
    return updated.length > 0 ? "succeeded" : "fenced";
  }

  try {
    await deleteObjectWithLeaseProtection(deps, version.objectKey, task, context);
  } catch (error) {
    if (error instanceof RetentionLeaseLostError) {
      return "fenced";
    }
    const errorCode =
      error instanceof RetentionStorageTimeoutError
        ? "STORAGE_DELETE_TIMEOUT"
        : "STORAGE_DELETE_FAILED";
    return handleTaskError(deps, task, version.id, context, errorCode);
  }

  try {
    const commitNow = context.currentNow();
    const committed = await deps.db.transaction(async (tx) => {
      const leaseCheck = await tx
        .select({ id: retentionTasks.id })
        .from(retentionTasks)
        .where(ownerAttemptFence(task.id, context.workerId, task.attempts))
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
          objectKey: `${PURGED_OBJECT_KEY_PREFIX}${version.id}`,
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
              deletedAt: parent.deletedAt ?? commitNow,
              updatedAt: commitNow,
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
          completedAt: commitNow,
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
    currentNow: () => Date;
    workerId: string;
    baseBackoffMs: number;
    maxBackoffMs: number;
    maxAttempts: number;
    random?: () => number;
    onPermanentFailure?: (failure: PermanentRetentionFailure) => void;
  },
  errorCode: string,
): Promise<"retried" | "failed" | "fenced"> {
  const errorNow = context.currentNow();

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
        .where(ownerAttemptFence(task.id, context.workerId, task.attempts))
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
  const nextAttemptAt = new Date(errorNow.getTime() + backoffMs);

  const updated = await deps.db
    .update(retentionTasks)
    .set({
      state: "retryable_failure",
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt,
      lastErrorCode: errorCode,
    })
    .where(ownerAttemptFence(task.id, context.workerId, task.attempts))
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
