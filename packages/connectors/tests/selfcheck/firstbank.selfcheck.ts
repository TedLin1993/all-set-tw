import assert from "node:assert/strict";
import {
  parseFirstbankConfig,
  parseFirstbankData,
  FirstbankProtocolError,
} from "../../src/firstbank";

const accountNumber = "998877665544";
const cardNumber = "4321********8765";
const now = new Date("2026-08-27T00:00:00.000Z");

assert.deepEqual(
  parseFirstbankConfig({
    userId: "SYNTHETIC-USER",
    account: "synthetic-login",
    password: "synthetic-password",
    sessionCookies: "SESSION=synthetic-cookie",
    sessionCreatedAt: "2026-08-27T00:00:00.000Z",
    browserSessionId: "synthetic-browser-session",
    browserSessionExpiresAt: "2026-08-27T01:00:00.000Z",
    captchaDigitCount: 6,
    captcha: "A1b2C3",
  }),
  {
    userId: "SYNTHETIC-USER",
    account: "synthetic-login",
    password: "synthetic-password",
    sessionCookies: "SESSION=synthetic-cookie",
    sessionCreatedAt: "2026-08-27T00:00:00.000Z",
    browserSessionId: "synthetic-browser-session",
    browserSessionExpiresAt: "2026-08-27T01:00:00.000Z",
    captchaDigitCount: 6,
    captcha: "A1b2C3",
  },
);
assert.throws(() => parseFirstbankConfig({ captcha: "123" }), /captcha/i);

const depositOverviewHtml = `
  <table>
    <tr class="ResultHeader">
      <td>分行</td><td>帳戶<br>類別</td><td>帳號<br>與暱稱</td>
      <td>幣別</td><td>帳面<br>餘額</td><td>可用<br>餘額</td><td>其他功能</td>
    </tr>
    <tr class="ResultContent">
      <td>合成分行</td><td>iLEO 帳戶</td><td>${accountNumber}<br>日常存款</td>
      <td>新臺幣</td><td>12,345</td><td>11,000</td><td>-</td>
    </tr>
    <tr class="ResultContent">
      <td>合成分行</td><td>VISA 金融卡</td><td>4321********8765</td>
      <td>-</td><td>-</td><td>-</td><td>-</td>
    </tr>
  </table>
`;

const transactionHistoryHtml = `
  <div>帳號：${accountNumber}</div>
  <table>
    <tr class="ResultHeader">
      <td>交易<br>日期</td><td>交易類別</td><td>支出<br>金額</td>
      <td>存入<br>金額</td><td>餘額</td><td>狀態</td><td>備註</td><td>摘要</td>
    </tr>
    <tr class="ResultContent">
      <td>2026/08/20 09:10:11</td><td>一般扣款</td><td>345</td><td>0</td>
      <td>12,000</td><td>正常</td><td>合成商店</td><td>購物</td>
    </tr>
    <tr class="ResultContent">
      <td>2026/08/21 10:20:30</td><td>轉帳存入</td><td>0</td><td>2,000</td>
      <td>14,000</td><td>處理中</td><td>合成匯款</td><td>薪資</td>
    </tr>
  </table>
`;

const cardBill = {
  HEAD: { MSGID: "CMSQRY0014", RETURNCODE: "0000" },
  CONTENT: {
    BillRecords: [
      {
        BillDate: "2026/08/03",
        PayEndDate: "2026/08/18",
        TotalAmount: "1,234",
        MinAmount: "500",
        CreditAmount: "50,000",
        Records: [
          {
            CardNo: cardNumber,
            TransDate: "2026/07/20",
            AcctDate: "2026/07/22",
            TransDetail: "合成商店消費",
            AcctAmount: "1,234",
          },
          { TransDetail: "小計", AcctAmount: "1,234" },
        ],
      },
    ],
  },
};

const cardUnbilled = {
  HEAD: { MSGID: "CMSQRY0008", RETURNCODE: "0000" },
  CONTENT: {
    RecordCount: "1",
    Records: [
      {
        TransDate: "20260825",
        TransAmount: "200",
        TransDetail: "合成待入帳消費",
        CardNo: cardNumber,
        Currency: "新台幣",
      },
    ],
  },
};

const recentPayments = {
  HEAD: { MSGID: "CMSQRY0006", RETURNCODE: "0000" },
  CONTENT: {
    Records: [
      {
        PayDate: "20260818",
        Amount: "500",
        Currency: "TWD",
        Memo: "合成信用卡繳款",
      },
    ],
  },
};

