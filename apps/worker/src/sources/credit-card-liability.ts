/**
 * 信用卡負債快照的共用算法：帳單剩餘應繳 + 未出帳總額，以相反號保存。
 *
 * - `statementRemaining`：當期帳單扣除已繳後仍待繳的金額；溢繳為負數。
 * - `unbilledTotal`：已入帳但尚未結帳的消費淨額（含退款、回饋），不含繳款與即時授權。
 *
 * 回傳負數為欠款、正數為溢繳；四捨五入到小數兩位，避免外幣小數加總誤差。
 */
export function creditCardLiabilityBalance(
  statementRemaining: number,
  unbilledTotal: number,
): number {
  const balance = Math.round(-(statementRemaining + unbilledTotal) * 100) / 100;
  return balance === 0 ? 0 : balance;
}
