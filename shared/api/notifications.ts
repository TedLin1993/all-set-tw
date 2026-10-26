/** Web Push 通知設定的 API 契約。 */
export interface NotificationPreferences {
  success: boolean;
  failed: boolean;
  needsUserAction: boolean;
  /** 預設排程同步摘要附上近期繳款與今天到期的定存提醒；緊急的提醒會讓摘要照常送出。 */
  paymentDue: boolean;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface NotificationConfig {
  enabled: boolean;
  publicKey: string | null;
  subscribedDevices: number;
  preferences: NotificationPreferences;
}
