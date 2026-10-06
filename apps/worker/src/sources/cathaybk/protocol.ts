import { z } from "zod";
import type { BankAccount, BankBalanceSnapshot } from "@taiwan-fin-hub/shared";

export const cathaybkConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  sessionCookies: z.string().optional(),
  sessionExpiresAt: z.string().optional(),
  browserSessionId: z.string().min(1).optional(),
  browserSessionExpiresAt: z.string().optional(),
  otp: z.string().min(1).optional(),
  otpChannel: z.enum(["email", "sms"]).optional(),
});

export type CathaybkConfig = z.infer<typeof cathaybkConfigSchema>;

export function parseCathaybkConfig(config: unknown): CathaybkConfig {
  return cathaybkConfigSchema.parse(config);
}

const cardStatusResponseSchema = z.object({
  returnCode: z.literal("0000"),
  content: z.object({
    cardStatus: z.enum(["UnKnow", "Valid", "Positive", "Invalid"]),
  }),
});

export function parseCathayCardStatus(value: unknown) {
  const parsed = cardStatusResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("國泰世華信用卡狀態回應無法辨識，未更新資料。");
  }
  return parsed.data.content.cardStatus;
}

const foreignDepositResponseSchema = z.object({
  returnCode: z.literal("0000"),
  content: z.object({
    isGetDemandAccountSuccess: z.boolean(),
    demandAccounts: z
      .array(
        z.object({
          account: z.string().regex(/^\d+$/),
          details: z
            .array(
              z.object({
                currencyCode: z.string().regex(/^[A-Z]{3}$/),
                balance: z.union([
                  z.number().finite(),
                  z
                    .string()
                    .regex(/^[+-]?\d+(?:\.\d+)?$/)
                    .transform(Number)
                    .pipe(z.number().finite()),
                ]),
              }),
            )
            .nullish(),
        }),
      )
      .nullish(),
  }),
});

export function parseCathayForeignDeposits(
  value: unknown,
  asOfAt = new Date().toISOString(),
) {
  const parsed = foreignDepositResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("國泰世華外幣活存回應格式無法辨識，未更新資料。");
  }
  const { isGetDemandAccountSuccess, demandAccounts } = parsed.data.content;
  if (!isGetDemandAccountSuccess) {
    throw new Error("國泰世華外幣活存查詢失敗，未更新資料。");
  }

  const bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">> = [];
  const bankBalanceSnapshots: Array<
    Omit<BankBalanceSnapshot, "id" | "connectorId">
  > = [];
  for (const account of demandAccounts ?? []) {
    for (const detail of account.details ?? []) {
      // R0101 displays balance in currencyCode; equalTwdBalance is only a
      // reference conversion. One account can have several currency rows.
      const sourceId = `bank:cathaybk:${account.account}:${detail.currencyCode}`;
      const raw = {
        accountSuffix: account.account.slice(-4),
        currencyCode: detail.currencyCode,
        balance: detail.balance,
      };
      bankAccounts.push({
        sourceId,
        institutionName: "國泰世華銀行",
        accountName: "國泰外幣活存",
        accountType: "savings",
        currency: detail.currencyCode,
        raw,
      });
      bankBalanceSnapshots.push({
        accountId: sourceId,
        sourceId: `${sourceId}:${asOfAt}`,
        balance: detail.balance,
        currency: detail.currencyCode,
        asOfAt,
        raw,
      });
    }
  }
  return { bankAccounts, bankBalanceSnapshots };
}

const depositTransactionSchema = z.looseObject({
  txnDateTime: z.string().nullish(),
  accountDate: z.string().nullish(),
  description: z.string().nullish(),
  expendAmt: z.number().nullish(),
  incomeAmt: z.number().nullish(),
  balance: z.number().nullish(),
  specialMemo: z.string().nullish(),
  memo: z.string().nullish(),
});

const depositResponseSchema = z.object({
  returnCode: z.literal("0000"),
  content: z.object({
    datas: z
      .array(
        z.object({
          accountNumber: z.string().regex(/^\d+$/),
          queryStatus: z.enum(["Success", "NoData", "Fail"]),
          details: z.array(depositTransactionSchema),
        }),
      )
      .min(1),
  }),
});

export type CathayDepositTransaction = z.infer<typeof depositTransactionSchema>;

function matchesCathayAccount(returned: string, expected: string) {
  return (
    returned.endsWith(expected) &&
    /^0*$/.test(returned.slice(0, -expected.length))
  );
}

const depositQuerySchema = z.object({
  content: z.object({
    queryFilters: z
      .array(
        z.object({
          accountNumber: z.string().regex(/^\d+$/),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .length(1),
  }),
});

export function assertCathayDepositQuery(
  value: unknown,
  accountNumber: string,
  periodDays: number,
) {
  const parsed = depositQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("國泰世華存款交易查詢格式無法辨識，未更新資料。");
  }
  const filter = parsed.data.content.queryFilters[0]!;
  const start = Date.parse(filter.startDate);
  const end = Date.parse(filter.endDate);
  // The bank's 30/90-day periods include both startDate and endDate.
  if (
    !matchesCathayAccount(filter.accountNumber, accountNumber) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    (end - start) / 86_400_000 + 1 !== periodDays
  ) {
    throw new Error("國泰世華存款交易查詢帳號或期間不符，未更新資料。");
  }
}

export function parseCathayDepositTransactions(
  value: unknown,
  accountNumber: string,
): CathayDepositTransaction[] {
  const parsed = depositResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("國泰世華存款交易回應格式無法辨識，未更新資料。");
  }
  const datas = parsed.data.content.datas;
  if (
    !datas.every((data) =>
      matchesCathayAccount(data.accountNumber, accountNumber),
    )
  ) {
    throw new Error("國泰世華存款交易回應帳號不符，未更新資料。");
  }
  if (datas.some((data) => data.queryStatus === "Fail")) {
    throw new Error("國泰世華存款交易查詢失敗，未更新資料。");
  }
  if (
    datas.some(
      (data) => data.queryStatus === "NoData" && data.details.length > 0,
    )
  ) {
    throw new Error("國泰世華存款交易狀態與明細不符，未更新資料。");
  }
  return datas.flatMap((data) => data.details);
}
