import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import { errorBody } from "../../http.js";
import type { Database } from "../../infrastructure/db/client.js";
import type { ObjectStorage } from "../../infrastructure/storage/memory.js";
import { readSignedCookie, SESSION_COOKIE } from "../auth/cookies.js";
import { type RateLimitRule, SlidingWindowRateLimiter } from "../auth/rate-limit.js";
import { readSessionUser } from "../auth/service.js";
import { runRetentionPass } from "../retention/worker.js";
import { UploadError } from "./errors.js";
import type { ParseGate } from "./parse-gate.js";
import {
  completeUpload,
  createUploadIntent,
  createViewUrl,
  deleteResume,
  getResume,
  listResumes,
  MAX_RESUME_LIST_LIMIT,
} from "./service.js";

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const intentSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["filename", "mimeType", "sizeBytes"],
    properties: {
      filename: { type: "string", minLength: 1, maxLength: 255 },
      mimeType: { type: "string", minLength: 1, maxLength: 255 },
      sizeBytes: { type: "integer", minimum: 1, maximum: 104857600 },
    },
  },
} as const;

const versionParams = {
  params: {
    type: "object",
    required: ["resumeId", "versionId"],
    properties: {
      resumeId: { type: "string", pattern: UUID },
      versionId: { type: "string", pattern: UUID },
    },
  },
} as const;

const completeSchema = {
  ...versionParams,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
} as const;

const resumeParams = {
  params: {
    type: "object",
    required: ["resumeId"],
    properties: {
      resumeId: { type: "string", pattern: UUID },
    },
  },
} as const;

const listResumesSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: MAX_RESUME_LIST_LIMIT },
      offset: { type: "integer", minimum: 0 },
    },
  },
} as const;

export async function registerUploadRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    db: Database | null;
    storage: ObjectStorage | null;
    parseGate: ParseGate | null;
    rateLimiter: SlidingWindowRateLimiter;
  },
): Promise<void> {
  app.post("/api/v1/resumes/upload-intents", { schema: intentSchema }, async (request, reply) => {
    try {
      const user = await requireUser(deps.db, request);
      if (!allowRateLimit(deps.rateLimiter, `upload:user:${user.id}`, deps.config.uploadRateLimit, reply, request.id)) {
        return;
      }
      const ready = requireReady(deps);
      const body = request.body as { filename: string; mimeType: string; sizeBytes: number };
      const intent = await createUploadIntent(
        { ...ready, config: deps.config, parseGate: deps.parseGate },
        user.id,
        body,
      );
      return reply.status(201).send(intent);
    } catch (error) {
      return sendUploadError(error, reply, request.id);
    }
  });

  app.post(
    "/api/v1/resumes/:resumeId/versions/:versionId/complete-upload",
    { schema: completeSchema },
    async (request, reply) => {
      const abortController = new AbortController();
      const onAborted = (): void => {
        if (!reply.sent) {
          abortController.abort();
        }
      };
      request.raw.on("aborted", onAborted);
      request.raw.on("close", () => {
        if (!reply.raw.writableEnded) {
          abortController.abort();
        }
      });

      try {
        const user = await requireUser(deps.db, request);
        const ready = requireReady(deps);
        const params = request.params as { resumeId: string; versionId: string };
        return await completeUpload(
          { ...ready, config: deps.config, parseGate: deps.parseGate },
          user.id,
          params.resumeId,
          params.versionId,
          { signal: abortController.signal },
        );
      } catch (error) {
        return sendUploadError(error, reply, request.id);
      } finally {
        request.raw.off("aborted", onAborted);
      }
    },
  );

  app.get("/api/v1/resumes", { schema: listResumesSchema }, async (request, reply) => {
    try {
      const user = await requireUser(deps.db, request);
      const db = requireDb(deps.db);
      const query = request.query as { limit?: number; offset?: number };
      const cleanupDeps =
        deps.storage && deps.config.signedUrlTtlSeconds !== null
          ? { db, storage: deps.storage, config: deps.config }
          : null;
      return await listResumes(db, user.id, query, cleanupDeps);
    } catch (error) {
      return sendUploadError(error, reply, request.id);
    }
  });

  app.get("/api/v1/resumes/:resumeId", { schema: resumeParams }, async (request, reply) => {
    try {
      const user = await requireUser(deps.db, request);
      const params = request.params as { resumeId: string };
      return await getResume(requireDb(deps.db), user.id, params.resumeId);
    } catch (error) {
      return sendUploadError(error, reply, request.id);
    }
  });

  app.get(
    "/api/v1/resumes/:resumeId/versions/:versionId/view-url",
    { schema: versionParams },
    async (request, reply) => {
      try {
        const user = await requireUser(deps.db, request);
        const ready = requireReady(deps);
        const params = request.params as { resumeId: string; versionId: string };
        return await createViewUrl(
          { ...ready, config: deps.config, parseGate: deps.parseGate },
          user.id,
          params.resumeId,
          params.versionId,
        );
      } catch (error) {
        return sendUploadError(error, reply, request.id);
      }
    },
  );

  app.delete("/api/v1/resumes/:resumeId", { schema: resumeParams }, async (request, reply) => {
    try {
      const user = await requireUser(deps.db, request);
      const params = request.params as { resumeId: string };
      const db = requireDb(deps.db);
      await deleteResume(db, user.id, params.resumeId);
      if (deps.storage) {
        await runRetentionPass({ db, storage: deps.storage });
      }
      return reply.status(204).send();
    } catch (error) {
      return sendUploadError(error, reply, request.id);
    }
  });
}

function requireDb(db: Database | null): Database {
  if (!db) {
    throw new UploadError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured");
  }
  return db;
}

function requireReady(deps: {
  db: Database | null;
  storage: ObjectStorage | null;
}): { db: Database; storage: ObjectStorage } {
  return { db: requireDb(deps.db), storage: requireStorage(deps.storage) };
}

function requireStorage(storage: ObjectStorage | null): ObjectStorage {
  if (!storage) {
    throw new UploadError(503, "STORAGE_NOT_CONFIGURED", "Object storage is not configured.");
  }
  return storage;
}

async function requireUser(db: Database | null, request: FastifyRequest) {
  const database = requireDb(db);
  const sessionId = readSignedCookie(request, SESSION_COOKIE);
  if (!sessionId) {
    throw new UploadError(401, "UNAUTHORIZED", "Unauthorized");
  }
  const user = await readSessionUser(database, sessionId);
  if (!user) {
    throw new UploadError(401, "UNAUTHORIZED", "Unauthorized");
  }
  return user;
}

function allowRateLimit(
  limiter: SlidingWindowRateLimiter,
  key: string,
  rule: RateLimitRule | null,
  reply: FastifyReply,
  requestId: string,
): boolean {
  if (!rule) {
    return true;
  }
  const decision = limiter.consume(key, rule);
  if (decision.allowed) {
    return true;
  }
  reply.header("retry-after", String(decision.retryAfterSeconds));
  void reply.status(429).send(errorBody("RATE_LIMITED", "Too many requests", requestId));
  return false;
}

function sendUploadError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof UploadError) {
    if (error.code === "PARSE_OVERLOADED") {
      reply.header("retry-after", "5");
    }
    return reply.status(error.statusCode).send(errorBody(error.code, error.message, requestId));
  }
  throw error;
}
