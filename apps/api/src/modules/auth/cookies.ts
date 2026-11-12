import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";

export const SESSION_COOKIE = "vervecv_session";
export const REFRESH_COOKIE = "vervecv_refresh";

export function readSignedCookie(request: FastifyRequest, name: string): string | null {
  const raw = request.cookies[name];
  if (!raw) {
    return null;
  }
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export function setSessionCookies(
  reply: FastifyReply,
  config: Pick<AppConfig, "secureCookies" | "sessionTtlSeconds">,
  sessionId: string,
  refreshToken: string,
): void {
  const base = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax" as const,
    path: "/api/v1",
    signed: true,
    maxAge: config.sessionTtlSeconds,
  };
  reply.setCookie(SESSION_COOKIE, sessionId, base);
  reply.setCookie(REFRESH_COOKIE, refreshToken, { ...base, path: "/api/v1/auth" });
}

export function clearSessionCookies(reply: FastifyReply, secureCookies: boolean): void {
  const base = { path: "/api/v1", secure: secureCookies, sameSite: "lax" as const };
  reply.clearCookie(SESSION_COOKIE, base);
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: "/api/v1/auth" });
}
