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
import { syncReportRoutes } from "./features/sync/reports/route";
import { syncScheduleRoutes } from "./features/sync/scheduling/route";
import {
  consumeScheduledSyncQueue,
  enqueueScheduledSync,
} from "./features/sync/scheduling/queue";
import { accessMiddleware } from "./middleware/access";
import { safelyKickAiClassification } from "./features/classification/ai-service";
import { connectorContextMiddleware } from "./middleware/connector-context";
import type { Env, SyncQueueMessage } from "./platform/env";
import { honoFactory } from "./platform/hono";
import {
  apiErrorResponse,
  demoReadOnlyMiddleware,
  isDemoMode,
} from "./platform/http";

export { MegabankEgress } from "./platform/megabank-egress-object";
export { FubonEgress } from "./platform/fubon-egress-object";
export { CryptoBrowserEgress } from "./platform/crypto-browser-egress-object";

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
api.route("/", syncReportRoutes);
api.route("/", syncRoutes);

api.onError(apiErrorResponse);
app.route("/api", api);
app.get("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(enqueueScheduledSync(env));
    // Demo deployments never start background work.
    if (!isDemoMode(env)) ctx.waitUntil(safelyKickAiClassification(env));
  },
  async queue(batch: MessageBatch<SyncQueueMessage>, env) {
    await consumeScheduledSyncQueue(batch, env);
  },
} satisfies ExportedHandler<Env, SyncQueueMessage>;
