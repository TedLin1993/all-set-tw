import { describe, expect, it } from "vitest";
import {
  parseMegabankData,
  type MegabankPayloads,
} from "../../../src/sources/megabank/protocol";

const NOW = new Date("2026-09-25T00:00:00Z");
const ACCOUNT_NO = "0000000000012345";

type DepositRow = {
  txDate: string;
  serialNo: string;
  seq: string;
  DRCR: "C" | "D";
  amount: string;
  paymentItem: string;
};

function payloads(rows: DepositRow[]): MegabankPayloads {
  return {
    deposits: {
      rsData: {
        depositInfoList: [
          { DRACT: ACCOUNT_NO, DRCUR: "TWD", AVLBA: "1,000", NAME: "活存" },
        ],
      },
    },
    depositTransactions: [
      {
        accountNo: ACCOUNT_NO,
        currency: "TWD",
        response: { rsData: { list: rows } },
      },
    ],
    cardOverview: { rsData: { creditCardBillInfoList: [] } },
    cardBills: {},
    cardHome: {},
    cardTransactions: {},
  };
}

const outgoing: DepositRow = {
  txDate: "2026-09-20",
  serialNo: "S1",
  seq: "1",
  DRCR: "D",
  amount: "250",
  paymentItem: "轉出",
};
const incoming: DepositRow = {
  txDate: "2026-09-21",
  serialNo: "S2",
  seq: "2",
  DRCR: "C",
  amount: "100",
  paymentItem: "入帳",
};

function sourceIds(rows: DepositRow[]) {
  return parseMegabankData(payloads(rows), NOW).bankTransactions.map(
    (row) => row.sourceId,
  );
}

describe("兆豐存款交易 sourceId", () => {
  it("serialNo／seq 是當天交易順序，變動時同一筆交易的 sourceId 不變", () => {
    const original = sourceIds([outgoing, incoming]);
    const shifted = sourceIds(
      [outgoing, incoming].map((row) => ({
        ...row,
        serialNo: `X${row.serialNo}`,
        seq: String(Number(row.seq) + 7),
      })),
    );
    expect(original).toHaveLength(2);
    expect(shifted).toEqual(original);
    for (const sourceId of original) {
      expect(sourceId).toMatch(/^megabank:deposit:tx:[^:]+:0$/);
    }
  });

  it("同日同額同摘要的多筆交易以 occurrence 區分", () => {
    const ids = sourceIds([
      outgoing,
      { ...outgoing, serialNo: "S9", seq: "9" },
    ]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/:0$/);
    expect(ids[1]).toMatch(/:1$/);
    expect(ids[0]!.replace(/:0$/, "")).toBe(ids[1]!.replace(/:1$/, ""));
  });

  it("日期、金額或摘要不同時 sourceId 不同", () => {
    const ids = sourceIds([
      outgoing,
      { ...outgoing, txDate: "2026-09-22" },
      { ...outgoing, amount: "251" },
      { ...outgoing, paymentItem: "轉帳" },
    ]);
    expect(new Set(ids).size).toBe(4);
  });
});
