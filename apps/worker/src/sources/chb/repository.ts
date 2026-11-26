/**
 * 停用這次完整貸款清單沒有出現的彰化銀行貸款（例如已清償），保留歷史快照。
 * 只在銀行明確回覆成功且清單完整時呼叫；貸款再次出現時，帳戶寫入會清除 `inactive_at`。
 * 同步期間設定已變更（本次暫存資料已被丟棄）時不停用。
 */
export function deactivateMissingChbLoanAccountsStatement(
  db: D1Database,
  activeSourceIds: readonly string[],
  now: string,
  settingsGuard: { encryptedConfig: string },
) {
  return db
    .prepare(
      `UPDATE bank_accounts
       SET inactive_at = ?, updated_at = ?
       WHERE connector_id = 'chb'
         AND account_type = 'loan'
         AND source_id LIKE 'loan:chb:%'
         AND inactive_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM json_each(?) active
           WHERE active.value = bank_accounts.source_id
         )
         AND EXISTS (
           SELECT 1 FROM connector_settings
           WHERE connector_id = 'chb' AND encrypted_config = ?
         )`,
    )
    .bind(
      now,
      now,
      JSON.stringify(activeSourceIds),
      settingsGuard.encryptedConfig,
    );
}
