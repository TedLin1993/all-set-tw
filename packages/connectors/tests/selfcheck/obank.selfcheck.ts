import assert from "node:assert/strict";
import { parseObankConfig, parseObankData } from "../../src/obank";
import { BANK_SYNC_MONTHS } from "../../src/sync-window";

assert.deepEqual(
  parseObankConfig({
    userId: "A123456789",
    account: "demo-user",
    password: "demo-password",
  }),
  {
    userId: "A123456789",
    account: "demo-user",
    password: "demo-password",
  },
);
assert.equal(BANK_SYNC_MONTHS, 3);

const payloads = {
  demandDeposits: {
    rsData: {
      userAccounts: [
        {
          accountNo: "12345678901234",
          accountItems: [
            {
              accountItemNo: "demand-item-1",
              acctNo: "12345678901234",
              curr: "TWD",
              displayActBalNoCurr: "12,345",
              displayWorkBalNoCurr: "12,000",
              aliasName: "日常帳戶",
            },
          ],
        },
      ],
    },
  },
  timeDeposits: {
    rsData: {
      repeats: [
        {
          tdDetail: {
            accountItemNo: "time-item-1",
            tdAccountNumber: "98765432109876",
            currency: "USD",
            workingBalance: "1,000",
            displayProductType: "美元定存",
          },
        },
      ],
    },
  },
  transactionResponses: [
    {
      rsData: {
        subAccountItemNo: "demand-item-1",
        curry: "TWD",
        despositTxnDetails: [
          {
            txnDate: "115/08/07",
            displayTxnAmount: "80",
            displayMemo: "ATM 提款",
            debitCredit: "D",
            txnSeqNo: "001",
          },
        ],
      },
    },
  ],
};

const result = parseObankData(payloads, new Date("2026-08-08T00:00:00.000Z"));
assert.equal(result.bankAccounts.length, 2);
assert.equal(result.bankAccounts[1]?.accountType, "time_deposit");
assert.equal(result.bankBalanceSnapshots[0]?.balance, 12345);
assert.equal(result.bankTransactions[0]?.amount, -80);
assert.equal(result.bankTransactions[0]?.postedDate, "2026-08-07");

const repeated = parseObankData(payloads, new Date("2026-08-08T00:00:00.000Z"));
assert.deepEqual(
  repeated.bankTransactions.map((transaction) => transaction.sourceId),
  result.bankTransactions.map((transaction) => transaction.sourceId),
);

const serialized = JSON.stringify(result);
assert.doesNotMatch(
  serialized,
  /12345678901234|98765432109876|demand-item-1|time-item-1/,
);
assert.match(serialized, /1234/);

console.log("O-Bank connector self-check passed.");
