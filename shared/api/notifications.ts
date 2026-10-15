/** Web Push 通知設定的 API 契約。 */
export interface NotificationPreferences {
  success: boolean;
  failed: boolean;
  needsUserAction: boolean;
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
