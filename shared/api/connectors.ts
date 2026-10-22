import type { ConnectorId } from "../connector-catalog";

/** 設定頁顯示的 session 與待驗證狀態；由各來源依保存的 secret state 判斷。 */
export interface ConnectorSessionState {
  sessionAvailable: boolean;
  verificationPending: boolean;
  verificationChannel: "app" | "email" | "sms" | null;
  verificationExpiresAt: string | null;
}

/** `GET /api/connectors/:connectorId/settings` 的非敏感設定狀態。 */
export interface ConnectorSettingsResponse extends ConnectorSessionState {
  connectorId: ConnectorId;
  configured: boolean;
  updatedAt?: string;
  publicConfig: Record<string, unknown> | null;
  credentialsComplete: boolean;
}
