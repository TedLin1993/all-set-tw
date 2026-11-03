import { depositAccountName } from "../deposit-account-name";
import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "../financial-types";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "../sync-window";
import { creditCardLiabilityBalance } from "../credit-card-liability";

export const hncbConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  sessionCookies: z.string().optional(),
  sessionCreatedAt: z.string().optional(),
  browserSessionId: z.string().optional(),
  browserSessionExpiresAt: z.string().optional(),
  captchaDigitCount: z.number().int().min(4).max(8).optional(),
  captcha: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

export type HncbConfig = z.infer<typeof hncbConfigSchema>;

export function parseHncbConfig(config: unknown): HncbConfig {
  return hncbConfigSchema.parse(config);
}

export type HncbPayloads = {
  depositOverviewHtml?: string;
  unbilledHtml?: string;
  billsHtml?: string[];
};

export type HncbData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

export function parseHncbData(
  payloads: HncbPayloads,
  now = new Date(),
): HncbData {
  const bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">> = [];
  const bankBalanceSnapshots: Array<
    Omit<BankBalanceSnapshot, "id" | "connectorId">
  > = [];
  const bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">> =
    [];
  const creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">> = [];

  const asOfAt = now.toISOString();

  if (payloads.depositOverviewHtml) {
    const depositData = parseDepositOverview(
      payloads.depositOverviewHtml,
      asOfAt,
    );
    bankAccounts.push(...depositData.accounts);
    bankBalanceSnapshots.push(...depositData.snapshots);
  }

  const cardData =
    payloads.unbilledHtml ||
    (payloads.billsHtml && payloads.billsHtml.length > 0)
      ? parseCreditCards(
          payloads.unbilledHtml,
          payloads.billsHtml ?? [],
          asOfAt,
        )
      : { accounts: [], snapshots: [], transactions: [], bills: [] };
  bankAccounts.push(...cardData.accounts);
  bankBalanceSnapshots.push(...cardData.snapshots);
  bankTransactions.push(...cardData.transactions);
  creditCardBills.push(...cardData.bills);

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions,
    creditCardBills,
  };
}

function parseDepositOverview(html: string, asOfAt: string) {
  const accounts: Array<Omit<BankAccount, "id" | "connectorId">> = [];
  const snapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">> = [];
  const seen = new Set<string>();
  const normalized = normalizeHncbHtml(html);

  const rowRegex = /<tr[^>]*>([\s\S]*?<\/tr>)/gi;
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(normalized)) !== null) {
    const parsed = parseDepositRow(extractCells(match[1] ?? ""));
    if (!parsed) continue;
    const sourceId = `bank:hncb:${parsed.accountNo}:${parsed.currency}`;
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);

    accounts.push({
      sourceId,
      institutionName: "華南銀行",
      accountName: depositAccountName(
        parsed.accountTypeStr,
        parsed.accountNo,
        `華南${parsed.accountTypeStr || "存款帳戶"}`,
      ),
      accountType: parsed.accountTypeStr.includes("定")
        ? "time_deposit"
        : parsed.accountTypeStr.includes("活")
          ? "savings"
          : "checking",
      currency: parsed.currency,
      raw: parsed,
    });

    snapshots.push({
      accountId: sourceId,
      sourceId: `snapshot:hncb:${parsed.accountNo}:${parsed.currency}`,
      balance: parsed.balance,
      availableBalance: parsed.availableBalance,
      currency: parsed.currency,
      asOfAt,
      raw: {
        balance: parsed.balance,
        availableBalance: parsed.availableBalance,
      },
    });
  }

  return { accounts, snapshots };
}

