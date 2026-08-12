import { describe, expect, it } from "vitest";
import type { NotificationPreferences } from "@taiwan-fin-hub/core";
import {
  scheduledSyncSummaryPayload,
  summaryStatus,
  shouldNotify,
  syncNotificationPayload,
  type SyncNotificationEvent,
} from "../../../src/features/notifications/payload";

describe("sync notification payload", () => {
  it("keeps success notifications opt-in and safe for display", () => {
    const payload = syncNotificationPayload({
      connectorId: "esun",
      status: "success",
    });

    expect(payload).toEqual({
      title: "同步完成",
      body: "玉山銀行已完成排程同步，開啟 App 查看結果。",
      url: "/#/overview",
      tag: "sync-esun-success",
    });
  });

  it("does not expose connector error details", () => {
    const payload = syncNotificationPayload({
      connectorId: "tdcc",
      status: "needs_user_action",
    });

    expect(payload.body).not.toContain("OTP");
    expect(payload.url).toBe("/#/data-sources");
  });

  it("labels Taishin scheduled sync notifications", () => {
    expect(
      syncNotificationPayload({
        connectorId: "taishin",
        status: "success",
      }).body,
    ).toBe("台新銀行已完成排程同步，開啟 App 查看結果。");
  });

  it("labels CTBC scheduled sync notifications", () => {
    expect(
      syncNotificationPayload({
        connectorId: "ctbc",
        status: "success",
      }).body,
    ).toBe("中國信託銀行已完成排程同步，開啟 App 查看結果。");
  });

  it("maps statuses to their preference switches", () => {
    const preferences: NotificationPreferences = {
      success: false,
      failed: true,
      needsUserAction: true,
    };

    expect(shouldNotify(preferences, "success")).toBe(false);
    expect(shouldNotify(preferences, "failed")).toBe(true);
    expect(shouldNotify(preferences, "needs_user_action")).toBe(true);
  });

  it("uses the aggregate status for a mixed summary preference", () => {
    const preferences: NotificationPreferences = {
      success: true,
      failed: false,
      needsUserAction: false,
    };
    const events: SyncNotificationEvent[] = [
      { connectorId: "einvoice", status: "success" },
      { connectorId: "tdcc", status: "failed" },
    ];

    expect(shouldNotify(preferences, summaryStatus(events))).toBe(false);
  });
});

describe("scheduled sync summary payload", () => {
  it("combines successful default-schedule jobs into one notification", () => {
    const payload = scheduledSyncSummaryPayload([
      { connectorId: "einvoice", status: "success" },
      { connectorId: "tdcc", status: "success" },
      { connectorId: "esun", status: "success" },
    ]);

    expect(payload).toEqual({
      title: "同步完成",
      body: "每日同步已完成，開啟 App 查看結果。",
      url: "/#/overview",
      tag: "sync-default-schedule-success",
    });
  });

  it("reports mixed results and uses the most actionable status", () => {
    const events: SyncNotificationEvent[] = [
      { connectorId: "einvoice", status: "success" },
      { connectorId: "tdcc", status: "failed" },
      { connectorId: "esun", status: "needs_user_action" },
    ];

    expect(summaryStatus(events)).toBe("needs_user_action");
    expect(scheduledSyncSummaryPayload(events)).toEqual({
      title: "同步完成，需要你的操作",
      body: "預設排程同步完成：成功 1、失敗 1、需處理 1。",
      url: "/#/data-sources",
      tag: "sync-default-schedule-needs-action",
    });
  });
});
