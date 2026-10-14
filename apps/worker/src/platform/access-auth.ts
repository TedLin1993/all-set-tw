export interface AccessAuthEnv {
  TEAM_DOMAIN: string;
  POLICY_AUD?: string;
  POLICY_AUDS?: string;
}

type AccessJwtPayload = {
  aud?: string | string[];
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  type?: string;
};

type AccessJwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type AccessJwks = {
  keys: Array<JsonWebKey & { kid?: string }>;
};

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

// Per-isolate only: the Cache API is unavailable to Workers behind Access.
// Concurrent cold requests share one fetch, and imported keys are reused.
let cachedJwks:
  { url: string; expiresAt: number; value: Promise<AccessJwks> } | undefined;
const verifyKeys = new Map<string, Promise<CryptoKey>>();

export async function verifyAccessIdentity(
  request: Request,
  env: AccessAuthEnv,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = accessJwtFromRequest(request);
  if (!token) {
    return { ok: false, message: "Cloudflare Access JWT is required." };
  }

  try {
    await verifyAccessJwt(token, env);
    return { ok: true };
  } catch {
    return { ok: false, message: "Cloudflare Access JWT is invalid." };
  }
}

function accessJwtFromRequest(request: Request) {
  const headerToken = request.headers.get("Cf-Access-Jwt-Assertion");
  if (headerToken) return headerToken;

  const cookie = request.headers.get("Cookie");
  if (!cookie) return undefined;

  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === "CF_Authorization") {
      return valueParts.join("=");
    }
  }

  return undefined;
}

async function verifyAccessJwt(token: string, env: AccessAuthEnv) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT.");

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  const header = JSON.parse(
    decodeBase64UrlToString(encodedHeader),
  ) as AccessJwtHeader;
  const payload = JSON.parse(
    decodeBase64UrlToString(encodedPayload),
  ) as AccessJwtPayload;

  if (header.alg !== "RS256" || !header.kid)
    throw new Error("Unsupported JWT header.");

  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const key = await getVerifyKey(teamDomain, header.kid);
  const signatureValid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    decodeBase64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!signatureValid) throw new Error("Invalid JWT signature.");

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== teamDomain) throw new Error("Invalid JWT issuer.");
  if (!audienceMatches(payload.aud, acceptedAudiences(env)))
    throw new Error("Invalid JWT audience.");
  if (typeof payload.exp !== "number" || payload.exp <= now)
    throw new Error("Expired JWT.");
  if (typeof payload.nbf === "number" && payload.nbf > now)
    throw new Error("JWT not valid yet.");

  return payload;
}

async function getVerifyKey(teamDomain: string, kid: string) {
  const jwks = getAccessJwks(teamDomain);
  const cacheKey = `${teamDomain}\u0000${kid}`;
  const cached = verifyKeys.get(cacheKey);
  if (cached) return cached;

  const key = jwks.then((value) => {
    const jwk = value.keys.find((candidate) => candidate.kid === kid);
    if (!jwk) throw new Error("JWT signing key not found.");
    return crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  });
  verifyKeys.set(cacheKey, key);
  key.catch(() => {
    if (verifyKeys.get(cacheKey) === key) verifyKeys.delete(cacheKey);
  });
  return key;
}

function getAccessJwks(teamDomain: string) {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const now = Date.now();
  if (cachedJwks?.url === url && cachedJwks.expiresAt > now) {
    return cachedJwks.value;
  }

  const value = fetchAccessJwks(url);
  const entry = { url, expiresAt: now + JWKS_CACHE_TTL_MS, value };
  cachedJwks = entry;
  // Imported keys belong to the previous JWKS response.
  verifyKeys.clear();
  value.catch(() => {
    if (cachedJwks === entry) cachedJwks = undefined;
  });
  return value;
}

async function fetchAccessJwks(url: string) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error("Could not fetch Cloudflare Access signing keys.");

  return response.json<AccessJwks>();
}

function normalizeTeamDomain(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
}

function acceptedAudiences(env: AccessAuthEnv) {
  const values = [env.POLICY_AUD, env.POLICY_AUDS]
    .flatMap((value) => value?.split(/[\s,]+/) ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (values.length === 0) throw new Error("No JWT audiences configured.");

  return values;
}

function audienceMatches(
  aud: string | string[] | undefined,
  expected: string[],
) {
  if (!aud) return false;
  const actual = Array.isArray(aud) ? aud : [aud];
  return actual.some((value) => expected.includes(value));
}

function decodeBase64UrlToString(value: string) {
  return new TextDecoder().decode(decodeBase64UrlToBytes(value));
}

function decodeBase64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
