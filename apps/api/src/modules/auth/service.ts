import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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

  const tokens = await createSession(db, user.id, sessionTtlSeconds, null);
  await db.insert(auditEvents).values({
    userId: user.id,
    eventType: "user.logged_in",
    targetId: user.id,
    safeMetadata: {},
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
  const found = await db.select().from(sessions).where(eq(sessions.refreshTokenHash, tokenHash)).limit(1);
  const current = found[0];
  if (!current) {
    throw new AuthError(401, "UNAUTHORIZED", "Unauthorized");
  }
  if (current.revokedAt) {
    await revokeSessionFamily(db, current.userId, current.id);
    throw new AuthError(401, "REFRESH_REUSE", "Unauthorized");
  }
  if (current.expiresAt.getTime() <= Date.now()) {
    throw new AuthError(401, "UNAUTHORIZED", "Unauthorized");
  }

  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, current.id));
  return createSession(db, current.userId, sessionTtlSeconds, current.id);
}

export async function logoutSession(db: Database, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function readSessionUser(db: Database, sessionId: string): Promise<PublicUser | null> {
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
  db: Database,
  userId: string,
  sessionTtlSeconds: number,
  rotatedFromId: string | null,
): Promise<SessionTokens> {
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
  const inserted = await db
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

async function revokeSessionFamily(db: Database, userId: string, startId: string): Promise<void> {
  const rows = await db
    .select({ id: sessions.id, rotatedFromId: sessions.rotatedFromId })
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
  const memberIds = rows.filter((row) => rootOf(row.id) === root).map((row) => row.id);
  for (const id of memberIds) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
  }
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

function currentPeriodStart(now = new Date()): string {
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
