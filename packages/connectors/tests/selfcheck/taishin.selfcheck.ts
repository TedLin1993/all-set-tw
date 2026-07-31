import assert from "node:assert/strict";
import { parseTaishinCreditCardData } from "../../src/taishin";

const summary = {
  value: {
    "001": {
      "OUT-AVAIL-CREDIT": "168,500",
      "OUT-STMT-BALANCE": "10,060",
      "OUT-CRLIMIT-PERM": "200,000",
    },
  },
  error: "",
};

function bill(period: string) {
  const transactionDate = `${period}/08`;
  const postedDate = `${period}/10`;
  return {
    value: {
      showAccoutnYM: period,
      showStmtDate: `${period}/20`,
      showDueDate: "2026/08/05",
      showCbalance: "10,060",
      showCdue: "10,060",
      showMinPay: "1,129",
      showPayment: "0",
      newAcctDetailList: [
        {
          order: "測試卡 (卡號末四碼:3108)",
          detail: [
            {
              showOutDesc: "測試商店",
              showOutCurrency: "新臺幣",
              showOutPostDate: postedDate,
              showOutTXNDate: transactionDate,
              showOutAmt: "350",
              showOutCountry: "TW",
            },
          ],
        },
      ],
    },
    error: null,
  };
}

const result = parseTaishinCreditCardData(
  {
    summary,
    bills: [
      bill("2026/07"),
      bill("2026/06"),
      bill("2026/05"),
      bill("2026/04"),
      bill("2026/03"),
      bill("2026/02"),
    ],
    realtime: {
      value: {
        fmtRealTxListMap: [
          {
            cardname: "測試卡 (卡號末四碼:3108)",
            txlist: [
              ["2026/07/08", "12:30:00", "測試商店", "350", "TW", "成功", ""],
              [
                "2026/07/21",
                "19:38:23",
                "待入帳商店",
                "1,404",
                "GB",
                "成功",
                "",
              ],
            ],
          },
        ],
      },
      error: null,
    },
  },
  new Date("2026-07-23T00:00:00.000Z"),
);

assert.equal(result.bankAccounts.length, 1);
assert.equal(result.bankAccounts[0]?.creditLimit, 200000);
assert.equal(result.bankBalanceSnapshots[0]?.statementBalance, 10060);
assert.equal(result.creditCardBills.length, 3);
assert.equal(
  result.bankTransactions.filter(({ status }) => status === "posted").length,
  6,
);
assert.equal(
  result.bankTransactions.find(({ status }) => status === "pending")?.amount,
  -1404,
);
assert.doesNotMatch(JSON.stringify(result), /A123456789|4111111111113108/);

console.log("Taishin connector self-check passed.");
