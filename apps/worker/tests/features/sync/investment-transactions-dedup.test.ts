import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  listInvestmentTransactions,
  listInvestmentTransactionsInRange,
} from "../../../src/features/investments/repository";
import { findActivitySearchDays } from "../../../src/features/activity/search-repository";
import { investmentTransactionRecord } from "../../../src/features/sync/record-mapper";
import { persistStagedSyncWrite } from "../../../src/features/sync/persistence";

const NOW = "2026-11-07T02:00:00.000Z";

type TradeInput = {
  connectorId: "sinotrade" | "tdcc";
  sourceId: string;
  tradeDate: string;
  code: string;
  symbol?: string;
  quantity?: number;
  brokerNo?: string | null;
  brokerAccount?: string | null;
  currency?: string;
};

async function write(db: D1Database, ...inputs: TradeInput[]) {
  await persistStagedSyncWrite(db, {
    records: inputs.map((input) =>
      investmentTransactionRecord(
        input.connectorId,
        {
          accountId: "fixture-account",
          sourceId: input.sourceId,
          brokerNo:
            input.brokerNo === null ? undefined : (input.brokerNo ?? "9999"),
          brokerAccount:
            input.brokerAccount === null
              ? undefined
              : (input.brokerAccount ?? "0000001"),
          symbol: input.symbol ?? "0050",
          tradeDate: input.tradeDate,
          transactionCode: input.code,
          quantity: input.quantity ?? 68,
          price: input.connectorId === "tdcc" ? 1 : 100,
          currency: input.currency ?? "TWD",
          raw: { fixture: true },
        },
        NOW,
      ),
    ),
  });
}

const sourceIds = async (db: D1Database) =>
  (await listInvestmentTransactions(db, 50)).map((row) => row.sourceId).sort();

describe("投資交易紀錄跨來源去重（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM investment_transactions"),
      db.prepare("DELETE FROM sync_write_staging"),
    ]);
  });

  it("集保買賣與永豐同一筆成交只顯示永豐，民國年與西元日期格式都能對上", async () => {
    await write(
      db,
      {
        connectorId: "sinotrade",
        sourceId: "s-buy",
        tradeDate: "2023-01-16",
        code: "B",
      },
      {
        connectorId: "sinotrade",
        sourceId: "s-sell",
        tradeDate: "2023-06-13",
        code: "S",
        symbol: "0051",
        quantity: 5000,
      },
      {
        connectorId: "sinotrade",
        sourceId: "s-new",
        tradeDate: "2026-11-04",
        code: "B",
        quantity: 200,
      },
      {
        connectorId: "tdcc",
        sourceId: "t-buy",
        tradeDate: "0112-01-16T00:00:00.000Z",
        code: "113",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-sell",
        tradeDate: "0112-06-13T00:00:00.000Z",
        code: "123",
        symbol: "0051",
        quantity: 5000,
      },
      {
        connectorId: "tdcc",
        sourceId: "t-new",
        tradeDate: "2026-11-04T00:00:00.000Z",
        code: "113",
        quantity: 200,
      },
    );
    expect(await sourceIds(db)).toEqual(["s-buy", "s-new", "s-sell"]);
    const range = { from: "2026-11-01", to: "2026-12-01" };
    expect(
      (await listInvestmentTransactionsInRange(db, range)).map(
        (row) => row.sourceId,
      ),
    ).toEqual(["s-new"]);
    expect(
      (await listInvestmentTransactionsInRange(db, range, ["2026-11-04"])).map(
        (row) => row.sourceId,
      ),
    ).toEqual(["s-new"]);
  });

  it("對不上或集保獨有的交易照常顯示：股數、日期、方向、標的、帳戶、幣別不同，以及分割轉入", async () => {
    await write(
      db,
      {
        connectorId: "sinotrade",
        sourceId: "s",
        tradeDate: "2026-11-04",
        code: "B",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-qty",
        tradeDate: "2026-11-04",
        code: "113",
        quantity: 69,
      },
      {
        connectorId: "tdcc",
        sourceId: "t-date",
        tradeDate: "2026-11-05",
        code: "113",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-side",
        tradeDate: "2026-11-04",
        code: "123",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-symbol",
        tradeDate: "2026-11-04",
        code: "113",
        symbol: "0051",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-account",
        tradeDate: "2026-11-04",
        code: "113",
        brokerAccount: "0000002",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-currency",
        tradeDate: "2026-11-04",
        code: "113",
        currency: "USD",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-split",
        tradeDate: "2026-11-04",
        code: "1F5",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-dup",
        tradeDate: "2026-11-04",
        code: "113",
      },
    );
    expect(await sourceIds(db)).toEqual([
      "s",
      "t-account",
      "t-currency",
      "t-date",
      "t-qty",
      "t-side",
      "t-split",
      "t-symbol",
    ]);
  });

  it("沒有永豐交易或券商帳戶未知時不猜測配對，集保完整保留", async () => {
    await write(
      db,
      {
        connectorId: "tdcc",
        sourceId: "t-only",
        tradeDate: "2026-11-04",
        code: "113",
      },
      {
        connectorId: "sinotrade",
        sourceId: "s-unknown",
        tradeDate: "2026-11-03",
        code: "B",
        brokerNo: null,
        brokerAccount: null,
      },
      {
        connectorId: "tdcc",
        sourceId: "t-unknown",
        tradeDate: "2026-11-03",
        code: "113",
        brokerNo: null,
        brokerAccount: null,
      },
    );
    expect(await sourceIds(db)).toEqual(["s-unknown", "t-only", "t-unknown"]);
  });

  it("活動搜尋不會因為被隱藏的集保重複列而命中該日", async () => {
    await write(
      db,
      {
        connectorId: "sinotrade",
        sourceId: "s",
        tradeDate: "2026-11-04",
        code: "B",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-dup",
        tradeDate: "2026-11-04",
        code: "113",
      },
      {
        connectorId: "tdcc",
        sourceId: "t-only",
        tradeDate: "2026-11-03",
        code: "113",
        quantity: 7,
      },
    );
    // 永豐的買賣別代碼是 B／S，只有集保列的代碼含 113。
    expect(await findActivitySearchDays(db, { q: "113" })).toEqual([
      "2026-11-03",
    ]);
  });
});
