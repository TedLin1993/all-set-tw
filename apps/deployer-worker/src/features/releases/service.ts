import {
  ReleaseUnavailableError,
  readCurrentRelease,
} from "../../platform/release";
import type { Env } from "../../platform/env";

export async function currentRelease(env: Env) {
  return readCurrentRelease(env);
}

export { ReleaseUnavailableError };
