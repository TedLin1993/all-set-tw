import { afterAll, afterEach, beforeAll } from "vitest";
import { vi } from "vitest";
import { app } from "../src/index";
import type { DeployQueueMessage, Env } from "../src/platform/env";
import {
  OAUTH_REVOKE_URL,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
} from "../src/platform/oauth";
import { CLOUDFLARE_API_BASE } from "../src/platform/cloudflare";
import { createTestD1 } from "../testing/d1";
import {
  createFakeCloudflare,
  handleCloudflareApi,
} from "./platform/fake-cloudflare";

export const TARGET_DIGEST = "a".repeat(64);

export function queuedMessages(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.map((call) => call[0] as DeployQueueMessage);
}

export async function createDeployerEnv(options?: {
  accounts?: Array<{ id: string; name: string }>;
  subdomain?: boolean;
  organization?: boolean;
  existingWorkers?: string[];
  existingD1?: string[];
  existingQueues?: string[];
  tokenExpiresIn?: number;
  subjects?: Record<string, string>;
  localDevMode?: boolean;
  expireOnWrite?: boolean;
  releaseBucket?: R2Bucket;
}) {
  const harness = await createTestD1();
  const send = vi.fn().mockResolvedValue(undefined);
  const localDevMode = options?.localDevMode ?? true;
  const env = {
    DB: harness.binding,
    DEPLOY_QUEUE: { send } as unknown as Queue<DeployQueueMessage>,
    OAUTH_CLIENT_ID: "test-client",
    OAUTH_CLIENT_SECRET: "test-secret",
    OAUTH_REDIRECT_URI: "http://localhost/api/auth/callback",
    SESSION_ENCRYPTION_KEY: "test-session-key",
    LOCAL_DEV_MODE: localDevMode,
    ...(options?.releaseBucket
      ? { RELEASE_BUCKET: options.releaseBucket }
      : {}),
  } as Env;
  const accounts = options?.accounts ?? [
    { id: "acct-1", name: "Primary" },
    { id: "acct-2", name: "Other" },
  ];
  const subjects = options?.subjects ?? { ok: "user-a", "user-b": "user-b" };
  const cloudflare = createFakeCloudflare(options);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === OAUTH_TOKEN_URL) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        return Response.json({
          access_token: `token-${body.get("code") ?? "ok"}`,
          expires_in: options?.tokenExpiresIn ?? 3600,
        });
      }
      if (url === OAUTH_USERINFO_URL) {
        const token = new Headers(init?.headers)
          .get("Authorization")
          ?.replace("Bearer ", "");
        const code = (token ?? "").replace("token-", "");
        return Response.json({ sub: subjects[code] ?? "user-a" });
      }
      if (url === OAUTH_REVOKE_URL) return new Response(null, { status: 200 });
      if (url.startsWith(`${CLOUDFLARE_API_BASE}/memberships`)) {
        return Response.json({
          result: accounts.map((account) => ({ account })),
        });
      }
      if (url.includes(".workers.dev")) {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://example.cloudflareaccess.com/cdn-cgi/access/login",
          },
        });
      }
      const handled = await handleCloudflareApi(cloudflare, url, init);
      if (handled) return handled;
      return new Response("unhandled", { status: 500 });
    }),
  );

  return { env, send, harness, cloudflare };
}

export function useDeployerD1() {
  let harness: Awaited<ReturnType<typeof createTestD1>> | undefined;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  return () => harness!;
}

export function cookieHeader(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("all_set_deployer_session="));
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";")[0]!;
}

export function oauthStateCookieHeader(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("all_set_deployer_oauth_state="));
  if (!cookie) throw new Error("Missing OAuth state cookie");
  return cookie.split(";")[0]!;
}

export async function login(
  env: Env,
  code = "ok",
): Promise<{ cookie: string; csrf: string; sub: string }> {
  const loginResponse = await app.request(
    "http://localhost/api/auth/login",
    {},
    env,
  );
  const location = loginResponse.headers.get("location");
  if (!location) throw new Error("Missing OAuth redirect");
  const state = new URL(location).searchParams.get("state");
  const callback = await app.request(
    `http://localhost/api/auth/callback?code=${code}&state=${state}`,
    { headers: { Cookie: oauthStateCookieHeader(loginResponse) } },
    env,
  );
  const cookie = cookieHeader(callback);
  const me = await app.request(
    "http://localhost/api/auth/me",
    { headers: { Cookie: cookie } },
    env,
  );
  const body = (await me.json()) as { csrfToken: string; sub: string };
  return { cookie, csrf: body.csrfToken, sub: body.sub };
}

export function authHeaders(session: { cookie: string; csrf: string }) {
  return {
    Cookie: session.cookie,
    "X-CSRF-Token": session.csrf,
    "Content-Type": "application/json",
  };
}
