import type {
  NotificationConfig,
  NotificationPreferences,
  PaymentReminder,
  PushSubscriptionInput,
} from "@taiwan-fin-hub/shared";
import { collectPaymentReminders, taipeiDateKey } from "@taiwan-fin-hub/shared";
import { sanitizeDatabaseError } from "../../db";
import { getBankAccounts, getCreditCardBillsRange } from "../bank/service";
import { getExchangeRates } from "../exchange-rates/service";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { isDemoMode } from "../../platform/http";
import {
  countPushSubscriptions,
  getNotificationPreferences,
  listMaturingTimeDeposits,
  listPushSubscriptions,
  markPushFailure,
  markPushSuccess,
  normalizePushSubscription,
  removePushSubscription,
  saveNotificationPreferences,
  upsertPushSubscription,
} from "./repository";
import {
  collectMaturityReminders,
  type MaturityReminder,
} from "./deposit-maturity";
import {
  scheduledSummaryNotification,
  shouldNotify,
  summaryStatus,
  syncNotificationPayload,
  type PushNotificationPayload,
  type SyncNotificationEvent,
} from "./payload";
import webpush, { WebPushError } from "web-push";

export class PushNotificationConfigurationError extends Error {}

const DEFAULT_VAPID_SUBJECT = "mailto:admin@example.com";

type VapidConfiguration = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

function vapidConfiguration(env: Env): VapidConfiguration | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;

  return {
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT,
  };
}

export function isPushConfigured(env: Env) {
  return vapidConfiguration(env) !== null;
}

function requirePushConfiguration(env: Env) {
  const configuration = vapidConfiguration(env);
  if (!configuration) {
    throw new PushNotificationConfigurationError(
      "VAPID public and private keys are not configured.",
    );
  }
  return configuration;
}

export async function getNotificationConfig(
  env: Env,
): Promise<NotificationConfig> {
  if (isDemoMode(env)) {
    return {
      enabled: false,
      publicKey: null,
      subscribedDevices: 0,
      preferences: {
        success: false,
        failed: true,
        needsUserAction: true,
        paymentDue: true,
      },
    };
  }
  const configuration = vapidConfiguration(env);
  return {
    enabled: configuration !== null,
    publicKey: configuration?.publicKey ?? null,
    subscribedDevices: await countPushSubscriptions(env.DB),
    preferences: await getNotificationPreferences(env.DB),
  };
}

export async function registerPushSubscription(
  env: Env,
  input: PushSubscriptionInput,
) {
  validatePushEndpoint(input.endpoint);
  const normalized = normalizePushSubscription(input);
  const id = await endpointId(normalized.endpoint);
  const now = new Date().toISOString();
  await upsertPushSubscription(env.DB, {
    id,
    encryptedSubscription: await encryptJson(
      normalized,
      configEncryptionKey(env),
    ),
    now,
  });
  return { id };
}

export async function unregisterPushSubscription(env: Env, id: string) {
  await removePushSubscription(env.DB, id);
  return { success: true as const };
}

export async function updateNotificationPreferences(
  env: Env,
  input: Omit<NotificationPreferences, "paymentDue"> & {
    paymentDue?: boolean;
  },
) {
  // 尚未更新的已安裝 App 不會送出 paymentDue；保留目前設定。
  const preferences: NotificationPreferences = {
    ...input,
    paymentDue:
      input.paymentDue ?? (await getNotificationPreferences(env.DB)).paymentDue,
  };
  await saveNotificationPreferences(
    env.DB,
    preferences,
    new Date().toISOString(),
  );
  return preferences;
}

export async function sendTestNotification(env: Env) {
  requirePushConfiguration(env);
  return deliverPushPayload(env, {
    title: "推播測試成功",
    body: "「不用記帳」已經可以通知你同步狀態。",
    url: "/#/settings",
    tag: "notification-test",
  });
}

export async function safelySendSyncNotification(
  env: Env,
  event: SyncNotificationEvent,
) {
  try {
    const preferences = await getNotificationPreferences(env.DB);
    if (!shouldNotify(preferences, event.status)) return;
    if (!isPushConfigured(env)) {
      console.warn("[notifications] skipped: VAPID keys are not configured");
      return;
    }
    await deliverPushPayload(env, syncNotificationPayload(event));
  } catch (error) {
    const safeError = sanitizeDatabaseError(error);
    console.error(
      JSON.stringify({
        event: "push_notification_failed",
        connectorId: event.connectorId,
        status: event.status,
        message:
          safeError instanceof Error ? safeError.message : String(safeError),
      }),
    );
  }
}

export async function safelySendScheduledSyncSummary(
  env: Env,
  events: SyncNotificationEvent[],
) {
  const status = summaryStatus(events);
  try {
    const preferences = await getNotificationPreferences(env.DB);
    const [reminders, maturities] = preferences.paymentDue
      ? await Promise.all([
          safelyLoadPaymentReminders(env.DB),
          safelyLoadMaturityReminders(env.DB),
        ])
      : [[], []];
    const payload = scheduledSummaryNotification(
      preferences,
      events,
      reminders,
      maturities,
    );
    if (!payload) return;
    if (!isPushConfigured(env)) {
      console.warn("[notifications] skipped: VAPID keys are not configured");
      return;
    }
    await deliverPushPayload(env, payload);
  } catch (error) {
    const safeError = sanitizeDatabaseError(error);
    console.error(
      JSON.stringify({
        event: "push_notification_failed",
        scheduleMode: "inherit",
        status,
        message:
          safeError instanceof Error ? safeError.message : String(safeError),
      }),
    );
  }
}

