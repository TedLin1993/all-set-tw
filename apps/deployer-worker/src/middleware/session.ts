import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env, PublicSession } from "../platform/env";
import { honoFactory } from "../platform/hono";
import { jsonError, isLocalDevMode } from "../platform/http";
import { getSession } from "../features/auth/repository";

export const SESSION_COOKIE = "all_set_deployer_session";
export const OAUTH_STATE_COOKIE = "all_set_deployer_oauth_state";
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function cookieOptions(env: Env, expires: Date) {
  return {
    httpOnly: true,
    secure: !isLocalDevMode(env),
    sameSite: "Lax" as const,
    path: "/",
    expires,
  };
}

export function setSessionCookie(args: {
  setCookie: (
    name: string,
    value: string,
    options: ReturnType<typeof cookieOptions>,
  ) => void;
  env: Env;
  sessionId: string;
  expiresAt: string;
}) {
  args.setCookie(
    SESSION_COOKIE,
    args.sessionId,
    cookieOptions(args.env, new Date(args.expiresAt)),
  );
}

export function clearSessionCookie(c: {
  env: Env;
  header: (name: string, value: string) => void;
}) {
  deleteCookie(c as never, SESSION_COOKIE, cookieOptions(c.env, new Date(0)));
}

export function setOAuthStateCookie(args: {
  setCookie: (
    name: string,
    value: string,
    options: ReturnType<typeof cookieOptions>,
  ) => void;
  env: Env;
  state: string;
  expiresAt: string;
}) {
  args.setCookie(
    OAUTH_STATE_COOKIE,
    args.state,
    cookieOptions(args.env, new Date(args.expiresAt)),
  );
}

export function clearOAuthStateCookie(c: {
  env: Env;
  header: (name: string, value: string) => void;
}) {
  deleteCookie(
    c as never,
    OAUTH_STATE_COOKIE,
    cookieOptions(c.env, new Date(0)),
  );
}

export const sessionMiddleware = honoFactory.createMiddleware(
  async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (!sessionId) {
      c.set("session", null);
      await next();
      return;
    }
    const session = await getSession(c.env.DB, sessionId, new Date());
    if (!session) {
      deleteCookie(c, SESSION_COOKIE, cookieOptions(c.env, new Date(0)));
      c.set("session", null);
      await next();
      return;
    }
    c.set("session", toPublicSession(session));
    await next();
  },
);

export function toPublicSession(session: {
  id: string;
  oauthSub: string;
  selectedAccountId: string | null;
  tokenExpiresAt: string;
  csrfToken: string;
  expiresAt: string;
}): PublicSession {
  return {
    id: session.id,
    oauthSub: session.oauthSub,
    selectedAccountId: session.selectedAccountId,
    tokenExpiresAt: session.tokenExpiresAt,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

export function requireSession(session: PublicSession | null) {
  if (!session) {
    return jsonError("UNAUTHENTICATED", "請先使用 Cloudflare 授權。", 401);
  }
  return null;
}

export function requireCsrf(
  session: PublicSession,
  header: string | undefined,
) {
  if (!header || header !== session.csrfToken) {
    return jsonError(
      "CSRF_INVALID",
      "無法驗證此次操作，請重新整理後再試。",
      403,
    );
  }
  return null;
}

export { getCookie, setCookie };
