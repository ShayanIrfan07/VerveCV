import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./infrastructure/db/client.js";

const config = loadConfig();
if (!config.cookieSecret || config.cookieSecret.length < 32) {
  throw new Error("COOKIE_SECRET must be at least 32 characters");
}

const db = config.databaseUrl ? createDatabase(config.databaseUrl) : null;
const app = await buildApp({ config, db });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
