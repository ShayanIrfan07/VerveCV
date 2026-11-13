import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CandidateType } from "@vervecv/evaluation";
import type { AppConfig } from "../../config.js";
import { errorBody } from "../../http.js";
import type { Database } from "../../infrastructure/db/client.js";
import type { ObjectStorage } from "../../infrastructure/storage/memory.js";
import { readSignedCookie, SESSION_COOKIE } from "../auth/cookies.js";
import { readSessionUser } from "../auth/service.js";
import type { ParseGate } from "../uploads/parse-gate.js";
import { EvaluationError } from "./errors.js";
import {
  createEvaluation,
  getEvaluation,
  getEvaluationJob,
  listEvaluations,
  MAX_EVALUATION_LIST_LIMIT,
} from "./service.js";

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const createSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["resumeVersionId", "candidateType", "jobDescription", "idempotencyKey"],
    properties: {
      resumeVersionId: { type: "string", pattern: UUID },
      candidateType: { type: "string", enum: ["FRESHER", "EXPERIENCED"] },
      jobDescription: { type: ["string", "null"], maxLength: 8000 },
      idempotencyKey: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" },
    },
  },
} as const;

const idParams = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: UUID } },
  },
} as const;

const listSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: MAX_EVALUATION_LIST_LIMIT },
      offset: { type: "integer", minimum: 0 },
    },
  },
} as const;

export async function registerEvaluationRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    db: Database | null;
    storage: ObjectStorage | null;
    parseGate: ParseGate | null;
  },
): Promise<void> {
  app.post("/api/v1/evaluations", { schema: createSchema }, async (request, reply) => {
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
      const body = request.body as {
        resumeVersionId: string;
        candidateType: CandidateType;
        jobDescription: string | null;
        idempotencyKey: string;
      };
      return await createEvaluation(
        { ...ready, config: deps.config, parseGate: deps.parseGate },
        user.id,
        body,
        { signal: abortController.signal },
      );
    } catch (error) {
      return sendEvaluationError(error, reply, request.id);
    } finally {
      request.raw.off("aborted", onAborted);
    }
  });

  app.get("/api/v1/evaluations", { schema: listSchema }, async (request, reply) => {
    try {
      const user = await requireUser(deps.db, request);
      const query = request.query as { limit?: number; offset?: number };
      return await listEvaluations(requireDb(deps.db), user.id, query);
    } catch (error) {
      return sendEvaluationError(error, reply, request.id);
    }
  });

  app.get("/api/v1/evaluations/:id", { schema: idParams }, async (request, reply) => {
    try {
      const user = await requireUser(deps.db, request);
      const params = request.params as { id: string };
      return await getEvaluation(requireDb(deps.db), user.id, params.id);
    } catch (error) {
      return sendEvaluationError(error, reply, request.id);
    }
  });

  app.get("/api/v1/evaluation-jobs/:id", { schema: idParams }, async (request, reply) => {
    try {
      const user = await requireUser(deps.db, request);
      const params = request.params as { id: string };
      return await getEvaluationJob(requireDb(deps.db), user.id, params.id);
    } catch (error) {
      return sendEvaluationError(error, reply, request.id);
    }
  });
}

function requireDb(db: Database | null): Database {
  if (!db) {
    throw new EvaluationError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured");
  }
  return db;
}

function requireReady(deps: {
  db: Database | null;
  storage: ObjectStorage | null;
}): { db: Database; storage: ObjectStorage } {
  if (!deps.storage) {
    throw new EvaluationError(503, "STORAGE_NOT_CONFIGURED", "Object storage is not configured.");
  }
  return { db: requireDb(deps.db), storage: deps.storage };
}

async function requireUser(db: Database | null, request: FastifyRequest) {
  const database = requireDb(db);
  const sessionId = readSignedCookie(request, SESSION_COOKIE);
  if (!sessionId) {
    throw new EvaluationError(401, "UNAUTHORIZED", "Unauthorized");
  }
  const user = await readSessionUser(database, sessionId);
  if (!user) {
    throw new EvaluationError(401, "UNAUTHORIZED", "Unauthorized");
  }
  return user;
}

function sendEvaluationError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof EvaluationError) {
    if (error.code === "PARSE_OVERLOADED") {
      reply.header("retry-after", "5");
    }
    return reply.status(error.statusCode).send(errorBody(error.code, error.message, requestId));
  }
  throw error;
}
