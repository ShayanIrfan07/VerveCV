import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { auditEvents, plans, sessions, subscriptions, usageCounters, users } from "../../infrastructure/db/schema.js";
import { hashPassword, verifyPassword } from "./passwords.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

export class AuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface SessionTokens {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

type DbExecutor = Pick<Database, "select" | "insert" | "update">;

let dummyPasswordHash: Promise<string> | null = null;

export async function registerUser(
  db: Database,
  input: { email: string; password: string; displayName?: string | undefined },
): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  const password = requirePassword(input.password);
  const displayName = normalizeDisplayName(input.displayName);
  if (!EMAIL_PATTERN.test(email) || email.length > 320) {
    throw new AuthError(400, "VALIDATION_ERROR", "Invalid request");
  }

  const passwordHash = await hashPassword(password);
  try {
    return await db.transaction(async (tx) => {
      await tx
        .insert(plans)
        .values([
          { code: "FREE", active: true },
          { code: "PRO", active: false },
        ])
        .onConflictDoNothing();

      const inserted = await tx
        .insert(users)
        .values({ email, passwordHash, displayName })
        .returning({ id: users.id, email: users.email, displayName: users.displayName });
      const user = inserted[0];
      if (!user) {
        throw new AuthError(500, "INTERNAL_ERROR", "Internal error");
      }

      await tx.insert(subscriptions).values({
        userId: user.id,
        planCode: "FREE",
        status: "active",
      });
      await tx.insert(usageCounters).values({
        userId: user.id,
        periodStart: currentPeriodStart(),
        evaluationsUsed: 0,
        uploadBytesUsed: 0,
      });
      await tx.insert(auditEvents).values({
        userId: user.id,
        eventType: "user.registered",
        targetId: user.id,
        safeMetadata: {},
      });
      return user;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AuthError(409, "EMAIL_IN_USE", "Email is already registered");
    }
    throw error;
  }
}

export async function loginUser(
  db: Database,
  input: { email: string; password: string },
  sessionTtlSeconds: number,
): Promise<{ user: PublicUser; tokens: SessionTokens }> {
  const email = normalizeEmail(input.email);
  const password = requirePassword(input.password);
  const found = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt)))
    .limit(1);
  const user = found[0];
  const passwordOk = user
    ? await verifyPassword(user.passwordHash, password)
    : await verifyPassword(await getDummyPasswordHash(), password).then(() => false);

  if (!user || !passwordOk) {
    throw new AuthError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  const tokens = await db.transaction(async (tx) => {
    const created = await createSession(tx, user.id, sessionTtlSeconds, null);
    await tx.insert(auditEvents).values({
      userId: user.id,
      eventType: "user.logged_in",
      targetId: user.id,
      safeMetadata: {},
    });
    return created;
  });

  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    tokens,
  };
}

export async function refreshSession(
  db: Database,
  refreshToken: string,
  sessionTtlSeconds: number,
): Promise<SessionTokens> {
  const tokenHash = hashRefreshToken(refreshToken);
  const now = new Date();

  const outcome = await db.transaction(async (tx) => {
    const found = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
      .for("update")
      .limit(1);
    const current = found[0];
    if (!current) {
      return { kind: "unauthorized" as const };
    }

    await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, current.userId))
      .for("update");

    const lockedCurrentRows = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, current.id))
      .limit(1);
    const lockedCurrent = lockedCurrentRows[0];
    if (!lockedCurrent) {
      return { kind: "unauthorized" as const };
    }

    if (lockedCurrent.revokedAt) {
      await revokeSessionFamily(tx, lockedCurrent.userId, lockedCurrent.id, now);
      return { kind: "reuse" as const };
    }

    if (lockedCurrent.expiresAt.getTime() <= now.getTime()) {
      return { kind: "unauthorized" as const };
    }

    const claimed = await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.id, lockedCurrent.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    if (claimed.length === 0) {
      await revokeSessionFamily(tx, lockedCurrent.userId, lockedCurrent.id, now);
      return { kind: "reuse" as const };
    }

    const tokens = await createSession(tx, lockedCurrent.userId, sessionTtlSeconds, lockedCurrent.id, now);
    return { kind: "rotated" as const, tokens };
  });

  if (outcome.kind === "reuse") {
    throw new AuthError(401, "REFRESH_REUSE", "Unauthorized");
  }
  if (outcome.kind === "unauthorized") {
    throw new AuthError(401, "UNAUTHORIZED", "Unauthorized");
  }
  return outcome.tokens;
}

