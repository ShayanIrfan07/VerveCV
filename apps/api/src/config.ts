import type { AuthRateLimits } from "./modules/auth/rate-limit.js";

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string | null;
  logger: boolean;
  cookieSecret: string | null;
  allowedOrigins: string[];
  sessionTtlSeconds: number;
  secureCookies: boolean;
  authRateLimits: AuthRateLimits;
}

/** Operational defaults until ADR 0001 item A7 approves session and rate-limit settings. */
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_AUTH_RATE_LIMIT_REGISTER_MAX = 5;
const DEFAULT_AUTH_RATE_LIMIT_LOGIN_IP_MAX = 10;
const DEFAULT_AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX = 5;
const DEFAULT_AUTH_RATE_LIMIT_REFRESH_MAX = 20;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPort(env["PORT"]);
  const host = env["HOST"]?.trim() || "0.0.0.0";
  const databaseUrl = env["DATABASE_URL"]?.trim() || null;
  const cookieSecret = env["COOKIE_SECRET"]?.trim() || null;
  const allowedOrigins = (env["ALLOWED_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const windowMs =
    readPositiveInt(
      "AUTH_RATE_LIMIT_WINDOW_SECONDS",
      env["AUTH_RATE_LIMIT_WINDOW_SECONDS"],
      DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS,
    ) * 1000;
  const authRateLimits: AuthRateLimits = {
    register: {
      max: readPositiveInt(
        "AUTH_RATE_LIMIT_REGISTER_MAX",
        env["AUTH_RATE_LIMIT_REGISTER_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_REGISTER_MAX,
      ),
      windowMs,
    },
    loginIp: {
      max: readPositiveInt(
        "AUTH_RATE_LIMIT_LOGIN_IP_MAX",
        env["AUTH_RATE_LIMIT_LOGIN_IP_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_LOGIN_IP_MAX,
      ),
      windowMs,
    },
    loginAccount: {
      max: readPositiveInt(
        "AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX",
        env["AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX,
      ),
      windowMs,
    },
    refresh: {
      max: readPositiveInt(
        "AUTH_RATE_LIMIT_REFRESH_MAX",
        env["AUTH_RATE_LIMIT_REFRESH_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_REFRESH_MAX,
      ),
      windowMs,
    },
  };

  return {
    host,
    port,
    databaseUrl,
    logger: env["LOG_LEVEL"] !== "silent",
    cookieSecret,
    allowedOrigins,
    sessionTtlSeconds: readPositiveInt(
      "SESSION_TTL_SECONDS",
      env["SESSION_TTL_SECONDS"],
      DEFAULT_SESSION_TTL_SECONDS,
    ),
    secureCookies: env["NODE_ENV"] === "production",
    authRateLimits,
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

function readPositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