/**
 * 讀取繳款提醒。匯率只用於外幣款項由台幣帳戶扣繳時的換算，讀取失敗時以空
 * 匯率表繼續，該類款項維持原提醒；帳戶或帳單讀取失敗時拋出錯誤。
 */
export async function loadPaymentReminders(
  db: D1Database,
  now = new Date(),
): Promise<PaymentReminder[]> {
  // 本月到期的帳單通常屬於上一或上上期別，與總覽查詢的範圍相同。
  const [year, month] = taipeiDateKey(now).split("-").map(Number);
  const monthStart = (offset: number) => {
    const date = new Date(Date.UTC(year!, month! - 1 + offset, 1));
    return date.toISOString().slice(0, 10);
  };
  const [accounts, bills, rates] = await Promise.all([
    getBankAccounts(db),
    getCreditCardBillsRange(db, { from: monthStart(-2), to: monthStart(1) }),
    getExchangeRates(db).catch((error: unknown) => {
      const safeError = sanitizeDatabaseError(error);
      console.error(
        JSON.stringify({
          event: "payment_reminder_rates_load_failed",
          message:
            safeError instanceof Error ? safeError.message : String(safeError),
        }),
      );
      return [];
    }),
  ]);
  const ratesToTwd = Object.fromEntries(
    rates.map((rate) => [rate.currency, rate.rateTwd]),
  );
  return collectPaymentReminders(accounts, bills, now, ratesToTwd).reminders;
}

/** 繳款提醒只是同步摘要的附加資訊；讀取失敗時記錄 log 並照常送出摘要。 */
export async function safelyLoadPaymentReminders(
  db: D1Database,
  now = new Date(),
): Promise<PaymentReminder[]> {
  try {
    return await loadPaymentReminders(db, now);
  } catch (error) {
    const safeError = sanitizeDatabaseError(error);
    console.error(
      JSON.stringify({
        event: "payment_reminder_load_failed",
        message:
          safeError instanceof Error ? safeError.message : String(safeError),
      }),
    );
    return [];
  }
}

/** 定存到期提醒同樣是附加資訊；讀取失敗只記錄 log，照常送出同步摘要。 */
export async function safelyLoadMaturityReminders(
  db: D1Database,
  now = new Date(),
): Promise<MaturityReminder[]> {
  try {
    const rows = await listMaturingTimeDeposits(db, taipeiDateKey(now));
    return collectMaturityReminders(rows, now);
  } catch (error) {
    const safeError = sanitizeDatabaseError(error);
    console.error(
      JSON.stringify({
        event: "maturity_reminder_load_failed",
        message:
          safeError instanceof Error ? safeError.message : String(safeError),
      }),
    );
    return [];
  }
}

async function deliverPushPayload(env: Env, payload: PushNotificationPayload) {
  const { publicKey, privateKey, subject } = requirePushConfiguration(env);
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const subscriptions = await listPushSubscriptions(env.DB);
  const encryptionKey = configEncryptionKey(env);
  let delivered = 0;
  let removed = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (row) => {
      let subscription: PushSubscriptionInput | undefined;
      try {
        subscription = await decryptJson<PushSubscriptionInput>(
          row.encrypted_subscription,
          encryptionKey,
        );
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          TTL: 60 * 60,
          urgency: payload.tag.includes("needs-action") ? "high" : "normal",
          // Keep the semantic tag in the encrypted payload; Apple rejects it as a raw Web Push Topic.
        });
        delivered += 1;
        await markPushSuccess(env.DB, row.id, new Date().toISOString());
      } catch (error) {
        const statusCode = error instanceof WebPushError ? error.statusCode : 0;
        if (statusCode === 404 || statusCode === 410) {
          await removePushSubscription(env.DB, row.id);
          removed += 1;
          return;
        }
        failed += 1;
        await markPushFailure(env.DB, row.id, new Date().toISOString());
        const details = pushDeliveryFailureDetails(
          error,
          subscription?.endpoint,
        );
        console.warn(
          JSON.stringify({
            event: "push_subscription_delivery_failed",
            subscriptionId: row.id,
            ...details,
          }),
        );
      }
    }),
  );

  return { delivered, failed, removed, attempted: subscriptions.length };
}

function pushDeliveryFailureDetails(error: unknown, endpoint?: string) {
  if (!(error instanceof WebPushError)) {
    return { statusCode: 0 };
  }

  const responseBody = error.body?.trim();
  let reason: string | undefined;
  if (responseBody) {
    try {
      const parsed: unknown = JSON.parse(responseBody);
      if (
        parsed &&
        typeof parsed === "object" &&
        "reason" in parsed &&
        typeof parsed.reason === "string"
      ) {
        reason = parsed.reason.slice(0, 128);
      }
    } catch {
      // Keep the truncated response body below for non-JSON push service errors.
    }
  }

  return {
    statusCode: error.statusCode,
    ...(reason ? { reason } : {}),
    ...(responseBody ? { responseBody: responseBody.slice(0, 512) } : {}),
    ...(error.headers["apns-id"]
      ? { pushServiceRequestId: error.headers["apns-id"] }
      : {}),
    ...(endpoint ? { endpointHost: safeEndpointHostname(endpoint) } : {}),
  };
}

function safeEndpointHostname(endpoint: string) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid";
  }
}

function validatePushEndpoint(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Push subscription endpoint must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    isPrivateHostname(parsed.hostname)
  ) {
    throw new Error("Push subscription endpoint must be a public HTTPS URL.");
  }
}

function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase();
  if (host.includes(":")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  )
    return true;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  return Boolean(
    private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31,
  );
}

async function endpointId(endpoint: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
