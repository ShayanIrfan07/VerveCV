export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string | null;
  logger: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPort(env["PORT"]);
  const host = env["HOST"]?.trim() || "0.0.0.0";
  const databaseUrl = env["DATABASE_URL"]?.trim() || null;
  return { host, port, databaseUrl, logger: env["LOG_LEVEL"] !== "silent" };
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return 3000;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}
