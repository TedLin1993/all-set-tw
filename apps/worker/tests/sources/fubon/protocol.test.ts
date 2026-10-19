import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FUBON_CREDIT_ACCOUNT_ID,
  classifyFubonLoginResponse,
  deriveFubonPaymentState,
  fubonBillPaidState,
  fubonTransactionRange,
  isFubonTransactionPageTruncated,
  parseFubonBill,
  parseFubonCardStatus,
  parseFubonData,
  FubonSyncReport,
  summarizeFubonResult,
  parseFubonDepositTransactionsPage,
  describeFubonTransactionAccountsHtml,
  fubonComboValueShape,
  matchFubonTransactionAccounts,
  parseFubonDepositOverview,
  parseFubonTransactionAccounts,
  parseFubonUnbilled,
  splitFubonRange,
  type FubonPayloads,
} from "../../../src/sources/fubon/protocol";

// 去識別化 fixture 取自台北富邦網銀實際頁面：帳號、卡號、繳款帳號、token 與商店名稱已替換，
// 金額、日期與欄位格式保留。預期值依同一份銀行畫面判讀，而非由 parser 輸出倒推。
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const overviewHtml = fixture("deposit-overview.html");
const transactionsHtml = fixture("deposit-transactions.html");
const statusHtml = fixture("card-payment-status.html");
const billHtml = fixture("card-bill.html");
const unbilledHtml = fixture("card-unbilled.html");

const NOW = new Date("2026-10-13T16:00:00Z"); // 台灣時間 2026-10-14 00:00
const ACCOUNT_NO = "01234500004321";

function payloads(overrides: Partial<FubonPayloads> = {}): FubonPayloads {
  return {
    depositOverviewHtml: overviewHtml,
    depositTransactions: [
      { accountNo: ACCOUNT_NO, currency: "TWD", pages: [transactionsHtml] },
    ],
    card: {
      hasCreditCard: true,
      statusHtml,
      billHtmls: [billHtml],
      unbilledHtml,
    },
    ...overrides,
  };
}

