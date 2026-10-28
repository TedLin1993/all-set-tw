// 手動記錄視窗（ManualActivityDialog）的純邏輯：金額解析、外幣換算、送出內容整理。
import type { ManualActivityFx } from "@taiwan-fin-hub/shared";

export type ManualKind = "expense" | "income";

/** POST /api/activity/manual、PUT /api/activity/manual/:id 的送出內容；amount 為台幣。 */
export interface ManualActivityInput {
  date: string;
  kind: ManualKind;
  categoryId: string;
  name: string;
  amount: number;
  fx: ManualActivityFx | null;
}

/** 外幣下拉選單的常用幣別。 */
export const FX_CURRENCIES = [
  "USD",
  "JPY",
  "EUR",
  "KRW",
  "CNY",
  "HKD",
  "THB",
  "GBP",
  "SGD",
  "AUD",
] as const;

/** 輸入文字 → 數字（容許千分位逗號）；空白或不合法回 NaN。 */
export function parseAmountText(text: string) {
  const normalized = text.replace(/[,\s]/g, "");
  return normalized && /^\d*\.?\d+$/.test(normalized)
    ? Number(normalized)
    : NaN;
}

/** 原幣金額 × 匯率 → 台幣（四捨五入到元）。 */
export function fxToTwd(amount: number, rate: number) {
  return Math.round(amount * rate);
}

export type BuiltManualActivity =
  | { error: string; input?: undefined }
  | { error?: undefined; input: ManualActivityInput };

/** 送出前的驗證與整理：外幣的原值只放 fx 紀錄，入帳一律是台幣金額。 */
export function buildManualActivityInput(form: {
  kind: ManualKind;
  categoryId: string;
  name: string;
  date: string;
  twdText: string;
  fxCurrency: string;
  fxAmountText: string;
  fxRateText: string;
}): BuiltManualActivity {
  if (!form.name.trim()) return { error: "請輸入名稱" };
  if (!form.categoryId) return { error: "請先選分類" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { error: "日期格式錯誤" };
  const amount = parseAmountText(form.twdText);
  if (!(amount > 0)) return { error: "請正確輸入台幣金額" };

  let fx: ManualActivityFx | null = null;
  if (form.fxCurrency) {
    const fxAmount = parseAmountText(form.fxAmountText);
    const rate = parseAmountText(form.fxRateText);
    if (!(fxAmount >= 0)) return { error: "請正確輸入原幣金額" };
    if (!(rate > 0)) return { error: "請填入匯率" };
    fx = { currency: form.fxCurrency, amount: fxAmount, rate };
  }
  return {
    input: {
      date: form.date,
      kind: form.kind,
      categoryId: form.categoryId,
      name: form.name.trim(),
      amount,
      fx,
    },
  };
}

/** 本機時區的 YYYY-MM-DD。 */
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
