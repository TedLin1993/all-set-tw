import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "../financial-types";
import forge from "node-forge";
import { z } from "zod";
import { NextbankApiError, type NextbankDepositPayloads } from "./api";
import { BANK_SYNC_MONTHS } from "../sync-window";

export const nextbankConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  captchaUuid: z.string().min(1).optional(),
  captchaExpiresAt: z.number().int().optional(),
});
export type NextbankConfig = z.infer<typeof nextbankConfigSchema>;
export function parseNextbankConfig(value: unknown): NextbankConfig {
  return nextbankConfigSchema.parse(value);
}

const money = z
  .union([z.number(), z.string().regex(/^-?\d+(?:\.\d+)?$/)])
  .transform(Number)
  .refine(Number.isFinite);
const overviewSchema = z.object({
  mainAccount: z.object({
    accountId: z.string().min(1),
    workingBalance: money,
    availableBalance: money,
  }),
});
const tradesSchema = z.object({
  trades: z.array(
    z.object({
      tradeID: z.union([z.string().min(1), z.number().int()]).transform(String),
      tradeAmount: money,
      tradeDateTime: z.union([z.string(), z.number()]).nullish(),
      tradeChannel: z.string().min(1),
      detail: z.object({
        txnDateTime: z.union([z.string(), z.number()]).nullish(),
        deductionDate: z.union([z.string(), z.number()]).nullish(),
        descript: z.string().nullish(),
        summary: z.string().nullish(),
        memo: z.string().nullish(),
      }),
    }),
  ),
});

export type NextbankData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

function hash(value: string): string {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}

function redact(value: string): string {
  return value
    .replace(/[A-Z][12]\d{8}/gi, "[身分證已遮罩]")
    .replace(
      /\d(?:[ -]?\d){7,}/g,
      (match) => `***${match.replace(/\D/g, "").slice(-4)}`,
    );
}

/** Preserve date-only precision; interpret unzoned bank times as Taiwan time. */
export function normalizeNextbankTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1e11 &&
    value < 1e14
  ) {
    return new Date(value).toISOString();
  }
  if (typeof value !== "string") throw new NextbankApiError("protocol");
  const match = value.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/,
  );
  if (!match) throw new NextbankApiError("protocol");
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const parsedDate = new Date(date + "T00:00:00Z");
  if (
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    throw new NextbankApiError("protocol");
  }
  if (!match[4]) return date;
  if (
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6] ?? 0) > 59
  ) {
    throw new NextbankApiError("protocol");
  }
  const result = `${date}T${match[4]}:${match[5]}:${match[6] ?? "00"}${match[7] ?? ""}${match[8] ?? "+08:00"}`;
  if (!Number.isFinite(Date.parse(result)))
    throw new NextbankApiError("protocol");
  return result;
}

function taiwanDate(value: string): string {
  if (value.length === 10) return value;
  return new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10);
}

/** Schemas follow the official accessibility site's rendered fields.
 * Authenticated response fixtures and live reconciliation are still required.
 * Missing lists are errors, not successful empty synchronizations.
 */
function parseNextbankTransactions(
  accountNumber: string,
  transactionResponses: unknown[],
): NextbankData["bankTransactions"] {
  const pages = transactionResponses.map((page) =>
    tradesSchema.safeParse(page),
  );
  if (pages.some((page) => !page.success) || pages.length === 0) {
    throw new NextbankApiError("protocol");
  }
  if (!accountNumber.trim()) throw new NextbankApiError("protocol");
  const accountId = `bank:nextbank:${hash(accountNumber)}:TWD`;
  const transactions = new Map<
    string,
    NextbankData["bankTransactions"][number]
  >();
  for (const page of pages) {
    if (!page.success) throw new NextbankApiError("protocol");
    for (const trade of page.data.trades) {
      const authorizedAt = normalizeNextbankTime(
        trade.detail.txnDateTime ?? trade.tradeDateTime,
      );
      const postedAt = normalizeNextbankTime(trade.detail.deductionDate);
      if (!authorizedAt && !postedAt) throw new NextbankApiError("protocol");
      const status = trade.tradeChannel === "UNBILLED" ? "pending" : "posted";
      // Bank trade IDs can repeat across monthly responses. Keep the Taiwan
      // transaction date in the identity; date-only posting still matches the
      // same day's pending row, and memo edits do not create new transactions.
      const identityDate = taiwanDate(authorizedAt ?? postedAt!);
      const sourceId = `nextbank:tx:${hash(JSON.stringify([accountNumber, identityDate, trade.tradeID]))}`;
      const previous = transactions.get(sourceId);
      if (previous?.status === "posted" && status === "pending") continue;
      transactions.set(sourceId, {
        accountId,
        sourceId,
        // Official UI displays tradeAmount directly; do not infer or flip its sign.
        amount: trade.tradeAmount,
        currency: "TWD",
        authorizedAt:
          previous?.authorizedAt &&
          previous.authorizedAt.length > 10 &&
          (!authorizedAt || authorizedAt.length === 10)
            ? previous.authorizedAt
            : (authorizedAt ?? previous?.authorizedAt),
        postedDate:
          status === "posted"
            ? taiwanDate(postedAt ?? authorizedAt!)
            : undefined,
        description:
          [
            ...new Set(
              [trade.detail.descript, trade.detail.summary, trade.detail.memo]
                .filter((value): value is string => typeof value === "string")
                .map((value) => redact(value.trim()))
                .filter(Boolean),
            ),
          ].join(" · ") || "將來銀行交易",
        status,
        raw: { tradeChannel: trade.tradeChannel },
      });
    }
  }
  return [...transactions.values()];
}

