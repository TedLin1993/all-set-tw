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
  return persistStagedSyncWrite(db, {
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
      db.prepare("DELETE FROM scheduled_sync_batches"),
      db.prepare("DELETE FROM sync_jobs"),
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

  describe("同步報告", () => {
    const trade = (
      connectorId: "sinotrade" | "tdcc",
      sourceId: string,
      code: string,
    ): TradeInput => ({
      connectorId,
      sourceId,
      tradeDate:
        connectorId === "tdcc" ? "2026-11-13T00:00:00.000Z" : "2026-11-13",
      code,
    });
    /** 以持有 lock 的 activity run 寫入，該次同步的新增才會列進報告。 */
    async function reportedWrite(...inputs: TradeInput[]) {
      const connectorId = inputs[0]!.connectorId;
      await db.batch([
        db
          .prepare(
            "INSERT OR IGNORE INTO scheduled_sync_batches (id, created_at) VALUES ('batch', ?)",
          )
          .bind(NOW),
        db
          .prepare(
            "INSERT INTO sync_activity_runs (id, batch_id, connector_id, created_at, published) VALUES (?1, 'batch', ?1, ?2, 1)",
          )
          .bind(connectorId, NOW),
        db
          .prepare(
            `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, locked_by, created_at, updated_at)
             VALUES (?1, ?1, 'default', 1440, ?2, ?1, ?2, ?2)`,
          )
          .bind(connectorId, NOW),
      ]);
      const newRecords = await write(db, ...inputs);
      // 同步完成後的報告狀態：筆數已記錄，展示快照已產生。
      await db.batch([
        db
          .prepare(
            `INSERT INTO scheduled_sync_batch_results (batch_id, job_id, connector_id, status, completed_at, new_investment_transactions)
             VALUES ('batch', ?1, ?1, 'success', ?2, ?3)`,
          )
          .bind(connectorId, NOW, newRecords.investmentTransactions),
        db
          .prepare(
            `INSERT INTO sync_activity_details (run_id, activity_id, snapshot)
             SELECT run_id, 'investment:' || record_id, snapshot FROM sync_activity_changes WHERE run_id = ?`,
          )
          .bind(connectorId),
        db.prepare("UPDATE sync_jobs SET locked_by = NULL"),
      ]);
      return newRecords.investmentTransactions;
    }
    const reported = async (table: string) =>
      (
        await db
          .prepare(
            `SELECT run_id || ':' || json_extract(snapshot, '$.transactionCode') AS entry
             FROM ${table} ORDER BY 1`,
          )
          .all<{ entry: string }>()
      ).results.map((row) => row.entry);
    const counts = async () =>
      (
        await db
          .prepare(
            `SELECT connector_id || ':' || new_investment_transactions AS entry
             FROM scheduled_sync_batch_results ORDER BY 1`,
          )
          .all<{ entry: string }>()
      ).results.map((row) => row.entry);

    it("永豐已列進報告的成交，集保同步時不再列為新增；集保獨有的交易照常列出", async () => {
      expect(await reportedWrite(trade("sinotrade", "s", "B"))).toBe(1);
      expect(
        await reportedWrite(
          trade("tdcc", "t-dup", "113"),
          trade("tdcc", "t-split", "1F5"),
        ),
      ).toBe(1);
      expect(await reported("sync_activity_changes")).toEqual([
        "sinotrade:B",
        "tdcc:1F5",
      ]);
    });

    it("集保先同步的成交，永豐列進報告後從集保的報告移除並扣回新增筆數", async () => {
      expect(
        await reportedWrite(
          trade("tdcc", "t-first", "113"),
          trade("tdcc", "t-split", "1F5"),
        ),
      ).toBe(2);
      expect(await reportedWrite(trade("sinotrade", "s", "B"))).toBe(1);
      const expected = ["sinotrade:B", "tdcc:1F5"];
      expect(await reported("sync_activity_changes")).toEqual(expected);
      expect(await reported("sync_activity_details")).toEqual(expected);
      expect(await counts()).toEqual(["sinotrade:1", "tdcc:1"]);
    });

    it("永豐未列進報告（例如手動同步或首次回補）時，集保那筆是唯一紀錄，前後都保留", async () => {
      await write(db, { ...trade("sinotrade", "s-old", "B"), quantity: 5 });
      expect(
        await reportedWrite({ ...trade("tdcc", "t-old", "113"), quantity: 5 }),
      ).toBe(1);
      await write(db, trade("sinotrade", "s-new", "B"));
      const expected = ["tdcc:113"];
      expect(await reported("sync_activity_changes")).toEqual(expected);
      expect(await reported("sync_activity_details")).toEqual(expected);
      expect(await counts()).toEqual(["tdcc:1"]);
    });
  });
});
