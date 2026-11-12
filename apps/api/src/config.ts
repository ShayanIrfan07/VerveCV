export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string | null;
  logger: boolean;
  cookieSecret: string | null;
  allowedOrigins: string[];
  sessionTtlSeconds: number;
  secureCookies: boolean;
  uploadLimitBytes: number;
  signedUrlTtlSeconds: number | null;
  pdfPageCap: number | null;
  docxEntryCap: number | null;
  docxUncompressedBytes: number | null;
  parseTimeoutMs: number | null;
  parseConcurrency: number | null;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  } | null;
}

/** Operational default until ADR 0001 item A7 approves a session lifetime. */
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Approved upload ceiling from the low-level design. It is separate from the dependency budget. */
const DEFAULT_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

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
    sessionTtlSeconds: readPositiveInt(env["SESSION_TTL_SECONDS"], DEFAULT_SESSION_TTL_SECONDS, "SESSION_TTL_SECONDS"),
    secureCookies: env["NODE_ENV"] === "production",
    uploadLimitBytes: readPositiveInt(env["UPLOAD_LIMIT_BYTES"], DEFAULT_UPLOAD_LIMIT_BYTES, "UPLOAD_LIMIT_BYTES"),
    signedUrlTtlSeconds: readOptionalPositiveInt(env["SIGNED_URL_TTL_SECONDS"], "SIGNED_URL_TTL_SECONDS"),
    pdfPageCap: readOptionalPositiveInt(env["PDF_PAGE_CAP"], "PDF_PAGE_CAP"),
    docxEntryCap: readOptionalPositiveInt(env["DOCX_ENTRY_CAP"], "DOCX_ENTRY_CAP"),
    docxUncompressedBytes: readOptionalPositiveInt(env["DOCX_UNCOMPRESSED_BYTES"], "DOCX_UNCOMPRESSED_BYTES"),
    parseTimeoutMs: readOptionalPositiveInt(env["PARSE_TIMEOUT_MS"], "PARSE_TIMEOUT_MS"),
    parseConcurrency: readOptionalPositiveInt(env["PARSE_CONCURRENCY"], "PARSE_CONCURRENCY"),
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
