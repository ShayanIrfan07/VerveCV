import { and, asc, eq, inArray, isNull, lte, notInArray } from "drizzle-orm";
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

const DUE_STATES = ["pending", "retryable_failure"] as const;
const OPEN_TASK_STATES = ["pending", "running", "retryable_failure"] as const;

export interface RetentionDeps {
  db: Database;
  storage: ObjectStorage;
}

export async function runRetentionPass(
  deps: RetentionDeps,
  options: { now?: Date; reclaimRunning?: boolean } = {},
): Promise<{ processed: number }> {
  const now = options.now ?? new Date();
  await enqueueExpiredVersions(deps.db, now);
  const seen = new Set<string>();
  let processed = 0;
  for (;;) {
    const task = await claimTask(deps, now, options.reclaimRunning === true, seen);
    if (!task) {
      return { processed };
    }
    seen.add(task.id);
    await purgeTask(deps, task, now);
    processed += 1;
  }
}

async function enqueueExpiredVersions(db: Database, now: Date): Promise<void> {
  const expired = await db
    .select({ id: resumeVersions.id, resumeId: resumeVersions.resumeId })
    .from(resumeVersions)
    .where(and(eq(resumeVersions.deletionState, "active"), lte(resumeVersions.expiresAt, now)));
  if (expired.length === 0) {
    return;
  }
  const versionIds = expired.map((row) => row.id);
  await db.transaction(async (tx) => {
    await tx
      .update(resumeVersions)
      .set({ deletionState: "delete_requested" })
      .where(and(inArray(resumeVersions.id, versionIds), eq(resumeVersions.deletionState, "active")));
    const open = await tx
      .select({ resumeVersionId: retentionTasks.resumeVersionId })
      .from(retentionTasks)
      .where(and(inArray(retentionTasks.resumeVersionId, versionIds), inArray(retentionTasks.state, [...OPEN_TASK_STATES])));
    const queued = new Set(open.map((row) => row.resumeVersionId));
    for (const versionId of versionIds) {
      if (!queued.has(versionId)) {
        await tx.insert(retentionTasks).values({
          resumeVersionId: versionId,
          state: "pending",
          nextAttemptAt: now,
        });
      }
    }
    const resumeIds = [...new Set(expired.map((row) => row.resumeId))];
    for (const resumeId of resumeIds) {
      const active = await tx
        .select({ id: resumeVersions.id })
        .from(resumeVersions)
        .where(and(eq(resumeVersions.resumeId, resumeId), eq(resumeVersions.deletionState, "active")))
        .limit(1);
      if (active.length === 0) {
        await tx
          .update(resumes)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(resumes.id, resumeId), isNull(resumes.deletedAt)));
      }
    }
  });
}

async function claimTask(deps: RetentionDeps, now: Date, reclaimRunning: boolean, seen: Set<string>) {
  const states = reclaimRunning ? [...DUE_STATES, "running"] : [...DUE_STATES];
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: retentionTasks.id,
        resumeVersionId: retentionTasks.resumeVersionId,
        attempts: retentionTasks.attempts,
      })
      .from(retentionTasks)
      .where(
        and(
          inArray(retentionTasks.state, states),
          lte(retentionTasks.nextAttemptAt, now),
          seen.size > 0 ? notInArray(retentionTasks.id, [...seen]) : undefined,
        ),
      )
      .orderBy(asc(retentionTasks.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    const task = rows[0];
    if (!task) {
      return null;
    }
    await tx.update(retentionTasks).set({ state: "running" }).where(eq(retentionTasks.id, task.id));
    return task;
  });
}

async function purgeTask(
  deps: RetentionDeps,
  task: { id: string; resumeVersionId: string; attempts: number },
  now: Date,
): Promise<void> {
  const versions = await deps.db
    .select({
      id: resumeVersions.id,
      objectKey: resumeVersions.objectKey,
      resumeId: resumeVersions.resumeId,
    })
    .from(resumeVersions)
    .where(eq(resumeVersions.id, task.resumeVersionId))
    .limit(1);
  const version = versions[0];
  if (!version) {
    await deps.db
      .update(retentionTasks)
      .set({ state: "succeeded", completedAt: now, lastErrorCode: null })
      .where(eq(retentionTasks.id, task.id));
    return;
  }
  try {
    await deps.storage.delete(version.objectKey);
  } catch {
    await deps.db
      .update(retentionTasks)
      .set({
        state: "retryable_failure",
        attempts: task.attempts + 1,
        nextAttemptAt: now,
        lastErrorCode: "STORAGE_DELETE_FAILED",
      })
      .where(eq(retentionTasks.id, task.id));
    return;
  }
  await deps.db.transaction(async (tx) => {
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
      .set({ deletionState: "deleted", originalFilename: "deleted" })
      .where(eq(resumeVersions.id, version.id));
    await tx
      .update(retentionTasks)
      .set({ state: "succeeded", completedAt: now, lastErrorCode: null })
      .where(eq(retentionTasks.id, task.id));
    await tx.insert(auditEvents).values({
      userId: null,
      eventType: "resume_version_purged",
      targetId: version.id,
      safeMetadata: { resumeId: version.resumeId },
    });
  });
}
