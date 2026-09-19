import { decryptJson, encryptJson, randomToken } from "../../platform/crypto";
import type { Env, PublicSession } from "../../platform/env";
import {
  buildAuthorizeUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
  OAuthExchangeError,
  readOAuthConfig,
  readOAuthSubject,
  revokeOAuthToken,
} from "../../platform/oauth";
import { hasReleaseSource } from "../../platform/release";
import { OAUTH_STATE_TTL_MS, SESSION_TTL_MS } from "../../middleware/session";
import {
  consumeOAuthState,
  getSession,
  insertOAuthState,
  insertSession,
  revokeSession,
  updateSelectedAccount,
  type SessionRow,
} from "./repository";

export class AuthServiceError extends Error {
  constructor(
    public readonly code:
      | "OAUTH_NOT_CONFIGURED"
      | "INVALID_OAUTH_STATE"
      | "OAUTH_EXCHANGE_FAILED"
      | "SESSION_EXPIRED"
      | "TOKEN_EXPIRED"
      | "MISSING_ENCRYPTION_KEY",
    message: string,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export type StoredToken = {
  accessToken: string;
  refreshToken?: string;
};

const ALLOWED_REDIRECTS = new Set(["/", "/#setup"]);

export function deployerAuthStatus(env: Env) {
  return {
    oauthConfigured: readOAuthConfig(env) !== null,
    stage: {
      oauthLiveVerified: false,
      writesEnabled: hasReleaseSource(env),
    },
  };
}

export async function beginOAuthLogin(
  env: Env,
  redirectPath = "/#setup",
): Promise<{ authorizeUrl: string; state: string; expiresAt: string }> {
  const config = readOAuthConfig(env);
  if (!config) {
    throw new AuthServiceError(
      "OAUTH_NOT_CONFIGURED",
      "維護者尚未設定 Cloudflare OAuth client。",
    );
  }
  const path = ALLOWED_REDIRECTS.has(redirectPath) ? redirectPath : "/#setup";
  const state = randomToken(32);
  const pkce = await createPkceChallenge();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString();
  await insertOAuthState(env.DB, {
    state,
    codeVerifier: pkce.verifier,
    redirectPath: path,
    createdAt: now.toISOString(),
    expiresAt,
  });
  return {
    authorizeUrl: buildAuthorizeUrl(config, {
      state,
      challenge: pkce.challenge,
    }),
    state,
    expiresAt,
  };
}

export async function completeOAuthLogin(
  env: Env,
  input: { code: string; state: string },
): Promise<{ session: PublicSession; redirectPath: string }> {
  const config = readOAuthConfig(env);
  if (!config) {
    throw new AuthServiceError(
      "OAUTH_NOT_CONFIGURED",
      "維護者尚未設定 Cloudflare OAuth client。",
    );
  }
  if (!env.SESSION_ENCRYPTION_KEY) {
    throw new AuthServiceError(
      "MISSING_ENCRYPTION_KEY",
      "部署服務尚未設定 session 加密金鑰。",
    );
  }
  const now = new Date();
  const pending = await consumeOAuthState(env.DB, input.state, now);
  if (!pending) {
    throw new AuthServiceError(
      "INVALID_OAUTH_STATE",
      "授權狀態無效或已過期，請重新登入。",
    );
  }
  try {
    const tokens = await exchangeAuthorizationCode(config, {
      code: input.code,
      verifier: pending.codeVerifier,
      now,
    });
    const oauthSub = await readOAuthSubject(tokens.accessToken);
    const sessionId = randomToken(32);
    const csrfToken = randomToken(32);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const row: SessionRow = {
      id: sessionId,
      oauthSub,
      selectedAccountId: null,
      encryptedAccessToken: await encryptJson(
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        } satisfies StoredToken,
        env.SESSION_ENCRYPTION_KEY,
      ),
      tokenExpiresAt: tokens.expiresAt,
      csrfToken,
      createdAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
    };
    await insertSession(env.DB, row);
    return {
      redirectPath: pending.redirectPath,
      session: {
        id: sessionId,
        oauthSub,
        selectedAccountId: null,
        tokenExpiresAt: tokens.expiresAt,
        csrfToken,
        expiresAt,
      },
    };
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    if (error instanceof OAuthExchangeError) {
      throw new AuthServiceError(
        "OAUTH_EXCHANGE_FAILED",
        "無法完成 Cloudflare 授權，請重試。",
      );
    }
    throw error;
  }
}

export async function readAccessToken(env: Env, sessionId: string) {
  if (!env.SESSION_ENCRYPTION_KEY) {
    throw new AuthServiceError(
      "MISSING_ENCRYPTION_KEY",
      "部署服務尚未設定 session 加密金鑰。",
    );
  }
  const session = await getSession(env.DB, sessionId, new Date());
  if (!session) {
    throw new AuthServiceError("SESSION_EXPIRED", "登入已過期，請重新授權。");
  }
  if (session.tokenExpiresAt <= new Date().toISOString()) {
    throw new AuthServiceError(
      "TOKEN_EXPIRED",
      "Cloudflare 授權已過期，請重新授權後續跑。",
    );
  }
  const stored = await decryptJson<StoredToken>(
    session.encryptedAccessToken,
    env.SESSION_ENCRYPTION_KEY,
  );
  return { session, accessToken: stored.accessToken };
}

export async function selectAccount(
  env: Env,
  session: PublicSession,
  accountId: string,
  authorizedAccountIds: string[],
) {
  if (!authorizedAccountIds.includes(accountId)) {
    return null;
  }
  await updateSelectedAccount(env.DB, session.id, accountId);
  return { ...session, selectedAccountId: accountId };
}

export async function logoutSession(env: Env, session: PublicSession | null) {
  if (!session) return;
  const config = readOAuthConfig(env);
  try {
    if (config && env.SESSION_ENCRYPTION_KEY) {
      const { accessToken } = await readAccessToken(env, session.id);
      await revokeOAuthToken(config, accessToken);
    }
  } catch {
    // Clearing the local session is still required if Cloudflare revoke fails.
  }
  await revokeSession(env.DB, session.id, new Date());
}
