import { describe, expect, it } from "vitest";
import { parseRakutenData } from "../../../src/sources/rakuten/protocol";

const depositPageText = `
臺幣存款
活存

定存
活存總額 0081200000001234
$52,345
2026/09 活存明細
`;

const singleLoanPageText = `
貸款總覽
查看還款明細

樂天測試信貸
剩餘貸款金額
$456,789
1%
已還款
下次將於 2026/10/09 扣款 $6,543 自動扣款
初始貸款金額 $500,000
剩餘／初始期數 88／96
當期年利率 3.3300%
每月繳款日 9 日
當期應繳金額 $6,543
繳月付金
提前還本
`;

const twoLoansPageText = `
貸款總覽
查看還款明細

樂天測試信貸
剩餘貸款金額
$456,789
1%
已還款
下次將於 2026/10/09 扣款 $6,543 自動扣款
初始貸款金額 $500,000
剩餘／初始期數 88／96
當期年利率 3.3300%
每月繳款日 9 日
當期應繳金額 $6,543
繳月付金
提前還本

樂天生活貸
剩餘貸款金額
$150,000
5%
未繳款
下次將於 2026/10/05 扣款 $5,200 自動扣款
初始貸款金額 $300,000
剩餘／初始期數 30／60
當期年利率 6.5000%
每月繳款日 5 日
當期應繳金額 $5,200
繳月付金
提前還本
`;

const noLoanPageText = `
貸款總覽
查看還款明細
`;

describe("Rakuten loan parser", () => {
  it("parses a single loan block with all whitelisted terms", () => {
    const result = parseRakutenData({ loanPageText: singleLoanPageText });

    expect(result.bankAccounts).toHaveLength(1);
    const loan = result.bankAccounts[0];
    expect(loan).toMatchObject({
      institutionName: "樂天國際銀行",
      accountName: "樂天測試信貸",
      accountType: "loan",
      currency: "TWD",
    });
    expect(loan?.raw).toMatchObject({
      initialAmount: 500_000,
      remainingPeriods: 88,
      totalPeriods: 96,
      annualRatePct: 3.33,
      paymentDay: 9,
      nextPaymentDate: "2026-10-09",
      nextPaymentAmount: 6_543,
    });

    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      accountId: loan?.sourceId,
      balance: -456_789,
      currency: "TWD",
    });
  });

  it("produces stable loan sourceIds across repeated syncs", () => {
    const first = parseRakutenData({ loanPageText: singleLoanPageText });
    const second = parseRakutenData({ loanPageText: singleLoanPageText });
    expect(first.bankAccounts[0]?.sourceId).toBe(
      second.bankAccounts[0]?.sourceId,
    );
    expect(first.bankAccounts[0]?.sourceId).toMatch(/^loan:rakuten:[0-9a-f]+$/);
  });

  it("parses multiple loan blocks without cross-contamination", () => {
    const result = parseRakutenData({ loanPageText: twoLoansPageText });

    expect(result.bankAccounts).toHaveLength(2);
    const [first, second] = result.bankAccounts;
    expect(first).toMatchObject({ accountName: "樂天測試信貸" });
    expect(first?.raw).toMatchObject({ totalPeriods: 96, paymentDay: 9 });
    expect(second).toMatchObject({ accountName: "樂天生活貸" });
    expect(second?.raw).toMatchObject({ totalPeriods: 60, paymentDay: 5 });
    expect(first?.sourceId).not.toBe(second?.sourceId);

    expect(result.bankBalanceSnapshots).toHaveLength(2);
    expect(
      result.bankBalanceSnapshots.map((snapshot) => snapshot.balance),
    ).toEqual([-456_789, -150_000]);
  });

  it("returns no loans when the loan overview page has none", () => {
    const result = parseRakutenData({ loanPageText: noLoanPageText });
    expect(result.bankAccounts).toHaveLength(0);
    expect(result.bankBalanceSnapshots).toHaveLength(0);
  });

  it("combines deposit JSON with loan page text", () => {
    const result = parseRakutenData({
      dashboardPayload: {
        depositInfo: {
          depAccounts: [{ acctNo: "0081200000001234", ntdCurrBal: 52345 }],
        },
      },
      loanPageText: singleLoanPageText,
    });

    expect(
      result.bankAccounts.map((account) => account.accountType).sort(),
    ).toEqual(["loan", "savings"]);
    expect(
      result.bankBalanceSnapshots.map((snapshot) => snapshot.balance).sort(),
    ).toEqual([-456_789, 52_345]);
  });

  it("combines deposit page text with loan JSON", () => {
    const result = parseRakutenData({
      depositPageText,
      loanPayload: {
        loanProjects: [{ loanName: "樂天生活貸", loanBal: 150000 }],
      },
    });

    expect(
      result.bankAccounts.map((account) => account.accountType).sort(),
    ).toEqual(["loan", "savings"]);
    expect(
      result.bankBalanceSnapshots.map((snapshot) => snapshot.balance).sort(),
    ).toEqual([-150_000, 52_345]);
  });

  it("parses loans when only a loan payload is provided", () => {
    const result = parseRakutenData({
      loanPayload: {
        loanList: [{ marketingName: "樂天測試信貸", loanBal: 456789 }],
      },
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]).toMatchObject({
      accountType: "loan",
      accountName: "樂天測試信貸",
    });
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(-456_789);
  });

  it("falls back to deposit text when the deposit JSON has no usable account", () => {
    const result = parseRakutenData({
      dashboardPayload: { depositInfo: {} },
      depositPageText,
    });

    expect(result.bankAccounts.map((account) => account.sourceId)).toEqual([
      "bank:rakuten:0081200000001234:TWD",
    ]);
  });

  it("falls back to loan text when the loan JSON has no loans", () => {
    const result = parseRakutenData({
      loanPayload: { loanProjects: [] },
      loanPageText: twoLoansPageText,
    });

    expect(result.bankAccounts).toHaveLength(2);
  });

  it("combines deposit and loan data from a single sync", () => {
    const result = parseRakutenData({
      depositPageText,
      loanPageText: singleLoanPageText,
    });
    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankAccounts.map((a) => a.accountType).sort()).toEqual([
      "loan",
      "savings",
    ]);
  });
});