/** The pocket endpoint has no date-range argument. Filter its fully collected
 * pages locally; do not assume transaction order or stop at the first old row.
 * Balances are deliberately supplied by the separate account snapshot parser.
 */
export function parseNextbankPocketTransactions(
  accountNumber: string,
  pages: unknown[],
  now = new Date(),
): NextbankData["bankTransactions"] {
  if (!Number.isFinite(now.getTime())) throw new NextbankApiError("protocol");
  const taiwanNow = new Date(now.getTime() + 8 * 3600_000);
  const startDate = new Date(
    Date.UTC(
      taiwanNow.getUTCFullYear(),
      taiwanNow.getUTCMonth() - BANK_SYNC_MONTHS + 1,
      1,
    ),
  )
    .toISOString()
    .slice(0, 10);
  const endDate = taiwanNow.toISOString().slice(0, 10);
  return parseNextbankTransactions(accountNumber, pages).filter((trade) => {
    const date =
      trade.postedDate ??
      (trade.authorizedAt && taiwanDate(trade.authorizedAt));
    return !!date && date >= startDate && date <= endDate;
  });
}

export function parseNextbankMainAccount(
  overview: unknown,
  transactionResponses: unknown[],
  now = new Date(),
): NextbankData {
  const parsed = overviewSchema.safeParse(overview);
  if (!parsed.success || !Number.isFinite(now.getTime()))
    throw new NextbankApiError("protocol");
  const main = parsed.data.mainAccount;
  const accountId = `bank:nextbank:${hash(main.accountId)}:TWD`;
  return {
    bankAccounts: [
      {
        sourceId: accountId,
        institutionName: "將來銀行",
        accountName: `主帳戶 末四碼 ${main.accountId.slice(-4)}`,
        accountType: "savings",
        currency: "TWD",
      },
    ],
    bankBalanceSnapshots: [
      {
        accountId,
        sourceId: `snapshot:${accountId}`,
        balance: main.workingBalance,
        availableBalance: main.availableBalance,
        currency: "TWD",
        asOfAt: now.toISOString(),
      },
    ],
    bankTransactions: parseNextbankTransactions(
      main.accountId,
      transactionResponses,
    ),
  };
}

/** Live PocketInfo fields verified on the local probe. Pocket balances belong
 * to their own stable account IDs, never to a name-derived account.
 */
export function parseNextbankDemandPocket(
  pocket: unknown,
  pages: unknown[],
  now = new Date(),
): NextbankData {
  const parsed = z
    .object({
      depositType: z.literal("DEPOSIT"),
      accNo: z.string().min(1),
      name: z.string().optional(),
      amount: money.refine((value) => value >= 0),
      openDate: z.union([z.string(), z.number()]).nullish(),
    })
    .safeParse(pocket);
  if (!parsed.success || !Number.isFinite(now.getTime()))
    throw new NextbankApiError("protocol");
  const value = parsed.data;
  const accountId = `bank:nextbank:${hash(value.accNo)}:TWD`;
  const openedAt = normalizeNextbankTime(value.openDate);
  return {
    bankAccounts: [
      {
        sourceId: accountId,
        institutionName: "將來銀行",
        accountType: "savings",
        accountName: redact(value.name?.trim() || "活存口袋"),
        currency: "TWD",
        openedDate: openedAt ? taiwanDate(openedAt) : undefined,
      },
    ],
    bankBalanceSnapshots: [
      {
        accountId,
        sourceId: `snapshot:${accountId}`,
        balance: value.amount,
        currency: "TWD",
        asOfAt: now.toISOString(),
      },
    ],
    bankTransactions: parseNextbankPocketTransactions(value.accNo, pages, now),
  };
}