function parseDepositRow(cells: string[]) {
  if (cells.length < 3) return null;
  const accountCell = cells.find((cell) => {
    const digits = cell.replace(/[^0-9]/g, "");
    return digits.length >= 10 && digits.length <= 16;
  });
  if (!accountCell) return null;
  const accountNo = accountCell.replace(/[^0-9]/g, "");
  const accountTypeStr =
    cells.find((cell) => /活|支|定|儲|帳/.test(cell) && cell !== accountCell) ??
    "";
  const currencyStr =
    cells.find((cell) =>
      /新台幣|臺幣|NTD|TWD|USD|JPY|EUR|美金|日[圓円]/.test(cell),
    ) ?? "";
  const numericCells = cells.filter((cell) => {
    if (cell === accountCell) return false;
    const cleaned = cell.replace(/[$, ]/g, "");
    return /^[-+]?[0-9]+(?:\.[0-9]+)?$/.test(cleaned);
  });
  const balance = parseAmount(numericCells.at(-2) ?? numericCells.at(-1) ?? "");
  const availableBalance = parseAmount(
    numericCells.at(-1) ?? numericCells.at(-2) ?? "",
  );
  const currency =
    /新台幣|臺幣|NTD|TWD/.test(currencyStr) || currencyStr === ""
      ? "TWD"
      : /USD|美金/.test(currencyStr)
        ? "USD"
        : /JPY|日/.test(currencyStr)
          ? "JPY"
          : currencyStr.trim() || "TWD";

  return {
    accountNo,
    accountTypeStr,
    currencyStr,
    balanceStr: numericCells.at(-2) ?? numericCells.at(-1) ?? "",
    availBalanceStr: numericCells.at(-1) ?? "",
    balance,
    availableBalance,
    currency,
  };
}

function parseCreditCards(
  unbilledHtml: string | undefined,
  billsHtml: string[],
  asOfAt: string,
) {
  const snapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">> = [];
  const transactions: Array<Omit<BankTransaction, "id" | "connectorId">> = [];
  const bills: Array<Omit<CreditCardBill, "id" | "connectorId">> = [];

  let creditLimit: number | undefined;
  let primaryCardLast4 = "main";

  const parsedBills: Array<{
    period: string;
    statementAmount?: number;
    minimumPayment: number;
    statementClosingDate?: string;
    paymentDueDate?: string;
    isPaid?: boolean;
    cardLast4: string;
    creditLimit?: number;
    transactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  }> = [];

  for (const html of billsHtml) {
    if (!html) continue;
    const parsed = parseSingleBillHtml(html, false, asOfAt);
    if (!isUsefulBillParse(parsed)) continue;
    if (parsed.creditLimit !== undefined && creditLimit === undefined) {
      creditLimit = parsed.creditLimit;
    }
    if (parsed.cardLast4 && parsed.cardLast4 !== "main") {
      primaryCardLast4 = parsed.cardLast4;
    }
    parsedBills.push(parsed);
  }

  parsedBills.sort((a, b) => b.period.localeCompare(a.period));
  const limitedBills = parsedBills.slice(0, BANK_SYNC_MONTHS);

  const unbilled = unbilledHtml
    ? parseSingleBillHtml(unbilledHtml, true, asOfAt)
    : undefined;
  if (unbilled && isUsefulBillParse(unbilled)) {
    if (unbilled.creditLimit !== undefined && creditLimit === undefined) {
      creditLimit = unbilled.creditLimit;
    }
    if (unbilled.cardLast4 && unbilled.cardLast4 !== "main") {
      primaryCardLast4 = unbilled.cardLast4;
    }
  }

  if (
    limitedBills.length === 0 &&
    (!unbilled || !isUsefulBillParse(unbilled))
  ) {
    return { accounts: [], snapshots: [], transactions: [], bills: [] };
  }

  const mainAccountId = `credit:hncb:${primaryCardLast4}`;

  for (const b of limitedBills) {
    // 頁面顯示「-」代表本期無須繳款（0），只有缺少應繳欄位時才以明細推算。
    const statementAmount = b.statementAmount ?? netSpendSum(b.transactions);
    if (b.period) {
      bills.push({
        accountId: mainAccountId,
        sourceId: `hncb:card:bill:${b.period}`,
        billingPeriod: b.period,
        statementAmount,
        minimumPayment: b.minimumPayment,
        statementClosingDate: b.statementClosingDate,
        paymentDueDate: b.paymentDueDate,
        currency: "TWD",
        raw: { period: b.period, statementAmount },
      });
    }
    transactions.push(
      ...b.transactions.map((t) => ({ ...t, accountId: mainAccountId })),
    );
  }

  const hasUnbilled = Boolean(unbilled && isUsefulBillParse(unbilled));
  if (unbilled && hasUnbilled) {
    transactions.push(
      ...unbilled.transactions.map((t) => ({
        ...t,
        accountId: mainAccountId,
      })),
    );
  }

  const accounts: Array<Omit<BankAccount, "id" | "connectorId">> = [
    {
      sourceId: mainAccountId,
      institutionName: "華南銀行",
      accountName: "華南信用卡",
      accountType: "credit",
      currency: "TWD",
      creditLimit,
    },
  ];

  const currentBill = limitedBills[0];
  const pendingSum = netSpendSum(
    transactions.filter((transaction) => transaction.status === "pending"),
  );
  const statementAmount = currentBill
    ? (currentBill.statementAmount ?? netSpendSum(currentBill.transactions))
    : 0;
  // 華南帳單頁沒有已繳金額，以帳單應繳總額作為剩餘應繳。
  const liability = statementAmount + pendingSum;
  // 未出帳只有退款或繳款時淨額為 0，仍需寫入 0 元快照更新餘額。
  if (currentBill || hasUnbilled || liability > 0) {
    snapshots.push({
      accountId: mainAccountId,
      sourceId: `snapshot:hncb:credit:${primaryCardLast4}`,
      balance: creditCardLiabilityBalance(statementAmount, pendingSum),
      statementBalance: currentBill ? statementAmount : undefined,
      statementClosingDate: currentBill?.statementClosingDate,
      paymentDueDate: currentBill?.paymentDueDate,
      noPaymentNeeded: liability === 0,
      currency: "TWD",
      asOfAt,
      raw: { statementAmount, pendingSum },
    });
  }

  return {
    accounts,
    snapshots,
    transactions: dedupeTransactions(transactions),
    bills,
  };
}