describe("台北富邦存款", () => {
  it("同一帳號的臺幣與外幣活存依幣別分開，保留原幣小數餘額", () => {
    const data = parseFubonData(payloads(), NOW);
    const deposits = data.bankAccounts.filter(
      (account) => account.accountType !== "credit",
    );
    expect(deposits.map((account) => account.currency).sort()).toEqual([
      "CNY",
      "TWD",
      "USD",
    ]);
    const balances = Object.fromEntries(
      data.bankBalanceSnapshots
        .filter((snapshot) => snapshot.accountId.startsWith("bank:fubon:"))
        .map((snapshot) => [snapshot.currency, snapshot.balance]),
    );
    expect(balances).toEqual({ TWD: 50, USD: 3.15, CNY: 1.2 });
    for (const account of deposits) {
      expect(account.sourceId).toMatch(
        /^bank:fubon:4321:[0-9a-f]{16}:(TWD|USD|CNY)$/,
      );
      // 完整帳號不得出現在 sourceId 或 raw。
      expect(JSON.stringify(account)).not.toContain(ACCOUNT_NO);
    }
  });

  it("支出為負、存入為正，交易時間以台灣時區保存", () => {
    const transactions = parseFubonData(
      payloads(),
      NOW,
    ).bankTransactions.filter((transaction) =>
      transaction.sourceId.startsWith("fubon:deposit:tx:"),
    );
    expect(transactions).toHaveLength(8);
    const byTime = new Map(
      transactions.map((transaction) => [
        transaction.authorizedAt,
        transaction,
      ]),
    );
    expect(byTime.get("2026-08-10T10:12:30+08:00")).toMatchObject({
      amount: 18400,
      postedDate: "2026-08-10",
      description: "ＣＤ轉收",
      raw: { balanceAfter: 18520 },
    });
    expect(byTime.get("2026-08-12T04:20:00+08:00")).toMatchObject({
      amount: -18450,
      raw: { balanceAfter: 70 },
    });
    // 帳務日期與交易時間不同日時，入帳日用帳務日期。
    expect(byTime.get("2026-09-10T23:20:15+08:00")).toMatchObject({
      amount: 3500,
      postedDate: "2026-09-11",
    });
    expect(
      transactions.reduce((sum, transaction) => sum + transaction.amount, 0),
    ).toBe(-70);
  });

  it("重複同步與分段重查得到相同交易 ID 且不重複", () => {
    const first = parseFubonData(payloads(), NOW).bankTransactions;
    const again = parseFubonData(
      payloads({
        depositTransactions: [
          {
            accountNo: ACCOUNT_NO,
            currency: "TWD",
            pages: [transactionsHtml, transactionsHtml],
          },
        ],
      }),
      NOW,
    ).bankTransactions;
    expect(again.map((transaction) => transaction.sourceId)).toEqual(
      first.map((transaction) => transaction.sourceId),
    );
  });

  it("交易明細帳號選單與查詢期間可對應總覽帳號", () => {
    expect(parseFubonTransactionAccounts(transactionsHtml)).toEqual([
      {
        value: "012-0001234500004321-TWD-31",
        accountNo: "0001234500004321",
        currency: "TWD",
      },
    ]);
    const page = parseFubonDepositTransactionsPage(transactionsHtml);
    expect(page).toMatchObject({
      pageSize: 48,
      selectedAccount: "012-0001234500004321-TWD-31",
      startDate: "2026/07/13",
      endDate: "2026/10/13",
    });
    expect(isFubonTransactionPageTruncated(page)).toBe(false);
    expect(
      isFubonTransactionPageTruncated({ ...page, pageSize: page.rows.length }),
    ).toBe(true);
    expect(fubonTransactionRange(NOW)).toEqual({
      start: "2026/07/14",
      end: "2026/10/14",
    });
    expect(splitFubonRange({ start: "2026/07/14", end: "2026/10/14" })).toEqual(
      [
        { start: "2026/07/14", end: "2026/08/29" },
        { start: "2026/08/30", end: "2026/10/14" },
      ],
    );
    expect(
      splitFubonRange({ start: "2026/10/14", end: "2026/10/14" }),
    ).toBeUndefined();
  });

  it("格式不符而拒絕的資料列仍計入交易頁截斷判斷", () => {
    const page = parseFubonDepositTransactionsPage(transactionsHtml);
    expect(
      isFubonTransactionPageTruncated({
        ...page,
        rows: page.rows.slice(0, -1),
        rejected: ["台北富邦交易明細日期無法解析。"],
        pageSize: page.rows.length,
      }),
    ).toBe(true);
  });

  it("無法辨識的交易明細頁面不當成查無交易", () => {
    expect(() =>
      parseFubonDepositTransactionsPage("<html><body>系統維護中</body></html>"),
    ).toThrow(/交易明細頁面格式無法辨識/);
  });
});