/** Principal and dates shown by the official term-deposit pocket page.
 * Accrued interest is not added to principal and no synthetic cashflow is made.
 * The caller must reconcile account totals before merging this with AllInOne.
 */
export function parseNextbankTermPocket(
  pocket: unknown,
  detail: unknown,
  now = new Date(),
): NextbankData {
  const account = z
    .object({
      depositType: z.literal("TERMDEPOSIT"),
      arrngId: z.string().min(1),
      name: z.string().optional(),
      amount: money.refine((value) => value >= 0),
    })
    .safeParse(pocket);
  const dates = z
    .object({
      startDate: z.union([z.string(), z.number()]).nullish(),
      endDate: z.union([z.string(), z.number()]).nullish(),
    })
    .safeParse(detail);
  if (!account.success || !dates.success || !Number.isFinite(now.getTime()))
    throw new NextbankApiError("protocol");
  const openedAt = normalizeNextbankTime(dates.data.startDate);
  const maturityAt = normalizeNextbankTime(dates.data.endDate);
  const openedDate = openedAt ? taiwanDate(openedAt) : undefined;
  const maturityDate = maturityAt ? taiwanDate(maturityAt) : undefined;
  if (openedDate && maturityDate && openedDate > maturityDate)
    throw new NextbankApiError("protocol");
  const accountId = `bank:nextbank:term:${hash(account.data.arrngId)}:TWD`;
  return {
    bankAccounts: [
      {
        sourceId: accountId,
        institutionName: "將來銀行",
        accountName: redact(account.data.name?.trim() || "定存口袋"),
        accountType: "time_deposit",
        currency: "TWD",
        openedDate,
        maturityDate,
      },
    ],
    bankBalanceSnapshots: [
      {
        accountId,
        sourceId: `snapshot:${accountId}`,
        balance: account.data.amount,
        currency: "TWD",
        asOfAt: now.toISOString(),
      },
    ],
    bankTransactions: [],
  };
}

/** Produce a complete deposit snapshot or fail before any staged persistence.
 * Pocket totals are reconciled separately from the main account balance.
 */
export function parseNextbankDeposits(
  payloads: NextbankDepositPayloads,
  now = new Date(),
): NextbankData {
  const result = parseNextbankMainAccount(
    payloads.overview,
    payloads.mainTransactions,
    now,
  );
  const totals = z
    .object({ depositTotalAmount: money, termDepositTotalAmount: money })
    .safeParse(payloads.pocketSummary);
  if (!totals.success) throw new NextbankApiError("protocol");
  let demandTotal = 0;
  let termTotal = 0;
  let demandCount = 0;
  let termCount = 0;
  const seen = new Set(result.bankAccounts.map((account) => account.sourceId));
  for (const pocket of payloads.pockets) {
    let parsed: NextbankData;
    if (pocket.depositType === "DEPOSIT") {
      const entries = payloads.pocketTransactions.filter(
        (entry) => entry.accNo === pocket.accNo,
      );
      if (entries.length !== 1) throw new NextbankApiError("protocol");
      parsed = parseNextbankDemandPocket(pocket, entries[0].pages, now);
      demandTotal += parsed.bankBalanceSnapshots[0].balance;
      demandCount++;
    } else if (pocket.depositType === "TERMDEPOSIT") {
      const entries = payloads.termDeposits.filter(
        (entry) => entry.arrngId === pocket.arrngId,
      );
      if (entries.length !== 1) throw new NextbankApiError("protocol");
      parsed = parseNextbankTermPocket(pocket, entries[0].detail, now);
      termTotal += parsed.bankBalanceSnapshots[0].balance;
      termCount++;
    } else throw new NextbankApiError("protocol");
    const id = parsed.bankAccounts[0].sourceId;
    if (seen.has(id)) throw new NextbankApiError("protocol");
    seen.add(id);
    result.bankAccounts.push(...parsed.bankAccounts);
    result.bankBalanceSnapshots.push(...parsed.bankBalanceSnapshots);
    result.bankTransactions.push(...parsed.bankTransactions);
  }
  if (
    demandCount !== payloads.pocketTransactions.length ||
    termCount !== payloads.termDeposits.length ||
    Math.abs(demandTotal - totals.data.depositTotalAmount) > 0.000001 ||
    Math.abs(termTotal - totals.data.termDepositTotalAmount) > 0.000001
  )
    throw new NextbankApiError("protocol");
  return result;
}