const payloads = {
  depositOverviewHtml,
  transactionHistoryHtml,
  cardBill,
  cardUnbilled,
  recentPayments,
};
const parsed = parseFirstbankData(payloads, now);
const repeated = parseFirstbankData(payloads, now);
const transactionsWithoutPageAccount = parseFirstbankData(
  {
    depositOverviewHtml,
    transactionHistoryHtml: transactionHistoryHtml.replace(
      `<div>帳號：${accountNumber}</div>`,
      "<div>交易明細</div>",
    ),
  },
  now,
);

assert.equal(parsed.bankAccounts.length, 2);
assert.equal(
  parsed.bankAccounts.find((account) => account.accountType === "savings")
    ?.accountName,
  "日常存款",
);
assert.equal(parsed.bankBalanceSnapshots.length, 2);
assert.equal(parsed.bankTransactions.length, 5);
assert.equal(
  transactionsWithoutPageAccount.bankTransactions.length,
  2,
  "交易頁未顯示帳號時，單一存款帳戶仍應能安全對應明細",
);
assert.equal(
  parsed.bankTransactions.find(
    (transaction) => transaction.description === "購物",
  )?.amount,
  -345,
);
assert.equal(
  parsed.bankTransactions.find(
    (transaction) => transaction.description === "薪資",
  )?.amount,
  2000,
);
assert.equal(
  parsed.bankTransactions.find((transaction) =>
    transaction.description.includes("待入帳"),
  )?.amount,
  -200,
);
assert.equal(parsed.creditCardBills.length, 1);
assert.deepEqual(parsed.creditCardBills[0], {
  ...parsed.creditCardBills[0],
  statementAmount: 1234,
  minimumPayment: 500,
  paidAmount: 500,
  isPaid: false,
});
assert.equal(parsed.bankBalanceSnapshots[1]?.balance, -934);
assert.deepEqual(
  parsed.bankAccounts.map(({ sourceId }) => sourceId),
  repeated.bankAccounts.map(({ sourceId }) => sourceId),
);
assert.deepEqual(
  parsed.bankTransactions.map(({ sourceId }) => sourceId),
  repeated.bankTransactions.map(({ sourceId }) => sourceId),
);
const serialized = JSON.stringify(parsed);
assert.doesNotMatch(serialized, new RegExp(accountNumber));
assert.doesNotMatch(serialized, /synthetic-password/);
assert.match(serialized, /8765/);

const englishDepositOverviewHtml = `
  <table>
    <tr class="ResultHeader">
      <td>Branch</td><td>Account<br>Type</td><td>Account<br>and Nickname</td>
      <td>Currency</td><td>Ledger<br>Balance</td><td>Available<br>Balance</td><td>Other</td>
    </tr>
    <tr class="ResultContent">
      <td>Synthetic Branch</td><td>iLEO Account</td><td>${accountNumber}<br>Daily deposit</td>
      <td>New Taiwan Dollar</td><td>12,345</td><td>11,000</td><td>-</td>
    </tr>
    <tr class="ResultContent">
      <td>Synthetic Branch</td><td>VISA Debit Card</td><td>4321********8765</td>
      <td>-</td><td>-</td><td>-</td><td>-</td>
    </tr>
  </table>
`;

const englishBookBalanceOverviewHtml = englishDepositOverviewHtml
  .replace("Account<br>and Nickname", "Account / nickname")
  .replace("Ledger<br>Balance", "Book<br>Balance")
  .replace("Available<br>Balance", "Available")
  .replace("New Taiwan Dollar", "NTD");

const englishTransactionHistoryHtml = `
  <div>Account No.: ${accountNumber}</div>
  <table>
    <tr class="ResultHeader">
      <td>Date</td><td>Type</td><td>Withdrawal</td>
      <td>Deposit</td><td>Balance</td><td>Status</td><td>Memo</td><td>Summary</td>
    </tr>
    <tr class="ResultContent">
      <td>2026/08/20 09:10:11</td><td>Payment</td><td>345</td><td>0</td>
      <td>12,000</td><td>Normal</td><td>Synthetic shop</td><td>Shopping</td>
    </tr>
    <tr class="ResultContent">
      <td>2026/08/21 10:20:30</td><td>Incoming transfer</td><td>0</td><td>2,000</td>
      <td>14,000</td><td>Processing</td><td>Synthetic credit</td><td>Payroll</td>
    </tr>
  </table>
`;

const englishParsed = parseFirstbankData(
  {
    depositOverviewHtml: englishDepositOverviewHtml,
    transactionHistoryHtml: englishTransactionHistoryHtml,
  },
  now,
);
const englishBookParsed = parseFirstbankData(
  { depositOverviewHtml: englishBookBalanceOverviewHtml },
  now,
);