function isUsefulBillParse(parsed: {
  period: string;
  statementAmount?: number;
  creditLimit?: number;
  transactions: unknown[];
}) {
  return Boolean(
    parsed.period ||
    (parsed.statementAmount ?? 0) > 0 ||
    parsed.creditLimit !== undefined ||
    parsed.transactions.length > 0,
  );
}

/** 消費存為負數、繳款／退款存為正數；回傳扣除繳款與退款後的淨消費，最低為 0。 */
function netSpendSum(transactions: Array<Pick<BankTransaction, "amount">>) {
  const net = transactions.reduce(
    (sum, transaction) => sum - transaction.amount,
    0,
  );
  return net > 0 ? net : 0;
}

type MonthAnchor = { year: number; month: number };

function monthAnchorFromTimestamp(timestamp?: string): MonthAnchor {
  const date = timestamp ? new Date(timestamp) : new Date();
  const usable = Number.isNaN(date.getTime()) ? new Date() : date;
  return { year: usable.getUTCFullYear(), month: usable.getUTCMonth() + 1 };
}

// 華南信用卡明細只給 MM/DD，年份要從帳單年月推回；消費月份大於帳單月份代表跨年。
function resolveCardTxDate(dateStr: string, anchor: MonthAnchor) {
  const normalized = dateStr.replace(/[/.]/g, "-");
  const month = Number(normalized.slice(0, 2));
  const year =
    Number.isFinite(month) && month > anchor.month
      ? anchor.year - 1
      : anchor.year;
  return `${year}-${normalized}`;
}

