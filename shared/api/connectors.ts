import type { ConnectorId } from "../connector-catalog";

/** `GET /api/connectors/:connectorId/settings` 的非敏感設定狀態。 */
export interface ConnectorSettingsResponse {
  connectorId: ConnectorId;
  configured: boolean;
  updatedAt?: string;
  publicConfig: Record<string, unknown> | null;
  credentialsComplete: boolean;
  sessionAvailable: boolean;
  verificationPending: boolean;
  verificationChannel: "app" | "email" | "sms" | null;
  verificationExpiresAt: string | null;
}
