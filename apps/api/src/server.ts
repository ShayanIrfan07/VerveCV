import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./infrastructure/db/client.js";
import { createR2Storage } from "./infrastructure/storage/r2.js";
import {
  runRetentionPass,
  startRetentionScheduler,
  type RetentionSchedulerHandle,
} from "./modules/retention/worker.js";
import { ParseGate } from "./modules/uploads/parse-gate.js";

const localEnvFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
if (existsSync(localEnvFile)) {
  process.loadEnvFile(localEnvFile);
}

const config = loadConfig();
if (!config.cookieSecret || config.cookieSecret.length < 32) {
  throw new Error("COOKIE_SECRET must be at least 32 characters");
}

const db = config.databaseUrl ? createDatabase(config.databaseUrl) : null;
const storage = config.r2 ? createR2Storage(config.r2) : null;
const parseGate =
  config.parseConcurrency === null
    ? null
    : new ParseGate(config.parseConcurrency, {
        maxQueue: config.parseMaxQueue,
        maxWaitMs: config.parseQueueTimeoutMs,
      });
const app = await buildApp({ config, db, storage, parseGate });

let retentionScheduler: RetentionSchedulerHandle | null = null;
if (db && storage) {
  const logger = app.log;
  if (config.retentionPollMs !== null) {
    retentionScheduler = startRetentionScheduler(
      { db, storage, logger },
      {
        pollMs: config.retentionPollMs,
        leaseMs: config.retentionLeaseMs,
        baseBackoffMs: config.retentionBaseBackoffMs,
        maxBackoffMs: config.retentionMaxBackoffMs,
        maxAttempts: config.retentionMaxAttempts,
      },
    );
    app.addHook("onClose", async () => {
      await retentionScheduler?.stop();
    });
  } else {
    try {
      await runRetentionPass(
        { db, storage, logger },
        {
          leaseMs: config.retentionLeaseMs,
          baseBackoffMs: config.retentionBaseBackoffMs,
          maxBackoffMs: config.retentionMaxBackoffMs,
          maxAttempts: config.retentionMaxAttempts,
        },
      );
    } catch (error) {
      app.log.error(error);
    }
  }
}

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutting down server");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await retentionScheduler?.stop();
  app.log.error(error);
  process.exit(1);
}