function parseSingleBillHtml(
  html: string,
  isUnbilled: boolean,
  asOfAt?: string,
) {
  const normalized = normalizeHncbHtml(html);
  const text = stripTags(normalized);

  const periodMatch =
    text.match(/帳單年月[：:\s]*([0-9]{4})\s*[/年.-]\s*([0-9]{1,2})/) ||
    text.match(/帳單年月[：:\s]*([0-9]{6})/) ||
    text.match(/帳單年月[：:\s]*([0-9]{3})\s*[/年.-]\s*([0-9]{1,2})/);
  const limitMatch = text.match(/信用額度[：:\s]*([0-9,]+)/);
  const stmtDateMatch = text.match(
    /帳單結帳日[：:\s]*([0-9]{4}[/.-][0-9]{1,2}[/.-][0-9]{1,2})/,
  );
  const dueDateMatch = text.match(
    /繳款截止日[：:\s]*([0-9]{4}[/.-][0-9]{1,2}[/.-][0-9]{1,2})/,
  );
  let billingPeriod = "";
  if (periodMatch) {
    if (periodMatch[2]) {
      let year = Number(periodMatch[1]);
      if (year < 1900) year += 1911;
      billingPeriod = `${year}-${String(periodMatch[2]).padStart(2, "0")}`;
    } else if ((periodMatch[1] ?? "").length === 6) {
      const rawPeriod = periodMatch[1] ?? "";
      billingPeriod = `${rawPeriod.slice(0, 4)}-${rawPeriod.slice(4, 6)}`;
    }
  }

  const creditLimit = limitMatch ? parseAmount(limitMatch[1] ?? "") : undefined;
  // 「上期應繳總額」是明細表第一列，不可當成本期應繳。
  const statementAmount = parseLabeledAmount(text, [
    "累積應繳金額",
    "本期應繳總額",
    "本期應繳金額",
  ]);
  const minimumPayment = parseLabeledAmount(text, ["最低應繳金額"]) ?? 0;
  const statementClosingDate = stmtDateMatch
    ? normalizeDateStr(stmtDateMatch[1] ?? "")
    : undefined;
  const paymentDueDate = dueDateMatch
    ? normalizeDateStr(dueDateMatch[1] ?? "")
    : undefined;

  const cardLast4 = extractCardLast4(text) ?? "main";

  const anchor = billingPeriod
    ? {
        year: Number(billingPeriod.slice(0, 4)),
        month: Number(billingPeriod.slice(5, 7)),
      }
    : monthAnchorFromTimestamp(asOfAt);

  const transactions: Array<Omit<BankTransaction, "id" | "connectorId">> = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?<\/tr>)/gi;
  let rowMatch: RegExpExecArray | null;
  let currentCardLast4 = cardLast4;

  while ((rowMatch = rowRegex.exec(normalized)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const rowText = stripTags(rowHtml);

    const cardHeaderLast4 = extractCardLast4(rowText);
    if (cardHeaderLast4) {
      currentCardLast4 = cardHeaderLast4;
      continue;
    }

    if (
      rowText.includes("上期應繳總額") ||
      rowText.includes("消費小計") ||
      rowText.includes("本期應繳總額")
    ) {
      continue;
    }

    const parsedRow = parseCreditTxRow(extractCells(rowHtml));
    if (!parsedRow) continue;

    if (parsedRow.extraCardLast4) {
      currentCardLast4 = parsedRow.extraCardLast4;
    }

    const authorizedAt = resolveCardTxDate(parsedRow.txDateStr, anchor);
    const postedDate =
      parsedRow.postDateStr && /^\d{2}[/.-]\d{2}$/.test(parsedRow.postDateStr)
        ? resolveCardTxDate(parsedRow.postDateStr, anchor)
        : undefined;
    const status = isUnbilled ? "pending" : "posted";
    const sourceId = `hncb:card:tx:v2:${currentCardLast4}:${authorizedAt}:${Math.abs(parsedRow.amount)}:${parsedRow.no || "0"}`;

    transactions.push({
      accountId: `credit:hncb:${currentCardLast4}`,
      sourceId,
      authorizedAt,
      postedDate: status === "posted" ? postedDate || authorizedAt : undefined,
      description: parsedRow.description,
      amount: parsedRow.amount,
      currency: "TWD",
      status,
      cardLast4: currentCardLast4 === "main" ? undefined : currentCardLast4,
      raw: parsedRow,
    });
  }

  distinguishUnnumberedCredits(transactions);

  return {
    period: billingPeriod,
    statementAmount,
    minimumPayment,
    statementClosingDate,
    paymentDueDate,
    creditLimit,
    cardLast4,
    transactions,
  };
}

/**
 * sourceId 以金額絕對值組成；沒有序號時，同卡同日等額的消費與退款會撞號。
 * 消費沿用原 ID，只有與消費撞號的退款／繳款加上 `:credit`，既有 ID 不變。
 */
function distinguishUnnumberedCredits(
  transactions: Array<Omit<BankTransaction, "id" | "connectorId">>,
) {
  const spendIds = new Set(
    transactions
      .filter((transaction) => transaction.amount < 0)
      .map((transaction) => transaction.sourceId),
  );
  for (const transaction of transactions) {
    if (
      transaction.amount > 0 &&
      transaction.sourceId.endsWith(":0") &&
      spendIds.has(transaction.sourceId)
    ) {
      transaction.sourceId = `${transaction.sourceId}:credit`;
    }
  }
}

function extractCardLast4(text: string): string | undefined {
  return text.match(/\*{4,}\s*(\d{4})\b/)?.[1];
}

