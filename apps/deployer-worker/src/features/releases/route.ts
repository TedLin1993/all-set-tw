import type { Hono } from "hono";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { requireSession } from "../../middleware/session";
import { currentRelease, ReleaseUnavailableError } from "./service";

export const releaseRoutes = honoFactory.createApp();
registerReleaseRoutes(releaseRoutes);

function registerReleaseRoutes(api: Hono<AppBindings>) {
  api.get("/releases/current", async (c) => {
    const session = c.get("session");
    const unauthorized = requireSession(session);
    if (unauthorized) return unauthorized;
    try {
      const release = await currentRelease(c.env);
      return c.json(release);
    } catch (error) {
      if (error instanceof ReleaseUnavailableError) {
        return jsonError(error.code, "維護者尚未發布可安裝的版本包。", 503);
      }
      throw error;
    }
  });
}
