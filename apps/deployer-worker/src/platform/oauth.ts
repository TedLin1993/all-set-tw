import { randomToken, sha256Base64url } from "./crypto";
import type { Env } from "./env";

export const OAUTH_AUTHORIZE_URL =
  "https://dash.cloudflare.com/oauth2/authorize";
export const OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
export const OAUTH_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
export const OAUTH_USERINFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";

/** Scope IDs confirmed by GET /oauth/scopes; live consent is not yet verified. */
export const DEPLOYER_OAUTH_SCOPES = [
  "memberships.read",
  "workers-scripts.read",
  "workers-scripts.write",
  "d1.read",
  "d1.write",
  "queues.read",
  "queues.write",
  "access.read",
  "access.write",
  "access-org.read",
  "access-idp.read",
  "access-idp.write",
] as const;

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope?: string;
};

export class OAuthExchangeError extends Error {
  constructor(public readonly status: number) {
    super("OAuth token exchange failed.");
    this.name = "OAuthExchangeError";
  }
}

export function readOAuthConfig(env: Env): OAuthConfig | null {
  if (
    !env.OAUTH_CLIENT_ID ||
    !env.OAUTH_CLIENT_SECRET ||
    !env.OAUTH_REDIRECT_URI
  ) {
    return null;
  }
  return {
    clientId: env.OAUTH_CLIENT_ID,
    clientSecret: env.OAUTH_CLIENT_SECRET,
    redirectUri: env.OAUTH_REDIRECT_URI,
  };
}

export async function createPkceChallenge() {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256Base64url(verifier) };
}

export function buildAuthorizeUrl(
  config: OAuthConfig,
  input: { state: string; challenge: string },
) {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", DEPLOYER_OAUTH_SCOPES.join(" "));
  return url.toString();
}

export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  input: { code: string; verifier: string; now?: Date },
): Promise<OAuthTokens> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code: input.code,
      code_verifier: input.verifier,
    }),
  });
  if (!response.ok) throw new OAuthExchangeError(response.status);
  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) throw new OAuthExchangeError(response.status);
  const now = input.now ?? new Date();
  const expiresIn = Number.isFinite(body.expires_in)
    ? Math.max(1, Number(body.expires_in))
    : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    scope: body.scope,
  };
}

export async function readOAuthSubject(accessToken: string) {
  const response = await fetch(OAUTH_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new OAuthExchangeError(response.status);
  const body = (await response.json()) as { sub?: string };
  if (!body.sub) throw new OAuthExchangeError(response.status);
  return body.sub;
}

export async function revokeOAuthToken(
  config: OAuthConfig,
  token: string,
): Promise<void> {
  const response = await fetch(OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  if (!response.ok) throw new OAuthExchangeError(response.status);
}
