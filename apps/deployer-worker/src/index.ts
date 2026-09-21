import { authRoutes } from "./features/auth/route";
import { consumeDeployQueue } from "./features/deployments/service";
import { installationRoutes } from "./features/installations/route";
import { precheckRoutes } from "./features/precheck/route";
import { releaseRoutes } from "./features/releases/route";
import { sessionMiddleware } from "./middleware/session";
import type { DeployQueueMessage, Env } from "./platform/env";
import { honoFactory } from "./platform/hono";
import { apiErrorResponse } from "./platform/http";

export const app = honoFactory.createApp();
export const api = honoFactory.createApp();

api.use("*", sessionMiddleware);
api.route("/", authRoutes);
api.route("/", precheckRoutes);
api.route("/", releaseRoutes);
api.route("/", installationRoutes);
api.onError(apiErrorResponse);

app.route("/api", api);
app.get("*", async (c) => {
  if (!c.env.ASSETS) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<DeployQueueMessage>, env) {
    await consumeDeployQueue(batch, env);
  },
} satisfies ExportedHandler<Env, DeployQueueMessage>;
