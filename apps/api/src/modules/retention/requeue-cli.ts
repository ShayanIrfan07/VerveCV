import { loadConfig } from "../../config.js";
import { createDatabaseWithClient } from "../../infrastructure/db/client.js";
import { createR2Storage } from "../../infrastructure/storage/r2.js";
import {
  getRetentionBacklogSummary,
  requeueFailedRetentionTasks,
  runRetentionPass,
  type RetentionLogger,
} from "./worker.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedRequeueArgs {
  taskIds: string[] | undefined;
  all: boolean;
  dryRun: boolean;
  limit: number;
  runPassNow: boolean;
}

export function parseRequeueCliArgs(argv: readonly string[]): ParsedRequeueArgs {
  const taskIds: string[] = [];
  let all = false;
  let dryRun = false;
  let limit = 100;
  let runPassNow = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--no-run") {
      runPassNow = false;
      continue;
    }
    if (arg === "--limit") {
      const raw = argv[i + 1];
      i += 1;
      const parsed = Number(raw);
      if (!raw || !Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
        throw new Error("--limit must be an integer from 1 to 1000");
      }
      limit = parsed;
      continue;
    }
    if (arg === "--task-id") {
      const id = argv[i + 1];
      i += 1;
      if (!id || !UUID_REGEX.test(id)) {
        throw new Error("--task-id must be a valid UUID");
      }
      taskIds.push(id);
      continue;
    }
    throw new Error(`Unknown argument "${arg}"`);
  }

  if (all && taskIds.length > 0) {
    throw new Error("--all cannot be combined with --task-id");
  }
  if (!dryRun && taskIds.length === 0 && !all) {
    throw new Error(
      "Specify one or more --task-id <uuid> flags, pass --all to confirm bulk requeue, or use --dry-run to preview failed tasks.",
    );
  }

  return {
    taskIds: taskIds.length > 0 ? taskIds : undefined,
    all,
    dryRun,
    limit,
    runPassNow: dryRun ? false : runPassNow,
  };
}

async function main(): Promise<void> {
  const parsed = parseRequeueCliArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to requeue failed retention tasks");
  }

  const logger: RetentionLogger = {
    info: (bindings, msg) => console.log(JSON.stringify({ level: "info", ...bindings, msg })),
    warn: (bindings, msg) => console.warn(JSON.stringify({ level: "warn", ...bindings, msg })),
    error: (bindings, msg) => console.error(JSON.stringify({ level: "error", ...bindings, msg })),
  };

  const { db, close } = createDatabaseWithClient(config.databaseUrl);
  try {
    const before = await getRetentionBacklogSummary(db);
    const requeued = await requeueFailedRetentionTasks(db, {
      ...(parsed.taskIds ? { taskIds: parsed.taskIds } : {}),
      limit: parsed.limit,
      dryRun: parsed.dryRun,
      logger,
    });

    let passResult = null;
    if (!parsed.dryRun && parsed.runPassNow && requeued.requeuedCount > 0 && config.r2) {
      const storage = createR2Storage(config.r2);
      passResult = await runRetentionPass(
        { db, storage, logger },
        {
          leaseMs: config.retentionLeaseMs,
          baseBackoffMs: config.retentionBaseBackoffMs,
          maxBackoffMs: config.retentionMaxBackoffMs,
          maxAttempts: config.retentionMaxAttempts,
        },
      );
    }

    const after = await getRetentionBacklogSummary(db);
    console.log(
      JSON.stringify({
        event: parsed.dryRun ? "retention.requeue_dry_run" : "retention.requeue_summary",
        dryRun: parsed.dryRun,
        before,
        matchedCount: requeued.requeuedCount,
        requeuedCount: parsed.dryRun ? 0 : requeued.requeuedCount,
        taskIds: requeued.taskIds,
        ranImmediatePass: passResult !== null,
        passResult,
        after,
      }),
    );
  } finally {
    await close();
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  process.argv[1].replaceAll("\\", "/").endsWith("/modules/retention/requeue-cli.js");

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", event: "retention.requeue_cli_failed", message }));
    process.exit(1);
  });
}
