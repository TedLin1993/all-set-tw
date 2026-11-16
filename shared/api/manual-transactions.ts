/** 手動記錄的現金帳戶：不屬於任何資料來源，只由 `/manual-transactions` 寫入。 */
export const MANUAL_CONNECTOR_ID = "manual";
export const MANUAL_ACCOUNT_ID = "manual:cash";

export const MANUAL_TRANSACTION_TYPES = [
  "expense",
  "income",
  "transfer_in",
  "transfer_out",
] as const;
/**
 * `transfer_in`／`transfer_out` 是自己帳戶與現金之間的移動（例如 ATM 提款、存入銀行），
 * 不計入收支。
 */
export type ManualTransactionType = (typeof MANUAL_TRANSACTION_TYPES)[number];

export const MANUAL_TRANSACTION_BATCH_MAX = 50;
export const MANUAL_TRANSACTION_DESCRIPTION_MAX_LENGTH = 120;

export interface ManualTransactionInput {
  /** 呼叫端自訂的識別碼；相同識別碼再次寫入時更新同一筆，不會重複入帳。 */
  externalId?: string;
  /** YYYY-MM-DD。 */
  date: string;
  type: ManualTransactionType;
  /** 新台幣正整數；方向由 type 決定。 */
  amount: number;
  description: string;
  /** 只適用於 expense、income；省略時由分類規則決定。 */
  categoryId?: string;
  /** 省略時保留原備註，空字串清除。 */
  note?: string;
}

export interface ManualTransactionsRequest {
  transactions?: ManualTransactionInput[];
  /** 目前實際的現金餘額；與記錄加總不同時補一筆不計入收支的餘額調整。 */
  balance?: number;
}

export interface ManualTransactionsResponse {
  transactions: Array<{ id: string; externalId: string; created: boolean }>;
  /** 寫入後的現金餘額。 */
  balance: number;
  /** 本次為了對齊 balance 而補上的餘額調整。 */
  adjustment?: { id: string; amount: number };
}

export interface ManualTransactionDeleteResponse {
  balance: number;
}