describe("Rakuten loan terms", () => {
  it("fills missing terms from the page text for the loan with the same name", () => {
    const result = parseRakutenData({
      loanPayload: {
        loanProjects: [
          { marketingName: "樂天測試信貸", remainLoanAmount: "450000" },
        ],
      },
      loanPageText: singleLoanPageText,
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.raw).toMatchObject({
      initialAmount: 500_000,
      remainingPeriods: 88,
      totalPeriods: 96,
      annualRatePct: 3.33,
      paymentDay: 9,
      nextPaymentDate: "2026-10-09",
      nextPaymentAmount: 6_543,
    });
    // 剩餘金額仍以 API 為準
    expect(result.bankBalanceSnapshots[0]?.balance).toBe(-450_000);
  });

  it("reads the field names used by the bank's loan page", () => {
    const result = parseRakutenData({
      loanPayload: {
        loanProjects: [
          {
            marketingName: "樂天測試信貸",
            remainLoanAmount: "456789",
            initLoanAmount: "500000",
            initPeriod: "96",
            remainPeriod: "88",
            currentRate: "3.33",
            monthlyPayDay: "9",
            nextRepaymentDate: "20261009",
            nextRepaymentAmount: "6543",
          },
        ],
      },
    });

    expect(result.bankAccounts[0]?.raw).toMatchObject({
      initialAmount: 500_000,
      totalPeriods: 96,
      remainingPeriods: 88,
      annualRatePct: 3.33,
      paymentDay: 9,
      nextPaymentDate: "2026-10-09",
      nextPaymentAmount: 6_543,
    });
  });

  it("uses monthlyRepayDay (the debit day shown on the loan page) over monthlyPayDay", () => {
    const result = parseRakutenData({
      loanPayload: {
        loanProjects: [
          {
            marketingName: "樂天測試信貸",
            remainLoanAmount: "456789",
            initLoanAmount: "500000",
            monthlyPayDay: "12",
            monthlyRepayDay: "17",
          },
        ],
      },
    });

    expect(result.bankAccounts[0]?.raw).toMatchObject({ paymentDay: 17 });
  });

  it("does not borrow terms from a loan with another name or an ambiguous match", () => {
    const otherName = parseRakutenData({
      loanPayload: {
        loanProjects: [
          { marketingName: "另一筆信貸", remainLoanAmount: "1000" },
        ],
      },
      loanPageText: singleLoanPageText,
    });
    expect(otherName.bankAccounts[0]?.raw).toMatchObject({
      initialAmount: undefined,
      totalPeriods: undefined,
    });

    const duplicated = parseRakutenData({
      loanPayload: {
        loanProjects: [
          { marketingName: "樂天測試信貸", remainLoanAmount: "1000" },
        ],
      },
      loanPageText: `${singleLoanPageText}\n${singleLoanPageText}`,
    });
    expect(duplicated.bankAccounts[0]?.raw).toMatchObject({
      totalPeriods: undefined,
    });
  });
});

describe("Rakuten loan identity", () => {
  const loanJson = (overrides: Record<string, unknown> = {}) => ({
    loanProjects: [
      {
        marketingName: "樂天測試信貸",
        loanBal: 456789,
        loanAmount: 500000,
        totalPeriod: 96,
        remainPeriod: 88,
        acctNo: "LOAN-TEST-0001",
        ...overrides,
      },
    ],
  });

  it("identifies text-path loans by name only", () => {
    const result = parseRakutenData(
      { loanPageText: twoLoansPageText },
      new Date("2026-09-28T01:00:00.000Z"),
    );
    expect(result.bankAccounts.map((account) => account.sourceId)).toEqual([
      "loan:rakuten:e6daf9cb",
      "loan:rakuten:b41f1916",
    ]);
    expect(
      result.bankBalanceSnapshots.map((snapshot) => snapshot.sourceId),
    ).toEqual([
      "snapshot:loan:rakuten:e6daf9cb:2026-09-28",
      "snapshot:loan:rakuten:b41f1916:2026-09-28",
    ]);
  });

  it("keeps one balance snapshot per day so the net-worth history has daily values", () => {
    const payload = {
      dashboardPayload: {
        depositInfo: {
          depAccounts: [{ acctNo: "0081200000001234", ntdCurrBal: 52345 }],
        },
      },
      loanPayload: {
        loanProjects: [
          { marketingName: "樂天測試信貸", remainLoanAmount: "456789" },
        ],
      },
    };
    const morning = parseRakutenData(
      payload,
      new Date("2026-09-28T01:00:00.000Z"),
    );
    const evening = parseRakutenData(
      payload,
      new Date("2026-09-28T12:00:00.000Z"),
    );
    const nextDay = parseRakutenData(
      payload,
      new Date("2026-09-29T01:00:00.000Z"),
    );

    const ids = (result: typeof morning) =>
      result.bankBalanceSnapshots.map((snapshot) => snapshot.sourceId);
    expect(ids(morning)).toEqual([
      "snapshot:rakuten:0081200000001234:TWD:2026-09-28",
      "snapshot:loan:rakuten:e6daf9cb:2026-09-28",
    ]);
    // 同一天再同步覆寫同一筆；隔天另起一筆
    expect(ids(evening)).toEqual(ids(morning));
    expect(ids(nextDay)).toEqual([
      "snapshot:rakuten:0081200000001234:TWD:2026-09-29",
      "snapshot:loan:rakuten:e6daf9cb:2026-09-29",
    ]);
    // 帳戶本身的 ID 不隨日期改變
    expect(nextDay.bankAccounts.map((account) => account.sourceId)).toEqual(
      morning.bankAccounts.map((account) => account.sourceId),
    );
  });

  it("produces the same sourceId for the same loan from JSON and page text", () => {
    const fromJson = parseRakutenData({ loanPayload: loanJson() });
    const fromText = parseRakutenData({ loanPageText: singleLoanPageText });

    expect(fromJson.bankAccounts[0]?.sourceId).toBe("loan:rakuten:e6daf9cb");
    expect(fromJson.bankAccounts[0]?.sourceId).toBe(
      fromText.bankAccounts[0]?.sourceId,
    );
    expect(fromJson.bankBalanceSnapshots[0]?.sourceId).toBe(
      fromText.bankBalanceSnapshots[0]?.sourceId,
    );
    expect(fromJson.bankBalanceSnapshots[0]?.balance).toBe(
      fromText.bankBalanceSnapshots[0]?.balance,
    );
  });

  it("keeps the loan sourceId stable after a monthly repayment", () => {
    const before = parseRakutenData({ loanPayload: loanJson() });
    const after = parseRakutenData({
      loanPayload: loanJson({ loanBal: 450000, remainPeriod: 87 }),
    });
    expect(after.bankAccounts[0]?.sourceId).toBe(
      before.bankAccounts[0]?.sourceId,
    );

    const repaidText = singleLoanPageText
      .replace("$456,789", "$450,000")
      .replace("88／96", "87／96");
    expect(
      parseRakutenData({ loanPageText: repaidText }).bankAccounts[0]?.sourceId,
    ).toBe("loan:rakuten:e6daf9cb");
  });

  it("matches the real loan overview shape that only has a name and remaining amount", () => {
    // CLNQU0001/010 解密後每筆只有 marketingName、remainLoanAmount（字串）與旗標
    const fromJson = parseRakutenData({
      loanPayload: {
        loanProjects: [
          {
            marketingName: "樂天測試信貸",
            remainLoanAmount: "456789",
            showNextRepay: true,
            payNowFlag: false,
          },
        ],
      },
    });
    const fromText = parseRakutenData({ loanPageText: singleLoanPageText });

    expect(fromJson.bankAccounts[0]?.sourceId).toBe(
      fromText.bankAccounts[0]?.sourceId,
    );
    expect(fromJson.bankBalanceSnapshots[0]?.balance).toBe(-456_789);
  });

  it("gives identical loans in the same sync distinct sourceIds", () => {
    const project = {
      loanName: "樂天生活貸",
      loanBal: 150000,
      loanAmount: 300000,
      totalPeriod: 60,
    };
    const result = parseRakutenData({
      loanPayload: { loanProjects: [project, { ...project, loanBal: 90000 }] },
    });
    const ids = result.bankAccounts.map((account) => account.sourceId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("loan:rakuten:b41f1916");
  });

  it("stores only whitelisted loan fields and skips entries without a remaining amount", () => {
    const result = parseRakutenData({
      loanPayload: {
        loanProjects: [
          { ...loanJson().loanProjects[0], custName: "測試客戶" },
          { loanName: "沒有餘額的項目" },
        ],
      },
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]?.raw).toEqual({
      initialAmount: 500000,
      remainingPeriods: 88,
      totalPeriods: 96,
      annualRatePct: undefined,
      paymentDay: undefined,
      nextPaymentDate: undefined,
      nextPaymentAmount: undefined,
      drawdownDate: undefined,
      loanNoLast4: "0001",
    });
    expect(JSON.stringify(result.bankAccounts[0]?.raw)).not.toContain(
      "LOAN-TEST",
    );
  });

  it("parses loan drawdown date from the JSON API (lastDrawdownDate or effectiveDate)", () => {
    const fromLastDrawdownDate = parseRakutenData({
      loanPayload: {
        loanProjects: [
          {
            marketingName: "樂天測試信貸",
            remainLoanAmount: "456789",
            lastDrawdownDate: "2024/01/15",
          },
        ],
      },
    });
    expect(fromLastDrawdownDate.bankAccounts[0]?.raw).toMatchObject({
      drawdownDate: "2024-01-15",
    });

    const fromEffectiveDate = parseRakutenData({
      loanPayload: {
        loanProjects: [
          {
            marketingName: "樂天測試信貸",
            remainLoanAmount: "456789",
            effectiveDate: "2024/02/20",
          },
        ],
      },
    });
    expect(fromEffectiveDate.bankAccounts[0]?.raw).toMatchObject({
      drawdownDate: "2024-02-20",
    });
  });
});
