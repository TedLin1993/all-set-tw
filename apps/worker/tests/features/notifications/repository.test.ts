import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countPushSubscriptions,
  getNotificationPreferences,
  listPushSubscriptions,
  markPushFailure,
  saveNotificationPreferences,
  upsertPushSubscription,
} from "../../../src/features/notifications/repository";
import { createTestD1 } from "../../../../../packages/db/testing/d1";

describe("notification repository", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;

  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    await harness.binding.batch([
      harness.binding.prepare("DELETE FROM push_subscriptions"),
      harness.binding.prepare("DELETE FROM notification_preferences"),
    ]);
  });

  it("returns built-in preference defaults when no row exists", async () => {
    await expect(getNotificationPreferences(harness.binding)).resolves.toEqual({
      success: false,
      failed: true,
      needsUserAction: true,
    });
  });

  it("stores 0/1 flags and reads them back as booleans", async () => {
    await saveNotificationPreferences(
      harness.binding,
      { success: true, failed: false, needsUserAction: false },
      "2026-09-12T00:00:00.000Z",
    );

    await expect(getNotificationPreferences(harness.binding)).resolves.toEqual({
      success: true,
      failed: false,
      needsUserAction: false,
    });
  });

  it("keeps last_success_at when a subscription is upserted again", async () => {
    await upsertPushSubscription(harness.binding, {
      id: "device-1",
      encryptedSubscription: "encrypted-a",
      now: "2026-09-12T00:00:00.000Z",
    });
    await harness.binding
      .prepare(
        `UPDATE push_subscriptions
         SET last_success_at = '2026-09-12T01:00:00.000Z', consecutive_failures = 2
         WHERE id = 'device-1'`,
      )
      .run();

    await upsertPushSubscription(harness.binding, {
      id: "device-1",
      encryptedSubscription: "encrypted-b",
      now: "2026-09-12T02:00:00.000Z",
    });

    await expect(listPushSubscriptions(harness.binding)).resolves.toEqual([
      {
        id: "device-1",
        encrypted_subscription: "encrypted-b",
        created_at: "2026-09-12T00:00:00.000Z",
        updated_at: "2026-09-12T02:00:00.000Z",
        last_success_at: "2026-09-12T01:00:00.000Z",
        consecutive_failures: 0,
      },
    ]);
  });

  it("increments consecutive failures and counts subscriptions", async () => {
    await upsertPushSubscription(harness.binding, {
      id: "device-1",
      encryptedSubscription: "encrypted",
      now: "2026-09-12T00:00:00.000Z",
    });
    await markPushFailure(
      harness.binding,
      "device-1",
      "2026-09-12T03:00:00.000Z",
    );
    await markPushFailure(
      harness.binding,
      "device-1",
      "2026-09-12T04:00:00.000Z",
    );

    await expect(countPushSubscriptions(harness.binding)).resolves.toBe(1);
    await expect(listPushSubscriptions(harness.binding)).resolves.toEqual([
      {
        id: "device-1",
        encrypted_subscription: "encrypted",
        created_at: "2026-09-12T00:00:00.000Z",
        updated_at: "2026-09-12T04:00:00.000Z",
        last_success_at: null,
        consecutive_failures: 2,
      },
    ]);
  });
});
