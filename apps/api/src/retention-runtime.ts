import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { Database } from "./infrastructure/db/client.js";
import type { ObjectStorage } from "./infrastructure/storage/memory.js";
import {
  runRetentionPass,
  startRetentionScheduler,
  type RetentionLogger,
  type RetentionSchedulerHandle,
} from "./modules/retention/worker.js";

export interface AttachedRetentionRuntime {
  mode: "disabled" | "startup_only" | "scheduled";
  scheduler: RetentionSchedulerHandle | null;
}

/**
 * Attaches the retention runtime to a Fastify server instance:
 * - When `db` or `storage` is absent, retention execution is disabled (`mode: "disabled"`).
 * - When `config.retentionPollMs !== null` (including `NODE_ENV=production`, where
 *   `loadConfig` defaults `retentionPollMs` to 300_000ms / 5 minutes whenever unset),
 *   starts the periodic scheduler (`runOnStart: true` + `setInterval` every `pollMs`)
 *   and registers a graceful `onClose` stop hook (`mode: "scheduled"`).
 * - Otherwise (local/dev with `RETENTION_POLL_MS` unset), runs a single startup pass
 *   (`mode: "startup_only"`).
 */
export async function attachRetentionRuntime(
  app: FastifyInstance,
  deps: {
    config: Pick<
      AppConfig,
      | "retentionPollMs"
      | "retentionLeaseMs"
      | "retentionBaseBackoffMs"
      | "retentionMaxBackoffMs"
      | "retentionMaxAttempts"
    >;
    db: Database | null;
    storage: ObjectStorage | null;
    logger?: RetentionLogger;
  },
): Promise<AttachedRetentionRuntime> {
  if (!deps.db || !deps.storage) {
    return { mode: "disabled", scheduler: null };
  }

  const logger = deps.logger ?? app.log;
  if (deps.config.retentionPollMs !== null) {
    const scheduler = startRetentionScheduler(
      { db: deps.db, storage: deps.storage, logger },
      {
        pollMs: deps.config.retentionPollMs,
        leaseMs: deps.config.retentionLeaseMs,
        baseBackoffMs: deps.config.retentionBaseBackoffMs,
        maxBackoffMs: deps.config.retentionMaxBackoffMs,
        maxAttempts: deps.config.retentionMaxAttempts,
      },
    );
    app.addHook("onClose", async () => {
      await scheduler.stop();
    });
    return { mode: "scheduled", scheduler };
  }

  try {
    await runRetentionPass(
      { db: deps.db, storage: deps.storage, logger },
      {
        leaseMs: deps.config.retentionLeaseMs,
        baseBackoffMs: deps.config.retentionBaseBackoffMs,
        maxBackoffMs: deps.config.retentionMaxBackoffMs,
        maxAttempts: deps.config.retentionMaxAttempts,
      },
    );
  } catch (error) {
    logger.error({ err: error }, "startup retention pass failed");
  }

  return { mode: "startup_only", scheduler: null };
}
