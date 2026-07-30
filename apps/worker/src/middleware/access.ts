import { verifyAccessIdentity } from "../platform/access-auth";
import type { Env } from "../platform/env";
import { honoFactory } from "../platform/hono";
import { isDemoMode } from "../platform/http";

const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalDevRequest(
  request: Request,
  env: Pick<Env, "LOCAL_DEV_MODE">,
) {
  const enabled =
    env.LOCAL_DEV_MODE === true ||
    (typeof env.LOCAL_DEV_MODE === "string" &&
      ["1", "true", "yes", "on"].includes(
        env.LOCAL_DEV_MODE.trim().toLowerCase(),
      ));

  return enabled && LOCAL_DEV_HOSTS.has(new URL(request.url).hostname);
}

function requireAccessSecrets(
  env: Env,
): asserts env is Env & { TEAM_DOMAIN: string } {
  if (!env.TEAM_DOMAIN || (!env.POLICY_AUD && !env.POLICY_AUDS)) {
    throw new Error(
      "TEAM_DOMAIN and POLICY_AUD or POLICY_AUDS are required unless DEMO_MODE is enabled.",
    );
  }
}

export const accessMiddleware = honoFactory.createMiddleware(
  async (c, next) => {
    if (isDemoMode(c.env) || isLocalDevRequest(c.req.raw, c.env)) {
      await next();
      return;
    }

    requireAccessSecrets(c.env);
    const identity = await verifyAccessIdentity(c.req.raw, c.env);
    if (!identity.ok) {
      return c.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: identity.message,
          },
        },
        401,
      );
    }

    await next();
  },
);
