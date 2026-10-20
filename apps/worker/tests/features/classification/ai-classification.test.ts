import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import type { Env } from "../../../src/platform/env";
import { getBankRange } from "../../../src/features/bank/service";
import {
  getAiClassificationStatus,
  kickAiClassification,
  processAiClassification,
  setAiClassificationEnabled,
  startAiClassificationBackfill,
} from "../../../src/features/classification/ai-service";

type ClefRequest = {
  state: { 交易摘要?: string; 對應電子發票?: { 品項: string[] } };
  questions: { category: { criteria: Record<string, string> } };
};

const now = new Date("2026-10-18T02:00:00.000Z");

function clefAnswer(probabilities: Record<string, number>) {
  return { answers: { category: { type: "choice", probabilities } } };
}

describe("AI 自動分類（隔離 D1、假 Workers AI）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  const requests: ClefRequest[] = [];
  let answer: (request: ClefRequest) => unknown = () => ({});

  const env = () =>
    ({
      DB: db,
      AI: {
        run: async (_model: string, request: ClefRequest) => {
          requests.push(request);
          return answer(request);
        },
      },
      SYNC_QUEUE: { send: async () => undefined },
    }) as unknown as Env;

  async function runScan() {
    for (let step = 0; step < 20; step++) {
      const { status } = await processAiClassification(env(), now);
      if (status !== "continue") return status;
    }
    throw new Error("scan did not finish");
  }

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    const stamp = "2026-10-15T00:00:00Z";
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
           VALUES ('card-1', 'esun', 'card-1', 'credit', 'TWD', ?, ?)`,
        )
        .bind(stamp, stamp),
      ...[
        ["bistro", "2026-10-05", -500, "範例小館"],
        ["wallet", "2026-10-06", -120, "LINEPAY*範例商行"],
        ["unknown", "2026-08-10", -300, "XQZ-0001"],
        // Caught by the system convenience-store rule; never sent to AI.
        ["store", "2026-10-07", -60, "範例超市"],
        ["manual", "2026-10-08", -800, "範例工作室"],
      ].map(([id, day, amount, description]) =>
        db
          .prepare(
            `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, counterparty, created_at, updated_at)
             VALUES (?, 'esun', 'card-1', ?, ?, ?, 'TWD', ?, ?, ?, ?)`,
          )
          .bind(id, id, day, amount, description, description, stamp, stamp),
      ),
      db
        .prepare(
          `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
           VALUES ('override-manual', 'bank_transaction', 'manual', 'education', ?, ?)`,
        )
        .bind(stamp, stamp),
      db
        .prepare(
          `INSERT INTO invoices (id, connector_id, source_id, invoice_number, invoice_date, seller_name, amount, created_at, updated_at)
           VALUES ('invoice-1', 'einvoice', 'invoice-1', 'AB00000001', '2026-10-06', '範例商行', 120, ?, ?)`,
        )
        .bind(stamp, stamp),
      db
        .prepare(
          `INSERT INTO invoice_line_items (id, invoice_id, connector_id, invoice_source_id, source_id, line_number, description, amount, created_at, updated_at)
           VALUES ('item-1', 'invoice-1', 'einvoice', 'invoice-1', '1', 1, '雞腿便當', 120, ?, ?)`,
        )
        .bind(stamp, stamp),
    ]);
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("啟用時不掃描，同步後只分類啟用後才寫入的活動", async () => {
    answer = () => clefAnswer({ food: 0.8, shopping: 0.2 });
    await setAiClassificationEnabled(env(), true, now);
    await kickAiClassification(env(), now);
    expect((await getAiClassificationStatus(db)).scanning).toBe(false);

    const syncedAt = "2026-10-18T03:00:00.000Z";
    await db
      .prepare(
        `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, counterparty, created_at, updated_at)
         VALUES ('new-bakery', 'esun', 'card-1', 'new-bakery', '2026-10-17', -90, 'TWD', '範例烘焙坊', '範例烘焙坊', ?, ?)`,
      )
      .bind(syncedAt, syncedAt)
      .run();
    // Visible pending rows are classified before posting; a pending row
    // already linked to its posted row stays hidden and is not sent.
    await db
      .prepare(
        `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, status, authorized_at, amount, currency, description, counterparty, matched_transaction_id, created_at, updated_at)
         VALUES ('pending-donut', 'esun', 'card-1', 'pending-donut', 'pending', '2026-10-17T17:13:21+08:00', -60, 'TWD', '範例甜甜圈', '範例甜甜圈', NULL, ?, ?),
                ('pending-linked', 'esun', 'card-1', 'pending-linked', 'pending', '2026-10-17T09:00:00+08:00', -90, 'TWD', 'LPEPI*None', 'LPEPI*None', 'new-bakery', ?, ?)`,
      )
      .bind(syncedAt, syncedAt, syncedAt, syncedAt)
      .run();
    await kickAiClassification(env(), new Date(syncedAt));
    expect(await runScan()).toBe("done");

    // Older unclassified records in the same months wait for a backfill.
    expect(requests.map((request) => request.state.交易摘要).sort()).toEqual([
      "範例烘焙坊",
      "範例甜甜圈",
    ]);
    requests.length = 0;
  });

  it("回補只送出規則無法判斷的活動，附上配對發票品項，低機率維持未分類", async () => {
    answer = (request) =>
      request.state.交易摘要 === "XQZ-0001"
        ? clefAnswer({ shopping: 0.3, food: 0.25, fee: 0.25, transport: 0.2 })
        : clefAnswer({ food: 0.8, shopping: 0.2 });
    await startAiClassificationBackfill(env(), now);
    expect(await runScan()).toBe("done");

    expect(requests.map((request) => request.state.交易摘要).sort()).toEqual([
      "LINEPAY*範例商行",
      "XQZ-0001",
      "範例小館",
    ]);
    const walletRequest = requests.find(
      (request) => request.state.交易摘要 === "LINEPAY*範例商行",
    );
    expect(walletRequest?.state.對應電子發票?.品項).toEqual(["雞腿便當"]);
    // An expense is never offered income-only categories.
    expect(walletRequest?.questions.category.criteria).not.toHaveProperty(
      "salary",
    );

    const { transactions } = await getBankRange(db, {
      from: "2026-08-01",
      to: "2026-11-01",
    });
    const sourceOf = Object.fromEntries(
      transactions.map((transaction) => [
        transaction.id,
        [
          transaction.classification?.categoryId,
          transaction.classification?.source,
        ],
      ]),
    );
    expect(sourceOf).toEqual({
      bistro: ["food", "ai"],
      wallet: ["food", "ai"],
      unknown: ["other", "fallback"],
      store: ["shopping", "system_rule"],
      manual: ["education", "override"],
      "new-bakery": ["food", "ai"],
      "pending-donut": ["food", "ai"],
    });
    expect((await getAiClassificationStatus(db)).backfill).toMatchObject({
      status: "completed",
      classifiedCount: 2,
      undeterminedCount: 1,
    });

    // Unchanged input is not sent again.
    requests.length = 0;
    await startAiClassificationBackfill(env(), now);
    await runScan();
    expect(requests).toHaveLength(0);
  });

  it("近期掃描進行中開始回補時，舊掃描不寫入結果也不覆寫回補進度", async () => {
    const syncedAt = "2026-10-18T04:00:00.000Z";
    await db
      .prepare(
        `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, counterparty, created_at, updated_at)
         VALUES ('race-new', 'esun', 'card-1', 'race-new', '2026-10-18', -70, 'TWD', '範例小舖', '範例小舖', ?, ?)`,
      )
      .bind(syncedAt, syncedAt)
      .run();
    await kickAiClassification(env(), new Date(syncedAt));
    let backfillStarted = false;
    answer = async () => {
      // The user starts a backfill while the recent scan waits on Workers AI.
      if (!backfillStarted) {
        backfillStarted = true;
        await startAiClassificationBackfill(env(), now);
      }
      return clefAnswer({ food: 0.8, shopping: 0.2 });
    };

    expect(await processAiClassification(env(), now)).toEqual({
      status: "done",
    });
    const settings = await db
      .prepare(
        "SELECT scan_mode, scan_month, backfill_status FROM ai_classification_settings",
      )
      .first();
    expect(settings).toEqual({
      scan_mode: "backfill",
      scan_month: "2026-10",
      backfill_status: "running",
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM ai_classifications WHERE transaction_id = 'race-new'",
        )
        .first("count"),
    ).toBe(0);

    expect(await runScan()).toBe("done");
    expect((await getAiClassificationStatus(db)).backfill.status).toBe(
      "completed",
    );
    expect(
      await db
        .prepare(
          "SELECT category_id FROM ai_classifications WHERE transaction_id = 'race-new'",
        )
        .first("category_id"),
    ).toBe("food");
  });

  it("Workers AI 每日免費額度用完時暫停到 UTC 隔日，不寫入結果", async () => {
    await db.prepare("DELETE FROM ai_classifications").run();
    answer = () => {
      throw Object.assign(new Error("AiError: 3036"), { internalCode: 3036 });
    };
    await startAiClassificationBackfill(env(), now);

    expect(await processAiClassification(env(), now)).toEqual({
      status: "paused",
    });
    const status = await getAiClassificationStatus(db);
    expect(status.pausedUntil).toBe("2026-10-19T00:00:00.000Z");
    expect(status.backfill.status).toBe("running");
    expect(status.classifiedCount + status.undeterminedCount).toBe(0);
  });
});
