import type { ConnectorId } from "../connector-catalog";

export type SinotradeVerificationFieldKey =
  | "birthday"
  | "birthdayYear"
  | "birthdayMonth"
  | "birthdayDay"
  | "otpChannel"
  | "otpTarget"
  | "otp"
  | "agreement";

export type SinotradeVerificationAction =
  | "confirm_certificate"
  | "submit_birthday"
  | "request_otp"
  | "verify_otp"
  | "accept_terms";

export type SinotradeVerificationField = {
  key: SinotradeVerificationFieldKey;
  label: string;
  /** 提交此欄位的動作；未提供該動作需要的欄位時，前端不可送出。 */
  action: SinotradeVerificationAction;
  /** 預設為文字；choice 提交 options 的 value，checkbox 只在使用者勾選時提交 "true"。 */
  type?: "text" | "choice" | "checkbox";
  hint?: string;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
  /** 官方頁面目前已選的 option value，供前端作為預設值。 */
  value?: string;
};

export type SinotradeVerificationChallenge = {
  step: "certificate" | "birthday" | "otp" | "terms" | "ready" | "blocked";
  fields: SinotradeVerificationField[];
  actions: SinotradeVerificationAction[];
  message?: string;
  /** 官方要求使用者先閱讀的公開文件（例如憑證作業條款），僅供顯示。 */
  document?: { title: string; text: string };
};

export type SinotradeVerificationInput = {
  action: SinotradeVerificationAction;
  values: Partial<Record<SinotradeVerificationFieldKey, string>>;
};

/** 與銀行相同，帳密保存於設定，額外驗證由原生欄位接續。 */
export type SinotradeConnectionResponse =
  | { status: "connected"; success: true }
  | {
      status: "verification_required";
      platform: "newweb" | "savings";
      challenge: SinotradeVerificationChallenge;
      expiresAt: string;
    };

/** 設定頁顯示的 session 與待驗證狀態；由各來源依保存的 secret state 判斷。 */
export interface ConnectorSessionState {
  /** 證券的兩個官方平台各自保存認證；只回傳是否完成，不回傳認證內容。 */
  sinotradePlatforms?: { newweb: boolean; savings: boolean };
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
