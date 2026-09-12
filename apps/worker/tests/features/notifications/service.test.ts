import { afterEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { DrizzleQueryError } from "drizzle-orm";
import type { Env } from "../../../src/platform/env";
import { encryptJson } from "../../../src/platform/crypto";
import {
  sendTestNotification,
  safelySendSyncNotification,
  safelySendScheduledSyncSummary,
} from "../../../src/features/notifications/service";
import * as repository from "../../../src/features/notifications/repository";

const vapidPublicKey =
  "BGtkbcjrO12YMoDuq2sCQeHlu47uPx3SHTgFKZFYiBW8Qr0D9vgyZSZPdw6_4ZFEI9Snk1VEAj2qTYI1I1YxBXE";
const vapidPrivateKey = "I0_d0vnesxbBSUmlDdOKibGo6vEXRO-Vu88QlSlm5j0";

function createDb(encryptedSubscription: string) {
  const row = {
    id: "subscription-id",
    encrypted_subscription: encryptedSubscription,
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
    last_success_at: null,
    consecutive_failures: 0,
  };
  const db = {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          return { results: [row] };
        },
        async raw() {
          return [
            [
              row.id,
              row.encrypted_subscription,
              row.created_at,
              row.updated_at,
              row.last_success_at,
              row.consecutive_failures,
            ],
          ];
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return db;
}

function env(DB: D1Database): Env {
  return {
    DB,
    SYNC_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    BROWSER: {} as Fetcher,
    AI: {} as Ai,
    VAPID_PUBLIC_KEY: vapidPublicKey,
    VAPID_PRIVATE_KEY: vapidPrivateKey,
    VAPID_SUBJECT: "mailto:test@example.com",
    CONFIG_ENCRYPTION_KEY: "test-encryption-key",
  };
}

describe("push notification delivery options", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["single", "scheduled"])(
    "redacts database diagnostics in %s notification failure logs",
    async (kind) => {
      vi.spyOn(repository, "getNotificationPreferences").mockRejectedValue(
        new DrizzleQueryError(
          "SELECT private_query",
          ["private-fixture-value"],
          new Error("private-fixture-cause"),
        ),
      );
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const event = {
        connectorId: "sinopac" as const,
        status: "success" as const,
      };
      if (kind === "single")
        await safelySendSyncNotification(env(createDb("unused")), event);
      else
        await safelySendScheduledSyncSummary(env(createDb("unused")), [event]);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        event: "push_notification_failed",
        message: "Database query failed.",
      });
      expect(log.mock.calls[0][0]).not.toContain("private-fixture");
    },
  );

  it("does not send the semantic notification tag as a Web Push Topic", async () => {
    const encryptedSubscription = await encryptJson(
      {
        endpoint: "https://push.example.com/subscription",
        expirationTime: null,
        keys: { p256dh: "p256dh", auth: "auth" },
      },
      "test-encryption-key",
    );
    const sendNotification = vi
      .spyOn(webpush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    await expect(
      sendTestNotification(env(createDb(encryptedSubscription))),
    ).resolves.toEqual({ delivered: 1, failed: 0, removed: 0, attempted: 1 });

    const options = sendNotification.mock.calls[0]?.[2];
    expect(options).toMatchObject({ TTL: 60 * 60, urgency: "normal" });
    expect(options?.topic).toBeUndefined();
  });
});
