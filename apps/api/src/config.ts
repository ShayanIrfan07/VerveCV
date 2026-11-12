export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string | null;
  logger: boolean;
  cookieSecret: string | null;
  allowedOrigins: string[];
  sessionTtlSeconds: number;
  secureCookies: boolean;
}

/** Operational default until ADR 0001 item A7 approves a session lifetime. */
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPort(env["PORT"]);
  const host = env["HOST"]?.trim() || "0.0.0.0";
  const databaseUrl = env["DATABASE_URL"]?.trim() || null;
  const cookieSecret = env["COOKIE_SECRET"]?.trim() || null;
  const allowedOrigins = (env["ALLOWED_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  return {
    host,
    port,
    databaseUrl,
    logger: env["LOG_LEVEL"] !== "silent",
    cookieSecret,
    allowedOrigins,
    sessionTtlSeconds: readPositiveInt(env["SESSION_TTL_SECONDS"], DEFAULT_SESSION_TTL_SECONDS),
    secureCookies: env["NODE_ENV"] === "production",
  };
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

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("SESSION_TTL_SECONDS must be a positive integer");
  }
  return parsed;
}
