import type {
  InvestmentRow,
  InvestmentTransactionRow,
} from "@/data/investments/types";
import {
  formatCurrency,
  formatDate,
  formatNumber,
} from "@/shared/format/financial";
import { moneyState } from "@/shared/state/money-visibility.svelte";

const INVESTMENT_QUANTITY_MAX_FRACTION_DIGITS = 8;

/** 投資數量保留碎股精度；整數不補上沒有意義的 0。 */
export function formatInvestmentQuantity(quantity: number | null | undefined) {
  if (quantity == null) return "-";
  if (Number.isInteger(quantity)) return formatNumber(quantity);
  return new Intl.NumberFormat("zh-TW", {
    maximumFractionDigits: INVESTMENT_QUANTITY_MAX_FRACTION_DIGITS,
  }).format(quantity);
}

/** 持倉數量顯示，股票與加密貨幣共用碎股精度。 */
export function formatPositionQuantity(
  position: Pick<InvestmentRow, "assetType" | "quantity">,
) {
  return formatInvestmentQuantity(position.quantity);
}

/**
 * 投資清單專用的原幣金額格式；USD 固定顯示兩位小數（來源的多位小數只用於計算，不顯示），
 * 避免沿用整數金額格式。
 * null/undefined 表示來源未知，不能轉成 0 顯示。
 */
export function formatInvestmentCurrency(
  value: number | null | undefined,
  currency = "TWD",
) {
  if (value == null) return "—";
  if (currency !== "USD") return formatCurrency(value, currency);
  if (moneyState.hidden) return "••••••";
  const sign = value < 0 ? "−" : "";
  const number = new Intl.NumberFormat("zh-TW", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${sign}US$${number}`;
}

/** 新欄位已回傳但值可能為 null 時，仍顯示成本／損益列以保留未知狀態。 */
export function hasInvestmentPerformance(
  position: Pick<InvestmentRow, "costBasis" | "unrealizedPnl">,
) {
  return (
    position.costBasis !== undefined || position.unrealizedPnl !== undefined
  );
}

export function positionAssetTypeLabel(assetType: InvestmentRow["assetType"]) {
  return assetType === "crypto" ? "加密貨幣" : assetType.toUpperCase();
}

type TradeLine = Pick<
  InvestmentTransactionRow,
  | "transactionName"
  | "transactionCode"
  | "tradeDate"
  | "postedDate"
  | "quantity"
  | "price"
  | "amount"
  | "currency"
  | "realizedPnl"
>;

/** 集保偶爾以 1 當匯率占位，不是成交價，也不能拿來算金額。 */
const hasTradePrice = (trade: Pick<TradeLine, "price">) =>
  trade.price != null && trade.price !== 1;

/** 交易列的副標：買賣別、日期、股數與成交價，來源有提供的都列出。 */
export function tradeSummary(trade: TradeLine) {
  const price = hasTradePrice(trade)
    ? new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 4 }).format(
        trade.price!,
      )
    : undefined;
  return [
    trade.transactionName ?? trade.transactionCode ?? "交易",
    formatDate(trade.tradeDate ?? trade.postedDate ?? undefined),
    trade.quantity != null
      ? `${formatInvestmentQuantity(trade.quantity)} 股`
      : undefined,
    price ? `成交價 ${price}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 交易列右側的金額；買進為負、賣出為正的淨收付，來源沒有金額時明說。 */
export function tradeAmountText(trade: TradeLine) {
  return trade.amount != null && hasTradePrice(trade)
    ? formatInvestmentCurrency(trade.amount, trade.currency)
    : "金額未提供";
}

/**
 * 賣出才有已實現損益：有值就顯示；null 表示來源沒有完整買進成本或尚未結算，
 * 不能顯示成 0。買進沒有已實現損益，回傳 null 代表不顯示這一行。
 */
export function tradeRealizedPnl(trade: TradeLine) {
  if (trade.realizedPnl != null)
    return {
      text: `已實現損益 ${formatInvestmentCurrency(trade.realizedPnl, trade.currency)}`,
      tone: trade.realizedPnl < 0 ? ("loss" as const) : ("gain" as const),
    };
  if (trade.transactionCode === "S")
    return { text: "損益未提供", tone: "unknown" as const };
  return null;
}
