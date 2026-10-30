import type { ConnectorCredentialField } from "@taiwan-fin-hub/shared";

/**
 * 組出儲存設定的 payload：空值（含未動過的 select）不送，
 * 後端會保留已儲存的值，尚未設定時 select 視同第一個選項。
 */
export function buildCredentialConfig(
  fields: readonly ConnectorCredentialField[],
  values: Record<string, string>,
) {
  const entries: Array<[string, string]> = [];
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === "") continue;
    entries.push([field.key, raw]);
  }
  return Object.fromEntries(entries);
}

/**
 * select 目前顯示的值。設定 API 不回傳憑證內容，已儲存時無法得知目前選項，
 * 未動過時顯示空值（對應「維持目前設定」）；尚未儲存時顯示第一個選項。
 */
export function selectDisplayValue(
  field: ConnectorCredentialField,
  value: string | undefined,
  stored: boolean,
) {
  if (value) return value;
  return stored ? "" : (field.options?.[0]?.value ?? "");
}
