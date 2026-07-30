import assert from "node:assert/strict";
import { parseCtbcConfig, parseCtbcData } from "../../src/ctbc";

assert.deepEqual(
  parseCtbcConfig({
    userId: "A123456789",
    account: "demo-user",
    password: "demo-password",
    lookbackMonths: "2",
  }),
  {
    userId: "A123456789",
    account: "demo-user",
    password: "demo-password",
    lookbackMonths: 2,
  },
);
assert.throws(() => parseCtbcConfig({ lookbackMonths: 7 }));

const payloads = {
  depositOverview: {
    rsData: {
      twdAcctSummaryResponse: {
        demDepBalSummaryResponse: {
          infoList: [
            {
              accountId: "123456789012",
              balance: "12,345",
              availableBalance: "12,000",
              acctType: "活期儲蓄存款",
              accountNickName: "日常帳戶",
              actDigSvType: "SAVING",
            },
          ],
        },
      },
    },
  },
  depositTransactions: {
    rsData: {
      detailList: [
        {
          sourceAccountId: "123456789012",
          acctId: "987654321000",
          trnDtFull: "2026/07/20",
          memo1: "薪資入帳",
          crAmt: "25,000",
          dbAmt: "0",
          balanceAmt: "37,345",
          defaultSeq: "001",
        },
        {
          sourceAccountId: "123456789012",
          acctId: "987654321001",
          trnDtFull: "2026/07/21",
          memo1: "ATM 提款",
          crAmt: "0",
          dbAmt: "1,000",
          balanceAmt: "36,345",
          defaultSeq: "002",
        },
      ],
    },
  },
  creditCards: {
    rsData: {
      cardDataList: [
        {
          cardNo: "4111111111113108",
          cardNoSuffixFour: "3108",
          positiveOrAttached: "正卡",
          cardName: "測試信用卡",
        },
      ],
      curDataList: [{ curName: "新臺幣", curCode: "TWD" }],
      billData: {
        TWD: {
          "202607": {
            summary: {
              currPmtAmt: "8,000",
              minPmtAmt: "800",
              pmtExpDt: "2026/08/05",
              billDt: "2026/07/20",
              prevBal: "10,000",
              billAmt: "10,000",
              pmtAmt: "2,000",
              adjust: "0",
            },
            bills: [
              {
                purchaseDt: "2026/07/08",
                postingDt: "2026/07/10",
                merchantChiName: "測試商店",
                occCurCode: "TWD",
                authCode: "AUTH-CARD-001",
                foreignAmt: "350",
                clearingDt: "2026/07/10",
                purchaseCountry: "TW",
                cardNo: "4111111111113108",
                fullCardNo: "4111111111113108",
                acwRefNbr: "ACW-REF-001",
                merchAcct: "MERCHANT-ACCOUNT",
                ntAmt: "350",
                txCode: "SALE",
                sorting: "0001",
              },
              {
                purchaseDt: "2026/07/09",
                postingDt: "2026/07/11",
                merchantChiName: "網購退貨退款",
                occCurCode: "TWD",
                foreignAmt: "120",
                clearingDt: "2026/07/11",
                purchaseCountry: "TW",
                cardNo: "4111111111113108",
                ntAmt: "120",
                sorting: "0002",
              },
              {
                purchaseDt: "2026/07/12",
                postingDt: "2026/07/14",
                merchantChiName: "已入帳商店",
                occCurCode: "TWD",
                foreignAmt: "500",
                clearingDt: "2026/07/14",
                purchaseCountry: "TW",
                cardNo: "4111111111113108",
                ntAmt: "500",
                sorting: "0003",
              },
            ],
          },
        },
      },
    },
  },
  realtime: {
    rsData: {
      allItems: [
        {
          txnCountry: "TW",
          origCurCode: "TWD",
          authCode: "AUTH001",
          merchName: "測試商店",
          txnType: "消費",
          cardNo: "4111111111113108",
          txnDateTime: "2026/07/08 12:00:00",
          merchId: "MERCHANT-1",
          isDoubleCoinCard: false,
          mccCode: "5411",
          cardNoSuffixFour: "3108",
          acntholderId: "A123456789",
          txnDate: "20260708",
          txnAmt: "350",
          txnDateMMDD: "0708",
        },
        {
          txnCountry: "TW",
          origCurCode: "TWD",
          authCode: "AUTH002",
          merchName: "未入帳商店",
          txnType: "消費",
          cardNo: "4111111111113108",
          txnDate: "20260712",
          txnAmt: "500",
          cardNoSuffixFour: "3108",
        },
      ],
      totalRow: { ignored: true },
      noMore: true,
    },
  },
};

const result = parseCtbcData(payloads, 2, new Date("2026-07-29T00:00:00.000Z"));

assert.equal(result.bankAccounts.length, 2);
assert.equal(result.bankBalanceSnapshots.length, 2);
assert.equal(result.bankTransactions.length, 6);
assert.equal(result.creditCardBills.length, 1);
assert.equal(result.bankTransactions[0]?.amount, 25000);
assert.equal(result.bankTransactions[1]?.amount, -1000);
assert.equal(result.bankTransactions[2]?.amount, -350);
assert.equal(result.bankTransactions[3]?.amount, 120);
assert.equal(result.bankTransactions[4]?.amount, -500);
assert.equal(result.bankTransactions[4]?.status, "posted");
assert.equal(result.bankTransactions[5]?.amount, -500);
assert.equal(result.bankTransactions[5]?.status, "pending");
assert.notEqual(
  result.bankTransactions[4]?.sourceId,
  result.bankTransactions[5]?.sourceId,
);
assert.equal(result.bankBalanceSnapshots[1]?.balance, -8000);
assert.equal(result.bankBalanceSnapshots[1]?.statementBalance, 10000);
assert.equal(result.creditCardBills[0]?.minimumPayment, 800);

const repeated = parseCtbcData(
  payloads,
  2,
  new Date("2026-07-29T00:00:00.000Z"),
);
assert.deepEqual(
  repeated.bankTransactions.map((transaction) => transaction.sourceId),
  result.bankTransactions.map((transaction) => transaction.sourceId),
);

const serialized = JSON.stringify(result);
assert.doesNotMatch(
  serialized,
  /123456789012|987654321000|987654321001|4111111111113108|A123456789|AUTH-CARD-001|AUTH001|ACW-REF-001|MERCHANT-ACCOUNT|MERCHANT-1/,
);
assert.match(serialized, /3108/);

console.log("CTBC connector self-check passed.");
