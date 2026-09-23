import assert from "node:assert/strict";
import { parseKgibankConfig, parseKgibankData } from "../../src/kgibank";

assert.deepEqual(
  parseKgibankConfig({
    userId: "A123456789",
    account: "user01",
    password: "password",
    captcha: "123456",
  }),
  {
    userId: "A123456789",
    account: "user01",
    password: "password",
    captcha: "123456",
  },
);
assert.throws(() => parseKgibankConfig({ captcha: "12ab" }));

const data = parseKgibankData(
  {
    accountsResponse: {
      items: [
        {
          acctNo: "00012345678901",
          acctBal: 29268,
          availBal: 29268,
          acctTypeName: "活期儲蓄存款",
          acctNickName: "",
        },
      ],
    },
    transactionResponses: [
      {
        accountNo: "00012345678901",
        response: {
          items: [
            {
              txnDateTime: "2026-09-23T04:28:04+08:00",
              txnTypeName: "轉帳",
              txnAmt: -10000,
              effectDateTime: "2026-09-23T00:00:00+08:00",
              acctBal: 29268,
              desc: "定期定額",
            },
          ],
        },
      },
    ],
  },
  new Date("2026-09-23T03:00:00.000Z"),
);

assert.equal(data.bankAccounts[0]?.sourceId, "bank:kgibank:00012345678901:TWD");
assert.equal(data.bankBalanceSnapshots[0]?.balance, 29268);
assert.equal(data.bankTransactions[0]?.amount, -10000);
assert.equal(data.bankTransactions[0]?.postedDate, "2026-09-23");
assert.equal(
  data.bankTransactions[0]?.authorizedAt,
  "2026-09-23T04:28:04+08:00",
);
const rawPayloads = JSON.stringify([
  ...data.bankAccounts.map((account) => account.raw),
  ...data.bankBalanceSnapshots.map((snapshot) => snapshot.raw),
  ...data.bankTransactions.map((transaction) => transaction.raw),
]);
assert.equal(rawPayloads.includes("00012345678901"), false);

console.log("kgibank selfcheck passed");
