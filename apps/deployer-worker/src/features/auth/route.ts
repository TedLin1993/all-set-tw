import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import {
  CloudflareApiError,
  listAuthorizedAccounts,
} from "../../platform/cloudflare";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  getCookie,
  OAUTH_STATE_COOKIE,
  requireCsrf,
  requireSession,
  setCookie,
  setOAuthStateCookie,
  setSessionCookie,
} from "../../middleware/session";
import {
  AuthServiceError,
  beginOAuthLogin,
  completeOAuthLogin,
  deployerAuthStatus,
  logoutSession,
  readAccessToken,
  selectAccount,
} from "./service";

export const authRoutes = honoFactory.createApp();
registerAuthRoutes(authRoutes);

function registerAuthRoutes(api: Hono<AppBindings>) {
  api.get("/auth/status", (c) => c.json(deployerAuthStatus(c.env)));

  api.get("/auth/login", async (c) => {
    try {
      const { authorizeUrl, state, expiresAt } = await beginOAuthLogin(c.env);
      setOAuthStateCookie({
        setCookie: (name, value, options) => setCookie(c, name, value, options),
        env: c.env,
        state,
        expiresAt,
      });
      return c.redirect(authorizeUrl, 302);
    } catch (error) {
      return mapAuthError(error);
    }
  });

  api.get("/auth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
    clearOAuthStateCookie(c);
    if (!code || !state || !cookieState || cookieState !== state) {
      return jsonError(
        "INVALID_OAUTH_STATE",
        "缺少授權參數，請重新登入。",
        400,
      );
    }
    try {
      const result = await completeOAuthLogin(c.env, { code, state });
      setSessionCookie({
        setCookie: (name, value, options) => setCookie(c, name, value, options),
        env: c.env,
        sessionId: result.session.id,
        expiresAt: result.session.expiresAt,
      });
      return c.redirect(result.redirectPath, 302);
    } catch (error) {
      return mapAuthError(error);
    }
  });

  api.get("/auth/me", (c) => {
    const unauthorized = requireSession(c.get("session"));
    if (unauthorized) return unauthorized;
    const session = c.get("session")!;
    return c.json({
      sub: session.oauthSub,
      selectedAccountId: session.selectedAccountId,
      tokenExpiresAt: session.tokenExpiresAt,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  });

  api.get("/auth/accounts", async (c) => {
    const unauthorized = requireSession(c.get("session"));
    if (unauthorized) return unauthorized;
    try {
      const { accessToken } = await readAccessToken(
        c.env,
        c.get("session")!.id,
      );
      return c.json({ accounts: await listAuthorizedAccounts(accessToken) });
    } catch (error) {
      return mapAuthError(error);
    }
  });

  api.post(
    "/auth/select-account",
    zValidator(
      "json",
      z.object({ accountId: z.string().min(1).max(64) }),
      validationHook("INVALID_REQUEST", "accountId is required."),
    ),
    async (c) => {
      const session = c.get("session");
      const unauthorized = requireSession(session);
      if (unauthorized) return unauthorized;
      const csrf = requireCsrf(session!, c.req.header("X-CSRF-Token"));
      if (csrf) return csrf;
      try {
        const { accessToken } = await readAccessToken(c.env, session!.id);
        const accounts = await listAuthorizedAccounts(accessToken);
        const selected = await selectAccount(
          c.env,
          session!,
          c.req.valid("json").accountId,
          accounts.map((account) => account.id),
        );
        if (!selected) {
          return jsonError(
            "ACCOUNT_NOT_AUTHORIZED",
            "此次授權沒有該帳戶的管理權限。",
            403,
          );
        }
        return c.json({ selectedAccountId: selected.selectedAccountId });
      } catch (error) {
        return mapAuthError(error);
      }
    },
  );

  api.post("/auth/logout", async (c) => {
    const session = c.get("session");
    if (session) {
      const csrf = requireCsrf(session, c.req.header("X-CSRF-Token"));
      if (csrf) return csrf;
    }
    await logoutSession(c.env, session);
    clearSessionCookie(c);
    return c.json({ success: true });
  });
}

function mapAuthError(error: unknown) {
  if (error instanceof AuthServiceError) {
    const status =
      error.code === "OAUTH_NOT_CONFIGURED" ||
      error.code === "MISSING_ENCRYPTION_KEY"
        ? 503
        : error.code === "TOKEN_EXPIRED" || error.code === "SESSION_EXPIRED"
          ? 401
          : 400;
    return jsonError(error.code, error.message, status);
  }
  if (error instanceof CloudflareApiError) {
    if (error.code === "TOKEN_EXPIRED") {
      return jsonError(
        "TOKEN_EXPIRED",
        "Cloudflare 授權已過期，請重新授權後續跑。",
        401,
      );
    }
    return jsonError(error.code, "無法讀取此次授權的帳戶清單。", error.status);
  }
  throw error;
}
