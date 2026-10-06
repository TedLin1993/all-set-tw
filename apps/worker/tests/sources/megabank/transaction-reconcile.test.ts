import { describe, expect, it } from "vitest";
import {
  reconcileMegabankDepositSourceIds,
  type MegabankExistingDeposit,
  type MegabankIncomingDeposit,
} from "../../../src/sources/megabank/transaction-reconcile";

const ACCOUNT = "bank:megabank:2345:abc:TWD";
const P = "megabank:deposit:tx:";

function incoming(
  sourceId: string,
  overrides: Partial<MegabankIncomingDeposit> = {},
): MegabankIncomingDeposit {
  return {
    accountId: ACCOUNT,
    sourceId,
    postedDate: "2026-09-20",
    amount: -1000,
    description: "合成扣款",
    ...overrides,
  };
}

function existing(
  id: string,
  sourceId: string,
  overrides: Partial<MegabankExistingDeposit> = {},
): MegabankExistingDeposit {
  return {
    id,
    accountId: ACCOUNT,
    sourceId,
    postedDate: "2026-09-20",
    amount: -1000,
    description: "合成扣款",
    createdAt: "2026-09-20T06:53:00.000Z",
    ...overrides,
  };
}

describe("reconcileMegabankDepositSourceIds", () => {
  it("sourceId 已存在的交易原樣保留", () => {
    const result = reconcileMegabankDepositSourceIds(
      [incoming(`${P}new:0`)],
      [existing("a", `${P}new:0`)],
    );
    expect(result.remapped).toBe(0);
    expect(result.transactions[0]!.sourceId).toBe(`${P}new:0`);
  });

  it("新格式交易改用對應舊列的 sourceId", () => {
    const result = reconcileMegabankDepositSourceIds(
      [incoming(`${P}new:0`)],
      [existing("a", `${P}legacy:0`)],
    );
    expect(result.remapped).toBe(1);
    expect(result.transactions[0]!.sourceId).toBe(`${P}legacy:0`);
  });

  it("最舊的既有列優先被認領，另一筆維持未認領", () => {
    const result = reconcileMegabankDepositSourceIds(
      [incoming(`${P}new:0`)],
      [
        existing("newer", `${P}legacy-b:0`, {
          createdAt: "2026-09-20T06:55:00.000Z",
        }),
        existing("older", `${P}legacy-a:0`, {
          createdAt: "2026-09-20T06:53:00.000Z",
        }),
      ],
    );
    expect(result.transactions[0]!.sourceId).toBe(`${P}legacy-a:0`);
    expect(result.remapped).toBe(1);
  });

  it("同日同額同摘要的多筆依 created_at、id 一對一認領，多出的維持新 sourceId", () => {
    const result = reconcileMegabankDepositSourceIds(
      [incoming(`${P}new:0`), incoming(`${P}new:1`), incoming(`${P}new:2`)],
      [existing("b", `${P}legacy-b:0`), existing("a", `${P}legacy-a:0`)],
    );
    expect(result.transactions.map((row) => row.sourceId)).toEqual([
      `${P}legacy-a:0`,
      `${P}legacy-b:0`,
      `${P}new:2`,
    ]);
    expect(result.remapped).toBe(2);
  });

  it("已被完全相同 sourceId 對上的列不會再被認領", () => {
    const result = reconcileMegabankDepositSourceIds(
      [incoming(`${P}new:0`), incoming(`${P}new:1`)],
      [existing("a", `${P}new:0`), existing("b", `${P}legacy:0`)],
    );
    expect(result.transactions.map((row) => row.sourceId)).toEqual([
      `${P}new:0`,
      `${P}legacy:0`,
    ]);
  });

  it("金額、摘要、日期或帳戶不同時不認領", () => {
    const base = [incoming(`${P}new:0`)];
    for (const other of [
      existing("a", `${P}l:0`, { amount: -1001 }),
      existing("a", `${P}l:0`, { description: "合成轉出" }),
      existing("a", `${P}l:0`, { postedDate: "2026-09-21" }),
      existing("a", `${P}l:0`, { accountId: "bank:megabank:9999:zzz:TWD" }),
    ]) {
      const result = reconcileMegabankDepositSourceIds(base, [other]);
      expect(result.remapped).toBe(0);
      expect(result.transactions[0]!.sourceId).toBe(`${P}new:0`);
    }
  });

  it("非存款格式的 sourceId 不處理", () => {
    const card = incoming("megabank:credit:tx:xyz");
    const result = reconcileMegabankDepositSourceIds(
      [card],
      [existing("a", `${P}legacy:0`)],
    );
    expect(result.transactions[0]).toEqual(card);
    expect(result.remapped).toBe(0);
  });

  it("結果不受輸入與既有列順序影響，也不修改輸入", () => {
    const rows = [incoming(`${P}new:0`), incoming(`${P}new:1`)];
    const olds = [
      existing("a", `${P}legacy-a:0`),
      existing("b", `${P}legacy-b:0`),
    ];
    const first = reconcileMegabankDepositSourceIds(rows, olds);
    const second = reconcileMegabankDepositSourceIds(
      [...rows].reverse(),
      [...olds].reverse(),
    );
    expect(second.transactions.reverse()).toEqual(first.transactions);
    expect(first.transactions.map((row) => row.sourceId)).toEqual([
      `${P}legacy-a:0`,
      `${P}legacy-b:0`,
    ]);
    expect(rows[0]!.sourceId).toBe(`${P}new:0`);
  });
});
