import { describe, expect, it } from "vitest";
import { CtbcVerificationRequiredError } from "../../../src/sources/ctbc/errors";
import {
  CTBC_LOAN_SUMMARY_RESOURCE,
  fetchCtbcLoans,
  parseCtbcLoans,
} from "../../../src/sources/ctbc/loans";

const now = new Date("2026-11-02T06:00:00.000Z");

// 合成資料：欄位形狀依 Android 5.2.28 qu010/010 回應，金額與帳號皆為虛構。
const personalLoan = {
  loanAcctId: "1234567890123456",
  loanAcctIndex: "0",
  loanType: "00",
  prodType: "小額信貸",
  loanBalAmt: "1,234,567",
  approveBal: "2,000,000",
  pmtAmt: "30,000",
  repayDt: "2026/11/13",
  repayDay: "13",
  period: "22",
  loanTerm: "84",
  remTerm: "62",
  intrstRate: "2.42",
  loanDt: "2024/12/13",
  expDt: "2031/12/13",
  pmtAcctId: "0000000000000000",
};

const response = (rsData: Record<string, unknown>) => ({
  sys: "SVC",
  code: "0000",
  rsData,
});

describe("中信貸款", () => {
  it("解析巢狀的信用貸款陣列為貸款帳戶與剩餘本金快照", () => {
    const result = parseCtbcLoans(
      response({
        totalLoanBalAmtP: "1,234,567",
        ebLoanAcctSummaryP: [[personalLoan]],
        totalLoanBalAmtH: "0",
      }),
      now,
    );
    expect(result.issue).toBeUndefined();
    expect(result.bankAccounts).toHaveLength(1);
    const [account] = result.bankAccounts;
    expect(account).toMatchObject({
      institutionName: "中國信託商業銀行",
      accountName: "信用貸款 末四碼 3456",
      accountType: "loan",
      loanCategory: "personal",
      loanInterestRate: 2.42,
      currency: "TWD",
      raw: {
        last4: "3456",
        initialAmount: 2_000_000,
        totalPeriods: 84,
        remainingPeriods: 62,
        paymentDay: 13,
        nextPaymentDate: "2026-11-13",
        nextPaymentAmount: 30_000,
        drawdownDate: "2024-12-13",
        maturityDate: "2031-12-13",
      },
    });
    expect(account?.sourceId).toMatch(/^loan:ctbc:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("1234567890123456");
    expect(account).not.toHaveProperty("autopayAccount");
    expect(result.bankBalanceSnapshots).toEqual([
      {
        accountId: account?.sourceId,
        sourceId: `snapshot:${account?.sourceId}:2026-11-02`,
        balance: -1_234_567,
        currency: "TWD",
        asOfAt: now.toISOString(),
        paymentDueDate: "2026-11-13",
        loanPaymentAmount: 30_000,
        loanInstallmentsPaid: 22,
        loanInstallmentsTotal: 84,
        raw: { balance: -1_234_567 },
      },
    ]);
  });

  it("房屋貸款歸類為 housing，缺 remTerm 時以 period 推算剩餘期數", () => {
    const { remTerm: _remTerm, ...withoutRemaining } = personalLoan;
    const result = parseCtbcLoans(
      response({
        ebLoanAcctSummaryP: [],
        ebLoanAcctSummaryH: [
          {
            ...withoutRemaining,
            loanAcctId: "9999888877776666",
            prodType: "房屋貸款",
          },
        ],
      }),
      now,
    );
    expect(result.bankAccounts[0]).toMatchObject({
      loanCategory: "housing",
      raw: { remainingPeriods: 62 },
    });
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      loanInstallmentsPaid: 22,
      loanInstallmentsTotal: 84,
    });
  });

  it("實機形狀：貸款陣列以 loanType 代碼為鍵的物件包裝", () => {
    const result = parseCtbcLoans(
      response({
        ebLoanAcctSummaryP: { "00": [personalLoan] },
        ebLoanAcctSummaryH: {},
        ebLoanAcctSummaryLA: [],
        ebLoanAcctSummaryO: {},
      }),
      now,
    );
    expect(result.issue).toBeUndefined();
    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.loanCategory).toBe("personal");
  });

  it("沒有貸款時回傳空結果，不視為錯誤", () => {
    const result = parseCtbcLoans(
      response({ ebLoanAcctSummaryP: [], ebLoanAcctSummaryH: [] }),
      now,
    );
    expect(result).toEqual({ bankAccounts: [], bankBalanceSnapshots: [] });
  });

  it("格式無法辨識或缺必要欄位時整批略過並回報原因", () => {
    expect(parseCtbcLoans(response({}), now).issue).toBe("loan_list_missing");
    expect(
      parseCtbcLoans(
        response({ ebLoanAcctSummaryP: [{ ...personalLoan, loanAcctId: "" }] }),
        now,
      ),
    ).toEqual({
      bankAccounts: [],
      bankBalanceSnapshots: [],
      issue: "loan_number_missing",
    });
    expect(
      parseCtbcLoans(
        response({
          ebLoanAcctSummaryP: [
            personalLoan,
            { ...personalLoan, loanAcctId: "1111222233334444", loanBalAmt: "" },
          ],
        }),
        now,
      ),
    ).toEqual({
      bankAccounts: [],
      bankBalanceSnapshots: [],
      issue: "loan_balance_missing",
    });
  });

  it("查詢失敗只略過貸款，重新驗證錯誤照常拋出", async () => {
    const calls: string[] = [];
    await expect(
      fetchCtbcLoans(async (resource) => {
        calls.push(resource);
        throw new Error("bank error");
      }, now),
    ).resolves.toEqual({
      bankAccounts: [],
      bankBalanceSnapshots: [],
      issue: "loan_query_failed",
    });
    expect(calls).toEqual([CTBC_LOAN_SUMMARY_RESOURCE]);
    await expect(
      fetchCtbcLoans(async () => {
        throw new CtbcVerificationRequiredError("need verify");
      }, now),
    ).rejects.toBeInstanceOf(CtbcVerificationRequiredError);
  });
});