assert.equal(englishParsed.bankAccounts.length, 1);
assert.equal(
  englishParsed.bankAccounts.find(
    (account) => account.accountType === "savings",
  )?.accountName,
  "Daily deposit",
);
assert.equal(englishParsed.bankBalanceSnapshots[0]?.balance, 12345);
assert.equal(englishParsed.bankBalanceSnapshots[0]?.availableBalance, 11000);
assert.equal(englishParsed.bankBalanceSnapshots[0]?.currency, "TWD");
assert.equal(englishBookParsed.bankBalanceSnapshots[0]?.balance, 12345);
assert.equal(
  englishBookParsed.bankBalanceSnapshots[0]?.availableBalance,
  11000,
);
assert.equal(englishParsed.bankTransactions.length, 2);
assert.equal(
  englishParsed.bankTransactions.find(
    (transaction) => transaction.description === "Shopping",
  )?.amount,
  -345,
);
assert.equal(
  englishParsed.bankTransactions.find(
    (transaction) => transaction.description === "Payroll",
  )?.amount,
  2000,
);
const englishSerialized = JSON.stringify(englishParsed);
assert.doesNotMatch(englishSerialized, new RegExp(accountNumber));
assert.doesNotMatch(englishSerialized, /8765/);

assert.deepEqual(
  parseFirstbankData({
    depositOverviewHtml: "<p>查無資料</p>",
    transactionHistoryHtml: "<p>查無資料</p>",
    cardBill: {
      HEAD: { MSGID: "CMSQRY0014", RETURNCODE: "0000" },
      CONTENT: { BillRecords: [] },
    },
    cardUnbilled: {
      HEAD: { MSGID: "CMSQRY0008", RETURNCODE: "0000" },
      CONTENT: { Records: [] },
    },
    recentPayments: {
      HEAD: { MSGID: "CMSQRY0006", RETURNCODE: "0000" },
      CONTENT: { Records: [] },
    },
  }),
  {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    bankTransactions: [],
    creditCardBills: [],
  },
);
assert.throws(
  () =>
    parseFirstbankData({
      depositOverviewHtml: "<table><tr><td>changed</td></tr></table>",
    }),
  FirstbankProtocolError,
);
assert.throws(
  () =>
    parseFirstbankData({
      cardUnbilled: {
        HEAD: { MSGID: "CMSQRY0008", RETURNCODE: "0000" },
        CONTENT: { Records: [{ TransDate: "20260825" }] },
      },
    }),
  FirstbankProtocolError,
);
assert.throws(
  () =>
    parseFirstbankData({
      transactionHistoryHtml,
    }),
  /找不到對應的存款帳戶/,
);
assert.throws(
  () =>
    parseFirstbankData({
      cardUnbilled: [{ TransDate: "20260825", TransAmount: "100" }],
    }),
  /回應格式已變更/,
);

const trailingMinusAndDebit = parseFirstbankData(
  {
    depositOverviewHtml: depositOverviewHtml.replace("12,345", "12,345-"),
    cardUnbilled: {
      HEAD: { MSGID: "CMSQRY0008", RETURNCODE: "0000" },
      CONTENT: {
        Records: [
          {
            TransDate: "20260825",
            TransAmount: "300",
            TransDetail: "信用卡自動扣款",
            CardNo: cardNumber,
            Currency: "新台幣",
          },
        ],
      },
    },
  },
  now,
);
assert.equal(trailingMinusAndDebit.bankBalanceSnapshots[0]?.balance, -12345);
assert.equal(trailingMinusAndDebit.bankTransactions[0]?.amount, -300);

const statementLines = parseFirstbankData(
  {
    depositOverviewHtml,
    cardBill,
    cardUnbilled: {
      HEAD: { MSGID: "CMSQRY0008", RETURNCODE: "0000" },
      CONTENT: {
        Records: [
          {
            TransDate: "20260803",
            TransAmount: "1001",
            TransDetail: "前期帳單金額",
            Currency: "新台幣",
          },
          {
            TransDate: "20260818",
            TransAmount: "-1001",
            TransDetail: "一銀自動扣款",
            Currency: "新台幣",
          },
          {
            TransDate: "20260808",
            TransAmount: "20",
            TransDetail: "微笑單車股份有限公司",
            CardNo: cardNumber,
            Currency: "新台幣",
          },
        ],
      },
    },
    recentPayments,
  },
  now,
);
assert.equal(
  statementLines.bankTransactions.filter((transaction) =>
    /前期帳單|一銀自動扣款/.test(transaction.description),
  ).length,
  0,
);
assert.equal(
  statementLines.bankTransactions.filter((transaction) =>
    transaction.description.includes("微笑單車"),
  ).length,
  1,
);

console.log("First Bank Web connector self-check passed.");
