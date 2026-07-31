import { activityRoutes } from "./features/activity/route";
import { bankCalculationRoutes } from "./features/bank/calculation-route";
import { bankRoutes } from "./features/bank/route";
import { classificationRoutes } from "./features/classification/route";
import { connectorRoutes } from "./features/connectors/route";
import { dashboardRoutes } from "./features/dashboard/route";
import { exchangeRateRoutes } from "./features/exchange-rates/route";
import { investmentRoutes } from "./features/investments/route";
import { invoiceRoutes } from "./features/invoices/route";
import { manualAssetRoutes } from "./features/manual-assets/route";
import { netWorthRoutes } from "./features/net-worth/route";
import { notificationRoutes } from "./features/notifications/route";
import { ocrRoutes } from "./features/ocr/route";
import { syncRoutes } from "./features/sync/route";
import { syncScheduleRoutes } from "./features/sync/schedule-route";
import {
  consumeScheduledSyncQueue,
  enqueueScheduledSync,
} from "./features/sync/scheduler-queue";
import { accessMiddleware } from "./middleware/access";
import { connectorContextMiddleware } from "./middleware/connector-context";
import type { Env, ScheduledSyncQueueMessage } from "./platform/env";
import { honoFactory } from "./platform/hono";
import { apiErrorResponse, demoReadOnlyMiddleware } from "./platform/http";

export const app = honoFactory.createApp();
export const api = honoFactory.createApp();

api.use("*", accessMiddleware);
api.use("*", demoReadOnlyMiddleware);
api.use("/connectors/:connectorId/*", connectorContextMiddleware);

api.route("/", manualAssetRoutes);
api.route("/", exchangeRateRoutes);
api.route("/", invoiceRoutes);
api.route("/", classificationRoutes);
api.route("/", activityRoutes);
api.route("/", bankCalculationRoutes);
api.route("/", dashboardRoutes);
api.route("/", ocrRoutes);
api.route("/", investmentRoutes);
api.route("/", bankRoutes);
api.route("/", netWorthRoutes);
api.route("/", notificationRoutes);
api.route("/", connectorRoutes);
api.route("/", syncScheduleRoutes);
api.route("/", syncRoutes);

api.onError(apiErrorResponse);
app.route("/api", api);
app.get("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(enqueueScheduledSync(env));
  },
  async queue(batch: MessageBatch<ScheduledSyncQueueMessage>, env) {
    await consumeScheduledSyncQueue(batch, env);
  },
} satisfies ExportedHandler<Env, ScheduledSyncQueueMessage>;
