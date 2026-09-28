import { z } from "zod";
import type { InvestmentPosition } from "@taiwan-fin-hub/core";
import {
  firstradeSessionSchema,
  FirstradeReconciliationError,
  type FirstradeApiClient,
} from "./firstrade-api";

export const firstradeConfigSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  pendingSession: firstradeSessionSchema.optional(),
});
export const parseFirstradeConfig = (value: unknown) =>
  firstradeConfigSchema.parse(value);
const amount = z.number().finite();
const positionSchema = z.object({
  symbol: z.string().min(1).max(80),
  company_name: z.string().min(1).max(300),
  quantity: amount,
  market_value: amount,
  sec_type: z.literal(1),
  cost: amount.optional(),
});
async function sourceId(parts: string[]) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return (
    "firstrade:" +
    Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export async function parseFirstradePortfolio(
  accounts: Awaited<ReturnType<FirstradeApiClient["readPortfolio"]>>,
  asOfDate: string,
): Promise<Omit<InvestmentPosition, "id" | "connectorId">[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || !accounts.length)
    throw new Error("Firstrade 帳戶清單或日期無效。");
  const records: Omit<InvestmentPosition, "id" | "connectorId">[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.account)) throw new Error("Firstrade 帳戶重複。");
    seen.add(account.account);
    const parsed = z
      .object({ cash_balance: amount, total_account_value: amount })
      .safeParse(account.balance);
    if (!parsed.success)
      throw new Error("Firstrade 餘額格式不符，未寫入資料。");
    const balance = parsed.data;
    const positions = z.array(positionSchema).safeParse(account.positions);
    if (!positions.success)
      throw new Error(
        "Firstrade 持倉包含尚未支援的商品或欄位；目前支援股票與 ETF，未寫入資料。",
      );
    const sum =
      positions.data.reduce((n, p) => n + p.market_value, 0) +
      balance.cash_balance;
    if (!Number.isFinite(sum))
      throw new Error("Firstrade 持倉加總超出可處理範圍，未寫入資料。");
    // Bound cent-rounding error by the number of independently rounded values.
    const tolerance = Math.max(0.05, (positions.data.length + 2) * 0.005);
    const difference = sum - balance.total_account_value;
    const positionValue = sum - balance.cash_balance;
    if (
      account.positionsMarketValue !== undefined &&
      (!Number.isFinite(account.positionsMarketValue) ||
        Math.abs(positionValue - account.positionsMarketValue) >
          tolerance + 1e-8)
    )
      throw new FirstradeReconciliationError(
        "Firstrade 持倉明細與持倉小計不符，未更新資料；既有資料不受影響。",
      );
    // The broker documents different quote feeds for Balances and Positions.
    // Accept that difference only when BOTH independently reconcile, with no
    // unrepresented option/debt balances. Cash-account responses omit those
    // optional fields; supplied nonzero/null values remain unsupported.
    // Never manufacture cash to close a gap.
    const sheet = z
      .object({
        long_stock_value: amount,
        long_option_value: z.literal(0).optional(),
        short_option_value: z.literal(0).optional(),
        margin_balance: z.literal(0).optional(),
      })
      .safeParse(account.balance);
    const differentQuotes = Math.abs(difference) > tolerance + 1e-8;
    const independentlyReconciled =
      account.positionsMarketValue !== undefined &&
      sheet.success &&
      positionValue > 0 &&
      sheet.data.long_stock_value > 0 &&
      positions.data.every((p) => p.quantity >= 0 && p.market_value >= 0) &&
      Math.abs(
        balance.cash_balance +
          sheet.data.long_stock_value -
          balance.total_account_value,
      ) <=
        0.015 + 1e-8;
    if (differentQuotes && !independentlyReconciled)
      throw new FirstradeReconciliationError(
        `Firstrade 已登入，但現金加持倉與帳戶總值不符（持倉 ${positions.data.length} 筆；加總減帳戶總值 USD ${difference.toFixed(2)}；四捨五入容差 USD ${tolerance.toFixed(3)}）。未更新資料，既有資料不受影響。這是資料核對問題，不是帳密或驗證碼錯誤。`,
      );
    const symbols = new Set<string>();
    for (const p of positions.data) {
      if (symbols.has(p.symbol))
        throw new Error("Firstrade 持倉代碼重複，未寫入資料。");
      symbols.add(p.symbol);
      records.push({
        sourceId: await sourceId([account.account, p.symbol]),
        assetType: "stock",
        symbol: p.symbol,
        name: p.company_name,
        quantity: p.quantity,
        marketValue: p.market_value,
        currency: "USD",
        asOfDate,
        raw: {
          brokerName: "Firstrade",
          accountLast4: account.account.slice(-4),
          securityType: p.sec_type,
          cost: p.cost,
        },
      });
    }
    // The existing investment contract includes broker cash. Keep it separate
    // from securities, never treat buying power or total account value as cash.
    records.push({
      sourceId: await sourceId([account.account, "cash"]),
      assetType: "stock",
      name: `Firstrade 現金（***${account.account.slice(-4)}）`,
      marketValue: 0,
      cashBalance: balance.cash_balance,
      currency: "USD",
      asOfDate,
      raw: {
        brokerName: "Firstrade",
        accountLast4: account.account.slice(-4),
        kind: "cash",
        reportedAccountValue: balance.total_account_value,
        positionsMarketValue: positionValue,
        valuationDifference: difference,
        valuationNote: differentQuotes
          ? "Firstrade 餘額頁與持倉頁採不同報價來源；兩邊各自核對通過。本網站使用持倉明細市值加現金，因此可能與券商帳戶總值不同。"
          : undefined,
      },
    });
  }
  return records;
}
