import { randomUUID } from "node:crypto";
import type { HealthLiveResponse, HealthReadyResponse } from "@vervecv/contracts";
import cookie from "@fastify/cookie";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { errorBody } from "./http.js";
import type { Database } from "./infrastructure/db/client.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.body.password",
  "req.body.token",
  "req.body.refreshToken",
];

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface AppDeps {
  config: AppConfig;
  db: Database | null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: config.logger ? { redact: REDACT_PATHS } : false,
    requestIdHeader: "x-request-id",
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      return typeof header === "string" && header.length > 0 ? header : randomUUID();
    },
  });

  if (config.cookieSecret) {
    await app.register(cookie, { secret: config.cookieSecret });
  }

  app.addHook("onRequest", async (request, reply) => {
    if (!MUTATING.has(request.method) || !request.url.startsWith("/api/")) {
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !config.allowedOrigins.includes(origin)) {
      return reply.status(403).send(errorBody("ORIGIN_NOT_ALLOWED", "Origin is not allowed", request.id));
    }
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorBody("NOT_FOUND", "Not found", request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request failed");
    if (error.validation) {
      return reply.status(400).send(errorBody("VALIDATION_ERROR", "Invalid request", request.id));
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    const code = statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR";
    const message = statusCode >= 500 ? "Internal error" : error.message;
    return reply.status(statusCode).send(errorBody(code, message, request.id));
  });

  app.get("/api/v1/health/live", (): HealthLiveResponse => {
    return { status: "live" };
  });

  app.get("/api/v1/health/ready", async (request, reply): Promise<HealthReadyResponse | undefined> => {
    if (!deps.db) {
      await reply
        .status(503)
        .send(errorBody("DATABASE_NOT_CONFIGURED", "Database is not configured", request.id));
      return;
    }
    try {
      await deps.db.execute(sql`select 1`);
    } catch {
      await reply.status(503).send(errorBody("DATABASE_UNAVAILABLE", "Database is unavailable", request.id));
      return;
    }
    return { status: "ready" };
  });

  await registerAuthRoutes(app, deps);
  return app;
}
