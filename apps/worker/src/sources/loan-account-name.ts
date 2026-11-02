import type { BankAccount } from "./financial-types";

const LOAN_CATEGORY_LABELS = {
  personal: "信用貸款",
  housing: "房屋貸款",
  other: "其他貸款",
} as const;

/**
 * 貸款帳戶顯示名稱：各銀行統一用系統分類（信用貸款／房屋貸款／其他貸款）
 * 加「末四碼 xxxx」，與存款名稱格式一致（見 deposit-account-name.ts）。
 * 銀行自帶的產品名稱請放在 raw.productName。分類未知時顯示「貸款」，沒有帳號末四碼時只顯示分類。
 */
export function loanAccountName(
  category: BankAccount["loanCategory"] | null | undefined,
  accountNo?: string | null,
) {
  const label = category ? LOAN_CATEGORY_LABELS[category] : "貸款";
  const last4 = accountNo?.replace(/\D/g, "").slice(-4) ?? "";
  return last4.length === 4 ? `${label} 末四碼 ${last4}` : label;
}