function parseCreditTxRow(cells: string[]) {
  if (cells[0] === "No." || cells[1] === "消費日") return null;
  const compact = cells.map((cell) => cell.trim());
  if (compact.length >= 8 && /^\d{2}[/.-]\d{2}$/.test(compact[1] ?? "")) {
    const extraCardStr = compact[8] ?? "";
    const extraCardLast4 = extraCardStr.includes("/")
      ? extraCardStr.split("/").at(-1)?.trim()
      : undefined;
    return {
      no: compact[0] ?? "",
      txDateStr: compact[1] ?? "",
      postDateStr: compact[2] ?? "",
      description: compact[3] ?? "",
      country: compact[4] ?? "",
      currency: compact[5] ?? "TWD",
      foreignAmtStr: compact[6] ?? "",
      twdAmtStr: compact[7] ?? "",
      extraCardLast4:
        extraCardLast4 && /^\d{4}$/.test(extraCardLast4)
          ? extraCardLast4
          : undefined,
      amount: signedCardAmount(compact[7] ?? ""),
    };
  }

  const dateIndexes = compact
    .map((cell, index) => (/^\d{2}[/.-]\d{2}$/.test(cell) ? index : -1))
    .filter((index) => index >= 0);
  if (dateIndexes.length === 0) return null;
  const txDateIdx = dateIndexes[0] ?? 0;
  const postDateIdx = dateIndexes[1];
  const amountIdx = findLastAmountIndex(compact, dateIndexes);
  if (amountIdx < 0) return null;
  const no = txDateIdx > 0 ? (compact[0] ?? "") : "";
  const description =
    compact.find(
      (cell, index) =>
        index > (postDateIdx ?? txDateIdx) &&
        index < amountIdx &&
        cell &&
        !/^(TW|TWD|USD|JPY|-)$/.test(cell),
    ) ?? "";
  const extraCardLast4 = compact.find((cell) => /\/\s*\d{4}$/.test(cell));
  return {
    no,
    txDateStr: compact[txDateIdx] ?? "",
    postDateStr: postDateIdx !== undefined ? (compact[postDateIdx] ?? "") : "",
    description,
    country: "",
    currency: "TWD",
    foreignAmtStr: "",
    twdAmtStr: compact[amountIdx] ?? "",
    extraCardLast4: extraCardLast4?.match(/(\d{4})$/)?.[1],
    amount: signedCardAmount(compact[amountIdx] ?? ""),
  };
}

function findLastAmountIndex(cells: string[], dateIndexes: number[]) {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (dateIndexes.includes(index)) continue;
    const cell = cells[index] ?? "";
    if (!cell || cell === "-") continue;
    const cleaned = cell.replace(/[$, ]/g, "");
    if (/^[-+]?[0-9]+(?:\.[0-9]+)?$/.test(cleaned)) return index;
  }
  return -1;
}

function extractCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
  let cellMatch: RegExpExecArray | null;
  while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
    cells.push(stripTags(cellMatch[1] ?? ""));
  }
  return cells;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeHncbHtml(html: string): string {
  return html
    .replace(/\u00a0/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ");
}

/**
 * 帳單欄位值為「-」表示 0（例如本期無須繳款）；找不到欄位回傳 undefined。
 * 依 labels 順序取第一個出現的欄位。
 */
function parseLabeledAmount(
  text: string,
  labels: string[],
): number | undefined {
  for (const label of labels) {
    const match = text.match(
      new RegExp(`(?<!上期)${label}[：:\\s]*(-(?![0-9])|[0-9][0-9,]*)`),
    );
    if (match) return match[1] === "-" ? 0 : parseAmount(match[1] ?? "");
  }
  return undefined;
}

/** 銀行新臺幣金額正數為消費（存為負數），負數為繳款／退款（存為正數）。 */
function signedCardAmount(val: string): number {
  const amount = parseAmount(val);
  return amount === 0 ? 0 : -amount;
}

function parseAmount(val: string): number {
  if (!val) return 0;
  const cleaned = val.replace(/[$, ]/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDateStr(val: string): string {
  if (!val) return "";
  const parts = val.split(/[/.-]/);
  if (parts.length === 3) {
    let year = Number(parts[0]);
    if (year < 1900) year += 1911;
    const month = String(parts[1]).padStart(2, "0");
    const day = String(parts[2]).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return val;
}

function dedupeTransactions(
  txs: Array<Omit<BankTransaction, "id" | "connectorId">>,
) {
  const map = new Map<string, Omit<BankTransaction, "id" | "connectorId">>();
  for (const t of txs) {
    map.set(t.sourceId, t);
  }
  return Array.from(map.values());
}
