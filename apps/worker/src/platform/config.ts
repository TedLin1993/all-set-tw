import type { Env } from "./env";

export function configEncryptionKey(env: Env) {
  if (!env.CONFIG_ENCRYPTION_KEY) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is required for connector settings and sync.",
    );
  }
  return env.CONFIG_ENCRYPTION_KEY;
}
