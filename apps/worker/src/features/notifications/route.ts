import type {
  NotificationPreferences,
  PushSubscriptionInput,
} from "@taiwan-fin-hub/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import {
  getNotificationConfig,
  PushNotificationConfigurationError,
  registerPushSubscription,
  sendTestNotification,
  unregisterPushSubscription,
  updateNotificationPreferences,
} from "./service";

const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  expirationTime: z.number().int().nonnegative().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

const preferencesSchema = z.object({
  success: z.boolean(),
  failed: z.boolean(),
  needsUserAction: z.boolean(),
});

export const notificationRoutes = honoFactory.createApp();
registerNotificationRoutes(notificationRoutes);

function registerNotificationRoutes(api: Hono<AppBindings>) {
  api.get("/notifications/config", async (c) =>
    c.json(await getNotificationConfig(c.env)),
  );

  api.post(
    "/notifications/subscriptions",
    zValidator(
      "json",
      pushSubscriptionSchema,
      validationHook("INVALID_REQUEST", "Push subscription is invalid."),
    ),
    async (c) => {
      try {
        const input = c.req.valid("json") as PushSubscriptionInput;
        return c.json(await registerPushSubscription(c.env, input), 201);
      } catch (error) {
        if (error instanceof Error && /endpoint/.test(error.message)) {
          return jsonError("INVALID_PUSH_SUBSCRIPTION", error.message, 400);
        }
        throw error;
      }
    },
  );

  api.delete("/notifications/subscriptions/:id", async (c) =>
    c.json(await unregisterPushSubscription(c.env, c.req.param("id"))),
  );

  api.put(
    "/notifications/preferences",
    zValidator(
      "json",
      preferencesSchema,
      validationHook(
        "INVALID_REQUEST",
        "Notification preferences are invalid.",
      ),
    ),
    async (c) => {
      const input = c.req.valid("json") as NotificationPreferences;
      return c.json(await updateNotificationPreferences(c.env, input));
    },
  );

  api.post("/notifications/test", async (c) => {
    try {
      return c.json(await sendTestNotification(c.env));
    } catch (error) {
      if (error instanceof PushNotificationConfigurationError) {
        return jsonError(
          "PUSH_NOT_CONFIGURED",
          "推播尚未完成伺服器設定。",
          503,
        );
      }
      throw error;
    }
  });
}
