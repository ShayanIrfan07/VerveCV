import { MAX_SIGNED_URL_TTL_SECONDS } from "./infrastructure/storage/r2.js";
import type { AuthRateLimits } from "./modules/auth/rate-limit.js";
import {
  DEFAULT_PARSE_MAX_QUEUE,
  DEFAULT_PARSE_QUEUE_TIMEOUT_MS,
} from "./modules/uploads/parse-gate.js";

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
  uploadLimitBytes: number;
  signedUrlTtlSeconds: number | null;
  pdfPageCap: number | null;
  docxEntryCap: number | null;
  docxUncompressedBytes: number | null;
  parseTimeoutMs: number | null;
  parseConcurrency: number | null;
  parseMaxQueue: number;
  parseQueueTimeoutMs: number;
  maxPendingUploadsPerUser: number;
  uploadIntentGraceSeconds: number;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  } | null;
}

/** Operational defaults until ADR 0001 item A7 approves session, rate-limit, and parser settings. */
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_AUTH_RATE_LIMIT_REGISTER_MAX = 5;
const DEFAULT_AUTH_RATE_LIMIT_LOGIN_IP_MAX = 10;
const DEFAULT_AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX = 5;
const DEFAULT_AUTH_RATE_LIMIT_REFRESH_MAX = 20;
/** Approved upload ceiling from the low-level design. It is separate from the dependency budget. */
const DEFAULT_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;
/** Operational bounds preventing unbounded pending upload intent accumulation. */
const DEFAULT_MAX_PENDING_UPLOADS_PER_USER = 10;
const DEFAULT_UPLOAD_INTENT_GRACE_SECONDS = 60;

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
      env["AUTH_RATE_LIMIT_WINDOW_SECONDS"],
      DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS,
      "AUTH_RATE_LIMIT_WINDOW_SECONDS",
    ) * 1000;

  const authRateLimits: AuthRateLimits = {
    register: {
      max: readPositiveInt(
        env["AUTH_RATE_LIMIT_REGISTER_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_REGISTER_MAX,
        "AUTH_RATE_LIMIT_REGISTER_MAX",
      ),
      windowMs,
    },
    loginIp: {
      max: readPositiveInt(
        env["AUTH_RATE_LIMIT_LOGIN_IP_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_LOGIN_IP_MAX,
        "AUTH_RATE_LIMIT_LOGIN_IP_MAX",
      ),
      windowMs,
    },
    loginAccount: {
      max: readPositiveInt(
        env["AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX,
        "AUTH_RATE_LIMIT_LOGIN_ACCOUNT_MAX",
      ),
      windowMs,
    },
    refresh: {
      max: readPositiveInt(
        env["AUTH_RATE_LIMIT_REFRESH_MAX"],
        DEFAULT_AUTH_RATE_LIMIT_REFRESH_MAX,
        "AUTH_RATE_LIMIT_REFRESH_MAX",
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
      env["SESSION_TTL_SECONDS"],
      DEFAULT_SESSION_TTL_SECONDS,
      "SESSION_TTL_SECONDS",
    ),
    secureCookies: env["NODE_ENV"] === "production",
    authRateLimits,
    uploadLimitBytes: readPositiveInt(
      env["UPLOAD_LIMIT_BYTES"],
      DEFAULT_UPLOAD_LIMIT_BYTES,
      "UPLOAD_LIMIT_BYTES",
    ),
    signedUrlTtlSeconds: readSignedUrlTtl(env["SIGNED_URL_TTL_SECONDS"]),
    pdfPageCap: readOptionalPositiveInt(env["PDF_PAGE_CAP"], "PDF_PAGE_CAP"),
    docxEntryCap: readOptionalPositiveInt(env["DOCX_ENTRY_CAP"], "DOCX_ENTRY_CAP"),
    docxUncompressedBytes: readOptionalPositiveInt(
      env["DOCX_UNCOMPRESSED_BYTES"],
      "DOCX_UNCOMPRESSED_BYTES",
    ),
    parseTimeoutMs: readOptionalPositiveInt(env["PARSE_TIMEOUT_MS"], "PARSE_TIMEOUT_MS"),
    parseConcurrency: readOptionalPositiveInt(env["PARSE_CONCURRENCY"], "PARSE_CONCURRENCY"),
    parseMaxQueue: readNonNegativeInt(
      env["PARSE_MAX_QUEUE"],
      DEFAULT_PARSE_MAX_QUEUE,
      "PARSE_MAX_QUEUE",
    ),
    parseQueueTimeoutMs: readPositiveInt(
      env["PARSE_QUEUE_TIMEOUT_MS"],
      DEFAULT_PARSE_QUEUE_TIMEOUT_MS,
      "PARSE_QUEUE_TIMEOUT_MS",
    ),
    maxPendingUploadsPerUser: readPositiveInt(
      env["MAX_PENDING_UPLOADS_PER_USER"],
      DEFAULT_MAX_PENDING_UPLOADS_PER_USER,
      "MAX_PENDING_UPLOADS_PER_USER",
    ),
    uploadIntentGraceSeconds: readNonNegativeInt(
      env["UPLOAD_INTENT_GRACE_SECONDS"],
      DEFAULT_UPLOAD_INTENT_GRACE_SECONDS,
      "UPLOAD_INTENT_GRACE_SECONDS",
    ),
    r2: readR2(env),
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

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readNonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readOptionalPositiveInt(value: string | undefined, name: string): number | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readSignedUrlTtl(value: string | undefined): number | null {
  const parsed = readOptionalPositiveInt(value, "SIGNED_URL_TTL_SECONDS");
  if (parsed === null) {
    return null;
  }
  if (parsed > MAX_SIGNED_URL_TTL_SECONDS) {
    throw new Error(
      `SIGNED_URL_TTL_SECONDS must be an integer from 1 to ${MAX_SIGNED_URL_TTL_SECONDS}`,
    );
  }
  return parsed;
}

function readR2(env: NodeJS.ProcessEnv): AppConfig["r2"] {
  const accountId = env["R2_ACCOUNT_ID"]?.trim() ?? "";
  const accessKeyId = env["R2_ACCESS_KEY_ID"]?.trim() ?? "";
  const secretAccessKey = env["R2_SECRET_ACCESS_KEY"]?.trim() ?? "";
  const bucket = env["R2_BUCKET"]?.trim() ?? "";
  const values = [accountId, accessKeyId, secretAccessKey, bucket];
  const present = values.filter((value) => value.length > 0).length;
  if (present === 0) {
    return null;
  }
  if (present !== values.length) {
    throw new Error("R2 configuration is incomplete");
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}
