import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./infrastructure/db/client.js";
import { createR2Storage } from "./infrastructure/storage/r2.js";
import { runRetentionPass } from "./modules/retention/worker.js";
import { ParseGate } from "./modules/uploads/parse-gate.js";

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

if (db && storage) {
  try {
    await runRetentionPass({ db, storage }, { reclaimRunning: true });
  } catch (error) {
    app.log.error(error);
  }
  if (config.retentionPollMs !== null) {
    const timer = setInterval(() => {
      void runRetentionPass({ db, storage }, { reclaimRunning: false }).catch((error: unknown) => {
        app.log.error(error);
      });
    }, config.retentionPollMs);
    timer.unref();
  }
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
