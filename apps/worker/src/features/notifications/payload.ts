import type {
  ConnectorId,
  NotificationPreferences,
  PaymentReminder,
  SyncNotificationStatus,
} from "@taiwan-fin-hub/shared";
import { describeDueDay } from "@taiwan-fin-hub/shared";

export type SyncNotificationEvent = {
  connectorId: ConnectorId;
  status: SyncNotificationStatus;
  trigger?: "manual" | "scheduled";
};

export type PushNotificationPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

const connectorLabels: Record<ConnectorId, string> = {
  einvoice: "電子發票",
  tdcc: "集保 e 存摺",
  esun: "玉山銀行",
  cathaybk: "國泰世華銀行",
  sinopac: "永豐行動銀行",
  taishin: "台新銀行",
  ctbc: "中國信託銀行",
  skbank: "新光銀行",
  obank: "王道銀行",
  nextbank: "將來銀行",
  hncb: "華南銀行",
  kgibank: "凱基銀行",
  firstbank: "第一銀行",
  megabank: "兆豐銀行",
  rakuten: "樂天國際銀行",
  fubon: "台北富邦銀行",
  feib: "遠東商銀",
};

export function syncNotificationPayload(
  event: SyncNotificationEvent,
): PushNotificationPayload {
  const connector = connectorLabels[event.connectorId];
  if (event.status === "success") {
    return {
      title: "同步完成",
      body: `${connector}已完成${event.trigger === "manual" ? "" : "排程"}同步，開啟 App 查看結果。`,
      url: "/#/overview",
      tag: `sync-${event.connectorId}-success`,
    };
  }

  if (event.status === "needs_user_action") {
    return {
      title: "需要你的操作",
      body: `${connector}需要重新驗證，請開啟 App 處理。`,
      url: "/#/data-sources",
      tag: `sync-${event.connectorId}-needs-action`,
    };
  }

  return {
    title: "同步失敗",
    body: `${connector}同步失敗，請開啟 App 查看狀態。`,
    url: "/#/data-sources",
    tag: `sync-${event.connectorId}-failed`,
  };
}

export function scheduledSyncSummaryPayload(
  events: SyncNotificationEvent[],
  reminders: PaymentReminder[] = [],
): PushNotificationPayload {
  const success = events.filter((event) => event.status === "success").length;
  const failed = events.filter((event) => event.status === "failed").length;
  const needsUserAction = events.filter(
    (event) => event.status === "needs_user_action",
  ).length;
  const status = summaryStatus(events);
  const payment = paymentReminderSummary(reminders);

  if (status === "success") {
    if (payment)
      return {
        title: `同步完成，${payment.label}`,
        body: payment.detail,
        url: "/#/overview",
        tag: "sync-default-schedule-success",
      };
    return {
      title: "同步完成",
      body: "每日同步已完成，開啟 App 查看結果。",
      url: "/#/overview",
      tag: "sync-default-schedule-success",
    };
  }

  const counts = [
    success > 0 ? `成功 ${success}` : null,
    failed > 0 ? `失敗 ${failed}` : null,
    needsUserAction > 0 ? `需處理 ${needsUserAction}` : null,
  ].filter((count): count is string => count !== null);

  return {
    title:
      status === "needs_user_action"
        ? "同步完成，需要你的操作"
        : "同步完成，部分失敗",
    body: `預設排程同步完成：${counts.join("、")}。${payment ? `另有 ${payment.label}：${payment.detail}` : ""}`,
    url: "/#/data-sources",
    tag:
      status === "needs_user_action"
        ? "sync-default-schedule-needs-action"
        : "sync-default-schedule-failed",
  };
}

export function summaryStatus(
  events: SyncNotificationEvent[],
): SyncNotificationStatus {
  if (events.some((event) => event.status === "needs_user_action")) {
    return "needs_user_action";
  }
  if (events.some((event) => event.status === "failed")) return "failed";
  return "success";
}

export function shouldNotify(
  preferences: NotificationPreferences,
  status: SyncNotificationStatus,
) {
  if (status === "success") return preferences.success;
  if (status === "needs_user_action") return preferences.needsUserAction;
  return preferences.failed;
}

/** 今天或明天到期、扣款未完成、扣款帳戶餘額不足或已過期限：即使同步成功通知關閉，也照樣送出摘要。 */
export function isUrgentPaymentReminder(reminder: PaymentReminder) {
  return (
    reminder.state === "collection_failed" ||
    reminder.state === "insufficient_funds" ||
    reminder.state === "overdue" ||
    (reminder.daysUntilDue !== undefined && reminder.daysUntilDue <= 1)
  );
}

/**
 * 預設排程摘要的推播內容；不需送出時回傳 null。
 * 繳款提醒附在同一則推播，不另外送出，且只寫機構與天數、不含金額。
 * 同步狀態的通知被關閉、只因緊急繳款而送出時，不帶入該同步狀態的內容。
 */
export function scheduledSummaryNotification(
  preferences: NotificationPreferences,
  events: SyncNotificationEvent[],
  reminders: PaymentReminder[],
): PushNotificationPayload | null {
  const included = preferences.paymentDue ? reminders : [];
  const status = summaryStatus(events);
  if (shouldNotify(preferences, status))
    return scheduledSyncSummaryPayload(events, included);
  if (!included.some(isUrgentPaymentReminder)) return null;
  if (status === "success")
    return scheduledSyncSummaryPayload(events, included);
  const payment = paymentReminderSummary(included)!;
  return {
    title: payment.label,
    body: payment.detail,
    url: "/#/overview",
    tag: "sync-default-schedule-payment-due",
  };
}

function paymentPhrase(reminder: PaymentReminder) {
  if (reminder.state === "collection_failed")
    return `${reminder.name}扣款未完成`;
  // 推播只寫機構名稱，不帶帳號末碼與差額。
  if (reminder.state === "insufficient_funds")
    return `${reminder.paymentAccount?.institution ?? "扣款帳戶"}帳戶餘額可能不足以扣繳${reminder.name}`;
  const day = describeDueDay(reminder);
  const phrase = /^\d/.test(day)
    ? `${reminder.name} ${day}`
    : `${reminder.name}${day}`;
  // 與總覽一致：狀態未確定或已過期限時不直接判定未繳。
  if (reminder.state === "due") return phrase;
  if (reminder.kind === "loan") return `${phrase}（請確認餘額）`;
  return `${phrase}（請確認是否已繳）`;
}

function paymentReminderSummary(reminders: PaymentReminder[]) {
  if (reminders.length === 0) return null;
  const needsAttention = reminders.some(
    (item) =>
      item.state === "overdue" ||
      item.state === "collection_failed" ||
      item.state === "insufficient_funds",
  );
  const listed = reminders.slice(0, 2).map(paymentPhrase).join("、");
  return {
    label: needsAttention
      ? `${reminders.length} 筆繳款需要留意`
      : `${reminders.length} 筆繳款即將到期`,
    detail: `${listed}${reminders.length > 2 ? ` 等 ${reminders.length} 筆` : ""}。`,
  };
}
