import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../infrastructure/db/client.js";
import { errorBody } from "../../http.js";
import {
  clearSessionCookies,
  readSignedCookie,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  setSessionCookies,
} from "./cookies.js";
import { type RateLimitRule, SlidingWindowRateLimiter } from "./rate-limit.js";
import {
  AuthError,
  loginUser,
  logoutSession,
  readSessionUser,
  readUsage,
  refreshSession,
  registerUser,
} from "./service.js";

const registerSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["email", "password"],
    properties: {
      email: { type: "string", minLength: 3, maxLength: 320 },
      password: { type: "string", minLength: 8, maxLength: 128 },
      displayName: { type: "string", maxLength: 80 },
    },
  },
} as const;

const loginSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["email", "password"],
    properties: {
      email: { type: "string", minLength: 3, maxLength: 320 },
      password: { type: "string", minLength: 8, maxLength: 128 },
    },
  },
} as const;

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: { config: AppConfig; db: Database | null; rateLimiter?: SlidingWindowRateLimiter },
): Promise<void> {
  const limiter = deps.rateLimiter ?? new SlidingWindowRateLimiter();
  const limits = deps.config.authRateLimits;

  app.post("/api/v1/auth/register", { schema: registerSchema }, async (request, reply) => {
    const allowed = enforceRateLimit(
      limiter,
      `register:ip:${request.ip}`,
      limits.register,
      reply,
      request.id,
    );
    if (!allowed) {
      return;
    }

    try {
      const db = requireDb(deps.db);
      const body = request.body as { email: string; password: string; displayName?: string };
      const user = await registerUser(db, body);
      return reply.status(201).send({ user });
    } catch (error) {
      return sendAuthError(error, reply, request.id);
    }
  });

  app.post("/api/v1/auth/login", { schema: loginSchema }, async (request, reply) => {
    const ipAllowed = enforceRateLimit(
      limiter,
      `login:ip:${request.ip}`,
      limits.loginIp,
      reply,
      request.id,
    );
    if (!ipAllowed) {
      return;
    }

    const body = request.body as { email: string; password: string };
    const normalizedAccount = body.email.trim().toLowerCase();
    const accountAllowed = enforceRateLimit(
      limiter,
      `login:account:${normalizedAccount}`,
      limits.loginAccount,
      reply,
      request.id,
    );
    if (!accountAllowed) {
      return;
    }

    try {
      const db = requireDb(deps.db);
      const result = await loginUser(db, body, deps.config.sessionTtlSeconds);
      setSessionCookies(reply, deps.config, result.tokens.sessionId, result.tokens.refreshToken);
      return reply.status(200).send({ user: result.user });
    } catch (error) {
      return sendAuthError(error, reply, request.id);
    }
  });

  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const allowed = enforceRateLimit(
      limiter,
      `refresh:ip:${request.ip}`,
      limits.refresh,
      reply,
      request.id,
    );
    if (!allowed) {
      return;
    }

    try {
      const db = requireDb(deps.db);
      const refreshToken = readSignedCookie(request, REFRESH_COOKIE);
      if (!refreshToken) {
        clearSessionCookies(reply, deps.config.secureCookies);
        return reply.status(401).send(errorBody("UNAUTHORIZED", "Unauthorized", request.id));
      }
      const tokens = await refreshSession(db, refreshToken, deps.config.sessionTtlSeconds);
      setSessionCookies(reply, deps.config, tokens.sessionId, tokens.refreshToken);
      return reply.status(200).send({ status: "refreshed" });
    } catch (error) {
      clearSessionCookies(reply, deps.config.secureCookies);
      return sendAuthError(error, reply, request.id);
    }
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    try {
      const db = requireDb(deps.db);
      const sessionId = readSignedCookie(request, SESSION_COOKIE);
      const refreshToken = readSignedCookie(request, REFRESH_COOKIE);
      if (sessionId || refreshToken) {
        await logoutSession(db, { sessionId, refreshToken });
      }
      clearSessionCookies(reply, deps.config.secureCookies);
      return reply.status(204).send();
    } catch (error) {
      clearSessionCookies(reply, deps.config.secureCookies);
      return sendAuthError(error, reply, request.id);
    }
  });

  app.get("/api/v1/me", async (request, reply) => {
    try {
      const db = requireDb(deps.db);
      const user = await currentUser(db, request);
      if (!user) {
        return reply.status(401).send(errorBody("UNAUTHORIZED", "Unauthorized", request.id));
      }
      return { user };
    } catch (error) {
      return sendAuthError(error, reply, request.id);
    }
  });

  app.get("/api/v1/usage", async (request, reply) => {
    try {
      const db = requireDb(deps.db);
      const user = await currentUser(db, request);
      if (!user) {
        return reply.status(401).send(errorBody("UNAUTHORIZED", "Unauthorized", request.id));
      }
      return readUsage(db, user.id);
    } catch (error) {
      return sendAuthError(error, reply, request.id);
    }
  });
}

function enforceRateLimit(
  limiter: SlidingWindowRateLimiter,
  key: string,
  rule: RateLimitRule,
  reply: FastifyReply,
  requestId: string,
): boolean {
  const decision = limiter.consume(key, rule);
  if (decision.allowed) {
    return true;
  }
  reply.header("retry-after", String(decision.retryAfterSeconds));
  void reply
    .status(429)
    .send(errorBody("RATE_LIMITED", "Too many requests", requestId));
  return false;
}

function requireDb(db: Database | null): Database {
  if (!db) {
    throw new AuthError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured");
  }
  return db;
}

async function currentUser(db: Database, request: Parameters<typeof readSignedCookie>[0]) {
  const sessionId = readSignedCookie(request, SESSION_COOKIE);
  if (!sessionId) {
    return null;
  }
  return readSessionUser(db, sessionId);
}

function sendAuthError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof AuthError) {
    return reply.status(error.statusCode).send(errorBody(error.code, error.message, requestId));
  }
  throw error;
}