describe("台北富邦信用卡", () => {
  it("帳單以民國年轉換，消費為負、自動扣繳為正並略過卡片與摘要列", () => {
    const bill = parseFubonBill(billHtml);
    expect(bill).toMatchObject({
      period: "2026-09",
      statementClosingDate: "2026-09-26",
      paymentDueDate: "2026-10-12",
      creditLimit: 150000,
      previousBalance: 3480,
      paymentsAndRefunds: 3480,
      newCharges: 1340,
      statementAmount: 1340,
      minimumPayment: 1000,
    });
    expect(bill?.transactions).toHaveLength(3);

    const data = parseFubonData(payloads(), NOW);
    const posted = data.bankTransactions.filter(
      (transaction) =>
        transaction.status === "posted" &&
        transaction.accountId === FUBON_CREDIT_ACCOUNT_ID,
    );
    expect(
      posted.map((transaction) => [
        transaction.sourceId,
        transaction.authorizedAt,
        transaction.postedDate,
        transaction.amount,
      ]),
    ).toEqual([
      [
        "fubon:card:tx:v1:account:2026-09-14:3480:1",
        "2026-09-14",
        "2026-09-15",
        3480,
      ],
      [
        "fubon:card:tx:v1:9876:2026-09-09:-1050:1",
        "2026-09-09",
        "2026-09-10",
        -1050,
      ],
      [
        "fubon:card:tx:v1:9876:2026-09-09:-290:1",
        "2026-09-09",
        "2026-09-10",
        -290,
      ],
    ]);
    // 帳單本期新增等於消費明細合計。
    expect(
      -posted
        .filter((transaction) => transaction.amount < 0)
        .reduce((sum, transaction) => sum + transaction.amount, 0),
    ).toBe(bill?.newCharges);
  });

  it("未出帳消費為待入帳，負債合計剩餘應繳與未出帳總額", () => {
    expect(parseFubonUnbilled(unbilledHtml)).toMatchObject({
      expectedClosingDate: "2026-10-26",
      total: 640,
    });
    const data = parseFubonData(payloads(), NOW);
    expect(
      data.bankTransactions.filter(
        (transaction) => transaction.status === "pending",
      ),
    ).toEqual([
      expect.objectContaining({
        sourceId: "fubon:card:tx:v1:9876:2026-09-30:-640:1",
        authorizedAt: "2026-09-30",
        amount: -640,
        cardLast4: "9876",
        raw: expect.objectContaining({ cardLast4: "9876" }),
      }),
    ]);
    const snapshot = data.bankBalanceSnapshots.find(
      (item) => item.accountId === FUBON_CREDIT_ACCOUNT_ID,
    );
    expect(snapshot).toMatchObject({
      balance: -1980,
      statementBalance: 1340,
      statementClosingDate: "2026-09-26",
      paymentDueDate: "2026-10-12",
      noPaymentNeeded: false,
    });
    expect(
      data.bankAccounts.find((account) => account.accountType === "credit"),
    ).toMatchObject({ creditLimit: 150000 });
  });

  it("自動扣繳當日「未繳款」但已繳金額已達應繳總額時視為已繳（款項處理中）", () => {
    // 2026-10 真實帳戶：扣款當日頁面為「未繳款」、已繳金額＝剩餘應繳；隔日即轉為「已繳款」、剩餘 0。
    const status = parseFubonCardStatus(statusHtml);
    expect(status).toMatchObject({
      hasCreditCard: true,
      statementAmount: 1340,
      minimumPayment: 1000,
      paymentStatus: "未繳款",
      lastPaymentDate: "2026-10-13",
      paidAmount: 1340,
      remainingAmount: 1340,
      creditLimit: 150000,
      availableCredit: 149360,
      autopay: true,
    });
    if (!status.hasCreditCard) throw new Error("expected card");
    expect(deriveFubonPaymentState(status, NOW)).toBe("payment_processing");
    expect(fubonBillPaidState(status, NOW)).toBe(true);
    const bill = parseFubonData(payloads(), NOW).creditCardBills[0];
    expect(bill).toMatchObject({
      sourceId: "fubon:card:bill:2026-09",
      billingPeriod: "2026-09",
      statementAmount: 1340,
      paidAmount: 1340,
      isPaid: true,
      raw: expect.objectContaining({
        paymentState: "payment_processing",
        paymentStateSource: "payment_page",
        paymentStatus: "未繳款",
      }),
    });
  });

  it("剩餘應繳為 0 視為已繳；未繳款且無已繳金額視為待繳", () => {
    const status = parseFubonCardStatus(statusHtml);
    if (!status.hasCreditCard) throw new Error("expected card");
    expect(fubonBillPaidState({ ...status, remainingAmount: 0 }, NOW)).toBe(
      true,
    );
    expect(
      fubonBillPaidState({ ...status, paidAmount: 0, autopay: false }, NOW),
    ).toBe(false);
    expect(
      fubonBillPaidState(
        { ...status, paymentStatus: "已繳款", remainingAmount: 0 },
        NOW,
      ),
    ).toBe(true);
  });

  it("只有明確無卡提示才略過信用卡，未知頁面不當成無卡", () => {
    // 合成無卡畫面：台北富邦實際無卡文案尚未以真實帳號確認。
    const noCard = `<html><body><div class="Reminder_message"><div class="txt_ct"><span>您目前沒有本行信用卡</span></div></div></body></html>`;
    expect(parseFubonCardStatus(noCard)).toEqual({ hasCreditCard: false });
    expect(() =>
      parseFubonCardStatus("<html><body>系統忙碌中</body></html>"),
    ).toThrow(/信用卡繳款頁面格式無法辨識/);
    const data = parseFubonData(
      payloads({ card: { hasCreditCard: false } }),
      NOW,
    );
    expect(data.hasCreditCard).toBe(false);
    expect(data.creditCardBills).toEqual([]);
    expect(
      data.bankAccounts.some((account) => account.accountType === "credit"),
    ).toBe(false);
    expect(data.bankTransactions.length).toBeGreaterThan(0);
  });
});

