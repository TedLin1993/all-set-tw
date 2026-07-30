import {
  CtbcConnectionError,
  type CtbcFetch,
} from "@taiwan-fin-hub/connectors";
import type { Env } from "../platform/env";

type RelayFetch = typeof globalThis.fetch;

/**
 * Local workerd cannot negotiate CTBC's TLS endpoint even though production
 * Workers can. `npm run dev` starts a loopback-only Node relay and injects its
 * one-time URL/token. Production and remote dev continue to fetch CTBC direct.
 */
export function createCtbcFetch(
  env: Pick<
    Env,
    "LOCAL_DEV_MODE" | "CTBC_API_RELAY_URL" | "CTBC_API_RELAY_TOKEN"
  >,
  relayFetch: RelayFetch = globalThis.fetch.bind(globalThis),
): CtbcFetch | undefined {
  if (!isLocalDev(env.LOCAL_DEV_MODE)) return undefined;
  const relayUrl = env.CTBC_API_RELAY_URL?.trim();
  const relayToken = env.CTBC_API_RELAY_TOKEN?.trim();
  if (!relayUrl && !relayToken) return undefined;
  if (!relayUrl || !relayToken) {
    throw new CtbcConnectionError("中國信託本機同步 relay 設定不完整。");
  }

  return async (input, init = {}) => {
    if (init.method && init.method.toUpperCase() !== "POST") {
      throw new CtbcConnectionError("中國信託本機同步只允許唯讀查詢流程。");
    }
    const body = init.body;
    if (body != null && typeof body !== "string") {
      throw new CtbcConnectionError("中國信託本機同步 request 格式不支援。");
    }
    const targetHeaders = Object.fromEntries(new Headers(init.headers));
    return relayFetch(relayUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-ctbc-relay-token": relayToken,
      },
      body: JSON.stringify({
        url: String(input),
        method: "POST",
        headers: targetHeaders,
        body: body ?? "",
      }),
      signal: init.signal,
    });
  };
}

function isLocalDev(value: string | boolean | undefined) {
  if (value === true) return true;
  return (
    typeof value === "string" &&
    ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
}
