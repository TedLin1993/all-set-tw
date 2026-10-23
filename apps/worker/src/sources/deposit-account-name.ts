/**
 * 存款帳戶顯示名稱：銀行提供的帳戶種類、別名或暱稱加「末四碼 xxxx」，
 * 方便分辨同銀行的多個帳戶。API 顯示層（features/bank/display.ts）只保留
 * 名稱與末碼以空格分隔、且末碼與 sourceId 一致的名稱；其他名稱改顯示末碼。
 * 沒有名稱或帳號末四碼時回傳 fallback。
 */
export function depositAccountName(
  name: string | null | undefined,
  accountNo: string | null | undefined,
  fallback: string,
) {
  const label = name?.trim();
  const last4 = accountNo?.replace(/\D/g, "").slice(-4) ?? "";
  return label && last4.length === 4 ? `${label} 末四碼 ${last4}` : fallback;
}