export async function logoutSession(
  db: Database,
  credentials: { sessionId?: string | null; refreshToken?: string | null },
): Promise<void> {
  const sessionId = credentials.sessionId ?? null;
  const refreshToken = credentials.refreshToken ?? null;
  if (!sessionId && !refreshToken) {
    return;
  }

  const refreshHash = refreshToken ? hashRefreshToken(refreshToken) : null;
  const now = new Date();

  await db.transaction(async (tx) => {
    const targetIds = new Set<string>();
    const userIds = new Set<string>();

    if (sessionId && isUuidLike(sessionId)) {
      const bySession = await tx
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update")
        .limit(1);
      const found = bySession[0];
      if (found) {
        targetIds.add(found.id);
        userIds.add(found.userId);
      }
    }

    if (refreshHash) {
      const byRefresh = await tx
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.refreshTokenHash, refreshHash))
        .for("update")
        .limit(1);
      const found = byRefresh[0];
      if (found) {
        targetIds.add(found.id);
        userIds.add(found.userId);
      }
    }

    if (targetIds.size === 0) {
      return;
    }

    for (const userId of userIds) {
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userId))
        .for("update");
    }

    for (const startId of targetIds) {
      const ownerRows = await tx
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.id, startId))
        .limit(1);
      const owner = ownerRows[0];
      if (owner) {
        await revokeSessionFamily(tx, owner.userId, startId, now);
      }
    }

    for (const userId of userIds) {
      await tx.insert(auditEvents).values({
        userId,
        eventType: "user.logged_out",
        targetId: [...targetIds][0] ?? null,
        safeMetadata: {},
      });
    }
  });
}

export async function readSessionUser(db: Database, sessionId: string): Promise<PublicUser | null> {
  if (!isUuidLike(sessionId)) {
    return null;
  }
  const found = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.expiresAt,
      deletedAt: users.deletedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const session = found[0];
  if (!session || session.revokedAt || session.deletedAt || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return { id: session.id, email: session.email, displayName: session.displayName };
}

export async function readUsage(db: Database, userId: string) {
  const periodStart = currentPeriodStart();
  const found = await db
    .select({
      evaluationsUsed: usageCounters.evaluationsUsed,
      uploadBytesUsed: usageCounters.uploadBytesUsed,
    })
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodStart, periodStart)))
    .limit(1);
  const row = found[0];
  return {
    periodStart,
    evaluationsUsed: row?.evaluationsUsed ?? 0,
    uploadBytesUsed: row?.uploadBytesUsed ?? 0,
    limits: null,
  };
}

async function createSession(
  tx: DbExecutor,
  userId: string,
  sessionTtlSeconds: number,
  rotatedFromId: string | null,
  now = new Date(),
): Promise<SessionTokens> {
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + sessionTtlSeconds * 1000);
  const inserted = await tx
    .insert(sessions)
    .values({
      userId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      rotatedFromId,
    })
    .returning({ id: sessions.id });
  const session = inserted[0];
  if (!session) {
    throw new AuthError(500, "INTERNAL_ERROR", "Internal error");
  }
  return { sessionId: session.id, refreshToken, expiresAt };
}

async function revokeSessionFamily(
  tx: DbExecutor,
  userId: string,
  startId: string,
  now = new Date(),
): Promise<void> {
  const rows = await tx
    .select({
      id: sessions.id,
      rotatedFromId: sessions.rotatedFromId,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const rootOf = (id: string): string => {
    let current = byId.get(id);
    const seen = new Set<string>();
    while (current?.rotatedFromId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.rotatedFromId);
      if (!parent) {
        break;
      }
      current = parent;
    }
    return current?.id ?? id;
  };
  const root = rootOf(startId);
  const unrevokedMemberIds = rows
    .filter((row) => rootOf(row.id) === root && row.revokedAt === null)
    .map((row) => row.id);

  if (unrevokedMemberIds.length > 0) {
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(inArray(sessions.id, unrevokedMemberIds), isNull(sessions.revokedAt)));
  }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeDisplayName(displayName: string | undefined): string | null {
  const trimmed = displayName?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function requirePassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(400, "VALIDATION_ERROR", "Invalid request");
  }
  return password;
}

export function currentPeriodStart(now = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}-01`;
}

function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= hashPassword("dummy-password-not-a-user");
  return dummyPasswordHash;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "23505") {
    return true;
  }
  return "cause" in error && isUniqueViolation(error.cause);
}
