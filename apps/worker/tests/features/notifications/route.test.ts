import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/platform/env";
import { notificationRoutes } from "../../../src/features/notifications/route";

function createDb() {
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          if (sql.includes("COUNT(*)")) return { count: 0 };
          if (sql.includes("notification_preferences")) {
            return { success: 0, failed: 1, needsUserAction: 1 };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return db;
}

function env(): Env {
  return {
    DB: createDb(),
    SYNC_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    BROWSER: {} as Fetcher,
    AI: {} as Ai,
    VAPID_PUBLIC_KEY: "public-key",
    VAPID_PRIVATE_KEY: "private-key",
    VAPID_SUBJECT: "mailto:test@example.com",
    CONFIG_ENCRYPTION_KEY: "test-encryption-key",
  };
}

function configuredPushEnv() {
  const testEnv = env();
  testEnv.VAPID_PUBLIC_KEY =
    "BGtkbcjrO12YMoDuq2sCQeHlu47uPx3SHTgFKZFYiBW8Qr0D9vgyZSZPdw6_4ZFEI9Snk1VEAj2qTYI1I1YxBXE";
  testEnv.VAPID_PRIVATE_KEY = "I0_d0vnesxbBSUmlDdOKibGo6vEXRO-Vu88QlSlm5j0";
  return testEnv;
}

describe("notification routes", () => {
  it("reports the configured shared push state", async () => {
    const response = await notificationRoutes.request(
      "/notifications/config",
      {},
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      publicKey: "public-key",
      subscribedDevices: 0,
      preferences: { success: false, failed: true, needsUserAction: true },
    });
  });

  it("uses the built-in subject when only the VAPID key pair is configured", async () => {
    const testEnv = env();
    delete testEnv.VAPID_SUBJECT;

    const response = await notificationRoutes.request(
      "/notifications/config",
      {},
      testEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      publicKey: "public-key",
    });
  });

  it("distinguishes an empty device list from delivery failures", async () => {
    const response = await notificationRoutes.request(
      "/notifications/test",
      { method: "POST" },
      configuredPushEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      delivered: 0,
      failed: 0,
      removed: 0,
      attempted: 0,
    });
  });

  it("rejects non-public push endpoints", async () => {
    const response = await notificationRoutes.request(
      "/notifications/subscriptions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "https://localhost/push",
          expirationTime: null,
          keys: { p256dh: "key", auth: "auth" },
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_PUSH_SUBSCRIPTION" },
    });
  });

  it("returns the shared error contract for invalid subscriptions", async () => {
    const response = await notificationRoutes.request(
      "/notifications/subscriptions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "https://push.example.com/subscribe",
          keys: { p256dh: "key" },
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Push subscription is invalid.",
      },
    });
  });

  it("returns the shared error contract for invalid preferences", async () => {
    const response = await notificationRoutes.request(
      "/notifications/preferences",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: true,
          failed: "yes",
          needsUserAction: true,
        }),
      },
      env(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Notification preferences are invalid.",
      },
    });
  });
});