describe("台北富邦登入回應", () => {
  it("依官方登入頁錯誤碼分類，只有 0290 屬於驗證碼錯誤", () => {
    expect(classifyFubonLoginResponse({ result: true })).toEqual({
      kind: "success",
    });
    expect(classifyFubonLoginResponse({ errorCode: "0290" })).toMatchObject({
      kind: "captcha",
    });
    expect(classifyFubonLoginResponse({ errorCode: "EP40" })).toMatchObject({
      kind: "credential",
    });
    expect(classifyFubonLoginResponse({ errorCode: "0212" })).toMatchObject({
      kind: "duplicate",
    });
    expect(
      classifyFubonLoginResponse({ errorCode: "0241", otp: "Y" }),
    ).toMatchObject({ kind: "two_factor", channel: "otp" });
    expect(
      classifyFubonLoginResponse({ errorCode: "0241", otp: "N" }),
    ).toMatchObject({ kind: "two_factor", channel: "device" });
    expect(
      classifyFubonLoginResponse({ errorCode: "9999", errorDesc: "其他" }),
    ).toMatchObject({ kind: "unknown" });
  });

  it("classifies the real login response shape (synthetic values)", () => {
    // 欄位形狀取自真實登入回應 {result, errorCode, errorDesc, signonToken}；值為合成。
    expect(
      classifyFubonLoginResponse({
        result: true,
        errorCode: "",
        errorDesc: "",
        signonToken: "synthetic-token-0001",
      }),
    ).toEqual({ kind: "success" });
    expect(
      classifyFubonLoginResponse({
        result: false,
        errorCode: "0212",
        errorDesc: "您已在其他裝置登入，是否繼續？",
        signonToken: "",
      }),
    ).toEqual({ kind: "duplicate", code: "0212" });
    expect(
      classifyFubonLoginResponse({
        result: false,
        errorCode: "0290",
        errorDesc: "圖形驗證碼錯誤",
        signonToken: "",
      }),
    ).toEqual({ kind: "captcha", code: "0290" });
    expect(
      classifyFubonLoginResponse({
        result: false,
        errorCode: "EP32",
        errorDesc: "身分證字號或使用者代碼錯誤",
        signonToken: "",
      }),
    ).toEqual({ kind: "credential", code: "EP32" });
    expect(
      classifyFubonLoginResponse({
        result: false,
        errorCode: "X123",
        errorDesc: "使用者密碼錯誤",
        signonToken: "",
      }),
    ).toEqual({ kind: "credential", code: "X123" });
    expect(
      classifyFubonLoginResponse({
        result: false,
        errorCode: "0241",
        errorDesc: "",
        signonToken: "",
        otp: "Y",
      }),
    ).toEqual({ kind: "two_factor", code: "0241", channel: "otp" });
    expect(
      classifyFubonLoginResponse({
        result: false,
        errorCode: "",
        errorDesc: "",
        signonToken: "",
      }),
    ).toEqual({ kind: "unknown", code: "unknown" });
  });

  describe("交易明細帳號選單（合成帳號）", () => {
    // 合成帳號，不對應任何真實帳戶。
    const selectOnly = `<form id="form1"><div class="input_sel_s">
<select name="form1:comboAccount" id="form1:comboAccount" class="Default_Combo">
<option value="none">請選擇</option>
<option value="012-0009876500001111-TWD-31">09876500001111 (常用)</option>
<option value='012-0009876500002222-USD-31'>09876500002222</option>
</select></div></form>`;

    it("沒有 comboAccountItems 腳本時改由 select option 解析", () => {
      expect(parseFubonTransactionAccounts(selectOnly)).toEqual([
        {
          value: "012-0009876500001111-TWD-31",
          accountNo: "0009876500001111",
          currency: "TWD",
        },
        {
          value: "012-0009876500002222-USD-31",
          accountNo: "0009876500002222",
          currency: "USD",
        },
      ]);
      expect(describeFubonTransactionAccountsHtml(selectOnly)).toEqual({
        hasComboScript: false,
        hasComboSelect: true,
        selectOptionCount: 3,
      });
    });

    it("合併腳本、select 與 window.comboAccountItems 的值並去除重複", () => {
      const options = parseFubonTransactionAccounts(transactionsHtml, [
        "012-0001234500004321-TWD-31",
        "012-0009876500003333-TWD-31",
        "_none",
        "",
      ]);
      expect(options.map((option) => option.value)).toEqual([
        "012-0001234500004321-TWD-31",
        "012-0009876500003333-TWD-31",
      ]);
      expect(
        describeFubonTransactionAccountsHtml(transactionsHtml),
      ).toMatchObject({ hasComboScript: true, hasComboSelect: true });
    });

    it("腳本以單引號或其他索引寫法時仍可解析", () => {
      const html = `<script>var comboAccountItems = [];
comboAccountItems[i] = new Array('09876500004444', '012-0009876500004444-TWD-31', '_none');</script>`;
      expect(parseFubonTransactionAccounts(html)).toEqual([
        {
          value: "012-0009876500004444-TWD-31",
          accountNo: "0009876500004444",
          currency: "TWD",
        },
      ]);
    });

    it("總覽帳號（14 碼）可對應選單帳號（16 碼補零），缺少的帳戶列為 missing", () => {
      const { accounts } = parseFubonDepositOverview(overviewHtml);
      const twd = accounts.filter((account) => account.currency === "TWD");
      const extra = { ...twd[0]!, accountNo: "09876500009999" };
      const result = matchFubonTransactionAccounts(
        [...twd, extra],
        parseFubonTransactionAccounts(transactionsHtml),
      );
      expect(result.matched.map((item) => item.option.value)).toEqual([
        "012-0001234500004321-TWD-31",
      ]);
      expect(result.missing).toEqual([extra]);
    });

    it("診斷用的選單值形狀不含帳號數字", () => {
      expect(fubonComboValueShape("012-0001234500004321-TWD-31")).toBe(
        "N3-N16-TWD-N2",
      );
    });
  });
});

describe("台北富邦同步總結", () => {
  it("fubon_sync_result 只含帳戶數、幣別與成功失敗筆數", () => {
    const report = new FubonSyncReport();
    const data = parseFubonData(payloads(), NOW, report);
    const result = summarizeFubonResult(data, report);
    expect(result).toMatchInlineSnapshot(`
      {
        "cardBills": 1,
        "cardTransactions": 3,
        "cardUnbilled": 1,
        "creditCards": 1,
        "depositTransactions": 8,
        "failed": 0,
        "foreignAccounts": 2,
        "foreignCurrencies": [
          "CNY",
          "USD",
        ],
        "message": "fubon[sync] success - twdAccounts:1, foreignAccounts:2, cards:1, cardBills:1",
        "status": "complete",
        "succeeded": 11,
        "twdAccounts": 1,
      }
    `);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_NO);
  });
});
