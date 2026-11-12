import { randomUUID } from "node:crypto";
import type { ErrorEnvelope, HealthLiveResponse } from "@vervecv/contracts";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.body.password",
  "req.body.token",
  "req.body.refreshToken",
];

export const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  if (
    typeof header === "string" &&
    header.length >= 1 &&
    header.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID_PATTERN.test(header)
  ) {
    return header;
  }
  return randomUUID();
}

export function buildApp(config: Pick<AppConfig, "databaseUrl" | "logger">): FastifyInstance {
  const app = Fastify({
    logger: config.logger ? { redact: REDACT_PATHS } : false,
    requestIdHeader: false,
    genReqId: (request) => resolveRequestId(request.headers["x-request-id"]),
  });

  app.addHook("onSend", (_request, reply, payload, done) => {
    reply.header("x-request-id", _request.id);
    done(null, payload);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorBody("NOT_FOUND", "Not found", request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    const code = statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR";
    const message = statusCode >= 500 ? "Internal error" : error.message;
    request.log.error({ err: error }, "request failed");
    reply.status(statusCode).send(errorBody(code, message, request.id));
  });

  app.get("/api/v1/health/live", (): HealthLiveResponse => {
    return { status: "live" };
  });

  app.get("/api/v1/health/ready", (request, reply) => {
    if (config.databaseUrl === null) {
      return reply
        .status(503)
        .send(errorBody("DATABASE_NOT_CONFIGURED", "Database is not configured", request.id));
    }
    return reply
      .status(503)
      .send(
        errorBody(
          "DATABASE_CHECK_NOT_IMPLEMENTED",
          "Database connectivity check is not implemented",
          request.id,
        ),
      );
  });

  return app;
}

function errorBody(code: string, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, requestId } };
}
