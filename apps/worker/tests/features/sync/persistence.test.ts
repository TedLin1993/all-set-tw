import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  persistStagedSyncWrite,
  promoteStagedSyncWrite,
  stageSyncWriteRecords,
  type SyncWriteRecord,
} from "../../../src/features/sync/persistence";
import {
  connectorStateStatement,
  updateConnectorEncryptedConfigIfCurrent,
  linkCanonicalBankAccountsStatement,
} from "../../../src/features/sync/connector-repository";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
} from "../../../src/features/sync/record-mapper";
import { prepareTaishinAuthorizationWrite } from "../../../src/sources/taishin/authorizations";
import { prepareEsunAuthorizationWrite } from "../../../src/sources/esun/authorizations";
import { prepareSinopacAuthorizationWrite } from "../../../src/sources/sinopac/authorizations";
import { prepareCtbcAuthorizationWrite } from "../../../src/sources/ctbc/authorizations";
import { prepareCardAuthorizationWrite } from "../../../src/features/sync/card-authorization-write";
import { parseFirstbankData } from "../../../src/sources/firstbank/protocol";
import { parseHncbData } from "../../../src/sources/hncb/protocol";
import { parseMegabankData } from "../../../src/sources/megabank/protocol";
import {
  parseTaishinCreditCardData,
  type TaishinCreditCardData,
  type TaishinCreditCardPayloads,
} from "../../../src/sources/taishin/protocol";
import {
  fetchTaishinDeposits,
  type TaishinDepositData,
} from "../../../src/sources/taishin/deposit-protocol";
import {
  listBankAccounts,
  listBankTransactions,
} from "../../../src/features/bank/repository";
import { rebuildBankDepositHistory } from "../../../src/features/net-worth/service";
import {
  bankNow,
  bill as taishinBill,
  depositRequest,
  emptyRealtime,
  emptyUnbilled,
  realtime,
  unbilled,
} from "../../sources/taishin/fixtures/bank-data";

const taishinBase: TaishinCreditCardPayloads = {
  summary: { error: null, value: {} },
  bills: [],
  realtime: emptyRealtime,
  unbilled: emptyUnbilled,
};
function taishinRecords(data: TaishinCreditCardData | TaishinDepositData) {
  return [
    ...data.bankAccounts.map((row) => bankAccountRecord("taishin", row, now)),
    ...data.bankBalanceSnapshots.map((row) =>
      bankBalanceSnapshotRecord("taishin", row, now),
    ),
    ...data.bankTransactions.map((row) =>
      bankTransactionRecord("taishin", row, now),
    ),
  ];
}

const now = "2026-09-01T10:30:00+08:00";
const account: SyncWriteRecord = {
  entityType: "bank_account",
  recordKey: "sinopac:card",
  payload: {
    id: "sinopac:card",
    connector_id: "sinopac",
    source_id: "card",
    account_type: "credit",
    currency: "TWD",
    raw_payload: "{}",
    created_at: now,
    updated_at: now,
  },
};
function transaction(status: "pending" | "posted"): SyncWriteRecord {
  return {
    entityType: "bank_transaction",
    recordKey: "sinopac:purchase",
    payload: {
      id: "sinopac:purchase",
      connector_id: "sinopac",
      account_id: account.recordKey,
      source_id: "purchase",
      amount: -252,
      currency: "TWD",
      authorized_at: status === "pending" ? now : "2026-09-01",
      posted_date: status === "posted" ? "2026-09-03" : null,
      status,
      raw_payload: JSON.stringify({ status }),
      created_at: now,
      updated_at: now,
    },
  };
}

describe("同步資料完整性（隔離 D1）", () => {
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
      ...[
        "bank_transaction_preferences",
        "invoice_transaction_preferences",
        "classification_overrides",
        "invoices",
        "bank_balance_snapshots",
        "credit_card_bills",
        "bank_transactions",
        "bank_accounts",
        "sync_write_staging",
        "connector_settings",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
      db.prepare(
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('sinopac', 'sinopac', 'old-config', 'old-cursor', 't', 't')",
      ),
    ]);
  });

  async function taishinSettings() {
    await db
      .prepare(
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('taishin', 'taishin', 'config', 'old-cursor', 't', 't')",
      )
      .run();
  }
  async function writeTaishin(
    data: TaishinCreditCardData | TaishinDepositData,
  ) {
    const prepared = await prepareTaishinAuthorizationWrite(
      db,
      taishinRecords(data),
      "config",
    );
    return persistStagedSyncWrite(db, {
      records: prepared.records,
      settingsGuard: { connectorId: "taishin", encryptedConfig: "config" },
      afterPromoteStatements: [
        ...prepared.afterPromoteStatements,
        linkCanonicalBankAccountsStatement(db, {
          connectorId: "taishin",
          encryptedConfig: "config",
        }),
      ],
    });
  }

  it.each([
    ["店名縮寫", "DEMO SHOP", "DEMO SHOP TAIPEI", "DEMO SHOP TAIPEI"],
    [
      "公司名與分店名",
      "商業服務",
      "測試便利商店股份有限公司",
      "測試便利商店－示範分店A0000 TAIPEI",
    ],
    ["店名不明", "", "", "DEMO SHOP TAIPEI"],
  ])(
    "台新%s修復已保存的重複，授權消失及出帳後仍保留時間、分類、排除及發票關係",
    async (
      _scenario,
      identityDescription,
      pendingDescription,
      postedDescription,
    ) => {
      await taishinSettings();
      const authorization = structuredClone(realtime);
      authorization.value.fmtRealTxListMap[0].txlist[0][2] =
        identityDescription;
      authorization.value.fmtRealTxListMap[0].txlist[0][6] = pendingDescription;
      const unposted = structuredClone(unbilled);
      unposted.value.unpostedTx["001TWD"].data[0].txlist[0][2] =
        postedDescription;
      const statement = structuredClone(taishinBill);
      statement.value.newAcctDetailList[0].detail[0].showOutDesc =
        postedDescription;
      const pending = parseTaishinCreditCardData(
        { ...taishinBase, realtime: authorization },
        bankNow,
      );
      await writeTaishin(pending);
      const pendingId = taishinRecords(pending).find(
        (row) => row.entityType === "bank_transaction",
      )!.recordKey;
      await db.batch([
        db
          .prepare(
            "INSERT INTO bank_transaction_preferences VALUES (?, 1, 'created', 'updated')",
          )
          .bind(pendingId),
        db
          .prepare(
            "INSERT INTO classification_overrides VALUES ('taishin-category', 'bank_transaction', ?, 'shopping', 'created', 'updated')",
          )
          .bind(pendingId),
        db.prepare(
          "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES ('invoice', 'einvoice', 'invoice', '2026-10-05', 252, 't', 't')",
        ),
        db
          .prepare(
            "INSERT INTO invoice_transaction_preferences VALUES ('invoice', ?, 'linked', 'created', 'updated')",
          )
          .bind(pendingId),
      ]);
      const posted = parseTaishinCreditCardData(
        { ...taishinBase, unbilled: unposted },
        bankNow,
      );
      await persistStagedSyncWrite(db, { records: taishinRecords(posted) });
      expect(await listBankTransactions(db, 20)).toHaveLength(2);
      expect((await writeTaishin(posted)).bankTransactions).toBe(0);
      const postedId = taishinRecords(posted).find(
        (row) => row.entityType === "bank_transaction",
      )!.recordKey;
      for (const data of [
        posted,
        parseTaishinCreditCardData(
          { ...taishinBase, bills: [statement] },
          bankNow,
        ),
        pending,
      ])
        expect((await writeTaishin(data)).bankTransactions).toBe(0);
      const visible = await listBankTransactions(db, 20);
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({
        id: postedId,
        amount: -252,
        description: postedDescription,
        currency: "TWD",
        status: "posted",
        authorizedAt: "2026-10-05T09:15:30+08:00",
        postedDate: "2026-10-06",
        calculationPreference: 1,
      });
      expect(
        await db
          .prepare(
            "SELECT matched_transaction_id FROM bank_transactions WHERE id = ?",
          )
          .bind(pendingId)
          .first("matched_transaction_id"),
      ).toBe(postedId);
      expect(
        await db
          .prepare(
            "SELECT category_id FROM classification_overrides WHERE target_id = ?",
          )
          .bind(postedId)
          .first("category_id"),
      ).toBe("shopping");
      expect(
        await db
          .prepare(
            "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'invoice'",
          )
          .first("transaction_id"),
      ).toBe(postedId);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM bank_transactions")
          .first("n"),
      ).toBe(2);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );

  it.each([
    ["taishin", 3, 2],
    ["taishin", 2, 3],
    ["esun", 3, 2],
    ["esun", 2, 3],
    ["sinopac", 3, 2],
    ["sinopac", 2, 3],
    ["firstbank", 3, 2],
    ["firstbank", 2, 3],
    ["hncb", 3, 2],
    ["hncb", 2, 3],
    ["megabank", 3, 2],
    ["megabank", 2, 3],
  ] as const)(
    "%s 同日同額 %i 筆授權／%i 筆明細逐一配對，補齊及重送不改既有關係",
    async (connectorId, authorizationCount, detailCount) => {
      await db
        .prepare(
          "INSERT INTO connector_settings (id, connector_id, encrypted_config, created_at, updated_at) VALUES (?, ?, 'config', 't', 't') ON CONFLICT(connector_id) DO UPDATE SET encrypted_config = 'config'",
        )
        .bind(connectorId, connectorId)
        .run();
      const accountSourceId =
        connectorId === "taishin" || connectorId === "sinopac"
          ? `credit:${connectorId}:main`
          : `credit:${connectorId}:1234`;
      const cardAccount = bankAccountRecord(
        connectorId,
        {
          sourceId: accountSourceId,
          accountType: "credit",
          currency: "TWD",
        },
        now,
      );
      const records = (feed: "realtime" | "history") =>
        [1, 2, 3].map((index) =>
          bankTransactionRecord(
            connectorId,
            {
              accountId: accountSourceId,
              sourceId:
                connectorId === "taishin"
                  ? `taishin:card:tx:v2:TWD:2026-10-05:-252:1234:${feed}${index}:1`
                  : connectorId === "esun"
                    ? `2026-10-05T00:00:00.000Z:credit:esun:1234:${feed}${index}:252:TWD:1`
                    : connectorId === "sinopac"
                      ? `sinopac:card:tx:v2:TWD:2026-10-05:-252:1234:${feed === "realtime" ? index : index + 10}`
                      : `${connectorId}:card:tx:${feed}${index}`,
              authorizedAt:
                feed === "realtime"
                  ? `2026-10-05T09:15:0${index}+08:00`
                  : "2026-10-05",
              postedDate:
                feed === "history" && connectorId !== "esun"
                  ? "2026-10-06"
                  : undefined,
              amount: -252,
              currency: "TWD",
              description: `${feed}${index}`,
              status:
                feed === "realtime" || connectorId === "esun"
                  ? "pending"
                  : "posted",
              raw: { cardLast4: "1234", esunFeed: feed },
            },
            now,
          ),
        );
      const authorizations = records("realtime");
      const details = records("history");
      const write = async (records: SyncWriteRecord[]) => {
        const prepared =
          connectorId === "taishin"
            ? await prepareTaishinAuthorizationWrite(db, records, "config")
            : connectorId === "esun"
              ? await prepareEsunAuthorizationWrite(db, records)
              : connectorId === "sinopac"
                ? await prepareSinopacAuthorizationWrite(db, records, [])
                : await prepareCardAuthorizationWrite(
                    db,
                    connectorId,
                    records,
                    {
                      sourcePattern: `${connectorId}:card:tx:%`,
                      cardId: (row) =>
                        (JSON.parse(row.raw_payload) as { cardLast4?: string })
                          .cardLast4,
                      encryptedConfig: "config",
                    },
                  );
        return persistStagedSyncWrite(db, {
          ...prepared,
          settingsGuard: { connectorId, encryptedConfig: "config" },
        });
      };
      const links = async () =>
        (
          await db
            .prepare(
              "SELECT id, matched_transaction_id FROM bank_transactions WHERE connector_id = ? AND matched_transaction_id IS NOT NULL ORDER BY source_id",
            )
            .bind(connectorId)
            .all<{ id: string; matched_transaction_id: string }>()
        ).results;
      await write([
        cardAccount,
        ...authorizations.slice(0, authorizationCount).reverse(),
      ]);
      await db.batch([
        db
          .prepare(
            "INSERT INTO bank_transaction_preferences VALUES (?, 1, 't', 't')",
          )
          .bind(authorizations[0].recordKey),
        db
          .prepare(
            "INSERT INTO classification_overrides VALUES ('group-category', 'bank_transaction', ?, 'food', 't', 't')",
          )
          .bind(authorizations[0].recordKey),
        db.prepare(
          "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES ('group-invoice', 'einvoice', 'group-invoice', '2026-10-05', 252, 't', 't')",
        ),
        db
          .prepare(
            "INSERT INTO invoice_transaction_preferences VALUES ('group-invoice', ?, 'linked', 't', 't')",
          )
          .bind(authorizations[0].recordKey),
      ]);
      await write(details.slice(0, detailCount).reverse());
      const initialLinks = await links();
      expect(initialLinks).toEqual(
        authorizations
          .slice(0, Math.min(authorizationCount, detailCount))
          .map((record, index) => ({
            id: record.recordKey,
            matched_transaction_id: details[index].recordKey,
          })),
      );
      expect(await listBankTransactions(db, 20)).toHaveLength(3);
      expect(
        (await write(details.slice(0, detailCount))).bankTransactions,
      ).toBe(0);
      expect(await links()).toEqual(initialLinks);
      const remaining =
        authorizationCount > detailCount
          ? details.slice(detailCount)
          : authorizations.slice(authorizationCount);
      expect((await write(remaining)).bankTransactions).toBe(1);
      for (const records of [details, [...authorizations].reverse()]) {
        expect((await write(records)).bankTransactions).toBe(0);
      }
      expect(await links()).toEqual(
        authorizations.map((record, index) => ({
          id: record.recordKey,
          matched_transaction_id: details[index].recordKey,
        })),
      );
      const visible = await listBankTransactions(db, 20);
      expect(visible).toHaveLength(3);
      expect(visible.reduce((total, row) => total + row.amount, 0)).toBe(-756);
      expect(
        visible.find((row) => row.id === details[0].recordKey),
      ).toMatchObject({
        authorizedAt: "2026-10-05T09:15:01+08:00",
        calculationPreference: 1,
      });
      expect(
        await db
          .prepare(
            "SELECT category_id FROM classification_overrides WHERE target_id = ?",
          )
          .bind(details[0].recordKey)
          .first("category_id"),
      ).toBe("food");
      expect(
        await db
          .prepare(
            "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'group-invoice'",
          )
          .first("transaction_id"),
      ).toBe(details[0].recordKey);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );

  it.each(["firstbank", "hncb", "megabank"] as const)(
    "%s 解析後的兩筆同額消費入帳與重抓不遺失、不重複，晚到舊識別更新既有目標",
    async (connectorId) => {
      const date = new Date("2026-10-08T00:00:00Z");
      const parse = (status: "pending" | "posted", includePending = false) => {
        const tx = {
          CardNo: "99991234",
          TransDate: "2026/10/05",
          AcctAmount: "252",
          TransDetail: "合成商店",
        };
        if (connectorId === "firstbank")
          return parseFirstbankData(
            {
              ...(status === "pending"
                ? {
                    cardUnbilled: {
                      HEAD: { MSGID: "CMSQRY0008", RETURNCODE: "0000" },
                      CONTENT: { Records: [tx, tx] },
                    },
                  }
                : {
                    cardBill: {
                      HEAD: { MSGID: "CMSQRY0014", RETURNCODE: "0000" },
                      CONTENT: {
                        BillRecords: [
                          {
                            CardNo: "99991234",
                            BillingPeriod: "2026-10",
                            BillDate: "2026/10/07",
                            TotalAmount: "504",
                            Records: [
                              { ...tx, AcctDate: "2026/10/06" },
                              { ...tx, AcctDate: "2026/10/06" },
                            ],
                          },
                        ],
                      },
                    },
                  }),
            },
            date,
          );
        if (connectorId === "hncb") {
          const html = `<p>帳單年月：2026/10 信用額度：10000 ****1234</p><table>${[1, 2].map((index) => `<tr><td>${status === "pending" ? index : index + 6}</td><td>10/05</td><td>10/06</td><td>合成商店</td><td>TW</td><td>TWD</td><td>-</td><td>252</td></tr>`).join("")}</table>`;
          return parseHncbData(
            status === "pending"
              ? { unbilledHtml: html }
              : { billsHtml: [html] },
            date,
          );
        }
        const row = {
          cardNo: "99991234",
          purchaseDate: "2026-10-05",
          postDate: "2026-10-06",
          merchantChiName: "合成商店",
          sourceAmt: "252",
          sourceCurr: "TWD",
        };
        const pending = { ...row, acctMon: "999912" };
        const posted = { ...row, acctMon: "202610" };
        return parseMegabankData(
          {
            deposits: {},
            depositTransactions: [],
            cardOverview: {},
            cardBills: {},
            cardHome: {},
            cardTransactions: {
              rsData: {
                detailList:
                  status === "pending"
                    ? [pending, pending]
                    : includePending
                      ? [pending, pending, posted, posted]
                      : [posted, posted],
              },
            },
          },
          date,
        );
      };
      const write = async (data: ReturnType<typeof parse>) => {
        const records = [
          ...data.bankAccounts.map((row) =>
            bankAccountRecord(connectorId, row, now),
          ),
          ...data.bankTransactions.map((row) =>
            bankTransactionRecord(connectorId, row, now),
          ),
        ];
        const prepared = await prepareCardAuthorizationWrite(
          db,
          connectorId,
          records,
          {
            sourcePattern: `${connectorId}:card:tx:%`,
            cardId: (row) =>
              connectorId === "hncb"
                ? row.source_id.match(/^hncb:card:tx:v2:(\d{4}):/)?.[1]
                : connectorId === "firstbank"
                  ? row.account_id.match(/:credit:firstbank:(\d{4})$/)?.[1]
                  : (JSON.parse(row.raw_payload) as { cardLast4: string })
                      .cardLast4,
          },
        );
        await persistStagedSyncWrite(db, prepared);
      };
      expect(parse("pending").bankTransactions).toHaveLength(2);
      await write(parse("pending"));
      await write(parse("posted", true));
      const ids = (await listBankTransactions(db, 20))
        .map((row) => row.id)
        .sort();
      expect(ids).toHaveLength(2);
      for (const data of [parse("posted"), parse("pending"), parse("posted")])
        await write(data);
      const visible = await listBankTransactions(db, 20);
      expect(visible.map((row) => row.id).sort()).toEqual(ids);
      expect(visible.every((row) => row.status === "posted")).toBe(true);
      expect(visible.reduce((total, row) => total + row.amount, 0)).toBe(-504);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );

  it("玉山即時授權與未入帳明細接到入帳，跨來源店名不同仍保留單筆及所有使用者設定", async () => {
    const sourceId = "credit:esun:1234";
    const card = bankAccountRecord(
      "esun",
      { sourceId, accountType: "credit", currency: "TWD" },
      now,
    );
    const make = (
      feed: "realtime" | "history",
      name: string,
      status: "pending" | "posted",
    ) =>
      bankTransactionRecord(
        "esun",
        {
          accountId: sourceId,
          sourceId: `2026-10-05T00:00:00.000Z:${sourceId}:${name}:252:TWD:1`,
          authorizedAt:
            feed === "realtime" ? "2026-10-04T16:30:00Z" : "2026-10-05",
          postedDate: status === "posted" ? "2026-10-06" : undefined,
          status,
          amount: -252,
          currency: "TWD",
          description: name,
          raw: { esunFeed: feed },
        },
        now,
      );
    const pending = make("realtime", "付款通道", "pending"),
      history = make("history", "原店名", "pending"),
      posted = make("history", "正式分店", "posted");
    await persistStagedSyncWrite(db, { records: [card, pending] });
    await db.batch([
      db
        .prepare(
          "INSERT INTO bank_transaction_preferences VALUES (?, 1, 't', 't')",
        )
        .bind(pending.recordKey),
      db
        .prepare(
          "INSERT INTO classification_overrides VALUES ('esun-category', 'bank_transaction', ?, 'food', 't', 't')",
        )
        .bind(pending.recordKey),
      db.prepare(
        "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES ('esun-invoice', 'einvoice', 'esun-invoice', '2026-10-05', 252, 't', 't')",
      ),
      db
        .prepare(
          "INSERT INTO invoice_transaction_preferences VALUES ('esun-invoice', ?, 'linked', 't', 't')",
        )
        .bind(pending.recordKey),
    ]);
    const write = async (records: SyncWriteRecord[]) =>
      persistStagedSyncWrite(
        db,
        await prepareEsunAuthorizationWrite(db, records),
      );
    await write([history, posted]);
    for (const records of [
      [pending, history, posted],
      [
        {
          ...pending,
          payload: {
            ...pending.payload,
            status: "posted",
            posted_date: "2026-10-06",
          },
        },
      ],
      [posted],
    ])
      await write(records);
    expect(await listBankTransactions(db, 20)).toMatchObject([
      {
        id: posted.recordKey,
        status: "posted",
        amount: -252,
        authorizedAt: "2026-10-04T16:30:00Z",
        calculationPreference: 1,
      },
    ]);
    expect(
      await db
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_id = ?",
        )
        .bind(posted.recordKey)
        .first("category_id"),
    ).toBe("food");
    expect(
      await db
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'esun-invoice'",
        )
        .first("transaction_id"),
    ).toBe(posted.recordKey);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it.each(["授權碼優先", "無授權碼", "授權碼不同"])(
    "中信%s，保留原授權 ID，重送及新同額消費不重新分配既有配對",
    async (scenario) => {
      const sourceId = "credit:ctbc:main";
      const card = bankAccountRecord(
        "ctbc",
        { sourceId, accountType: "credit", currency: "TWD" },
        now,
      );
      const make = (
        name: string,
        status: "pending" | "posted",
        authorizationHash?: string,
      ) =>
        bankTransactionRecord(
          "ctbc",
          {
            accountId: sourceId,
            sourceId: `ctbc:card:tx:${name}:1`,
            authorizedAt:
              status === "pending" ? "2026-10-05T09:00:00+08:00" : "2026-10-05",
            postedDate: status === "posted" ? "2026-10-06" : undefined,
            status,
            amount: -252,
            currency: "TWD",
            description: name,
            raw: { cardLast4: "1234", authorizationHash },
          },
          now,
        );
      const a = make(
        "auth1",
        "pending",
        scenario === "授權碼不同" ? "A" : undefined,
      );
      const b = make(
        "auth2",
        "pending",
        scenario === "無授權碼" ? undefined : "B",
      );
      const p = make(
        "posted1",
        "posted",
        scenario === "無授權碼" ? undefined : "B",
      );
      const q = make(
        "posted2",
        "posted",
        scenario === "授權碼不同" ? "C" : undefined,
      );
      await persistStagedSyncWrite(db, { records: [card, a, b, p, q] });
      await db.batch([
        db
          .prepare(
            "INSERT INTO classification_overrides VALUES ('ctbc-category', 'bank_transaction', ?, 'food', 't', 't')",
          )
          .bind(p.recordKey),
        db
          .prepare(
            "INSERT INTO bank_transaction_preferences VALUES (?, 1, 't', 't')",
          )
          .bind(p.recordKey),
        db.prepare(
          "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES ('ctbc-invoice', 'einvoice', 'ctbc-invoice', '2026-10-05', 252, 't', 't')",
        ),
        db
          .prepare(
            "INSERT INTO invoice_transaction_preferences VALUES ('ctbc-invoice', ?, 'linked', 't', 't')",
          )
          .bind(p.recordKey),
      ]);
      const write = async (records: SyncWriteRecord[]) =>
        persistStagedSyncWrite(
          db,
          await prepareCtbcAuthorizationWrite(db, records),
        );
      await write([q, p]);
      const target = scenario === "無授權碼" ? a.recordKey : b.recordKey;
      expect(
        await db
          .prepare(
            "SELECT description, status FROM bank_transactions WHERE id = ?",
          )
          .bind(target)
          .first(),
      ).toEqual({ description: "posted1", status: "posted" });
      expect(
        await db
          .prepare(
            "SELECT category_id FROM classification_overrides WHERE target_id = ?",
          )
          .bind(target)
          .first("category_id"),
      ).toBe("food");
      expect(
        await db
          .prepare(
            "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'ctbc-invoice'",
          )
          .first("transaction_id"),
      ).toBe(target);
      expect(await listBankTransactions(db, 20)).toHaveLength(
        scenario === "授權碼不同" ? 3 : 2,
      );
      for (const records of [
        [p, q],
        [a, b],
        [p, q],
      ])
        await write(records);
      expect(await listBankTransactions(db, 20)).toHaveLength(
        scenario === "授權碼不同" ? 3 : 2,
      );
      await write([make("new-purchase", "posted")]);
      expect(await listBankTransactions(db, 20)).toHaveLength(3);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );

  it("中信兩端都已連結發票時保留原交易與決定，不刪除衝突；配對準備後才新增的衝突使 batch 回滾", async () => {
    const sourceId = "credit:ctbc:main";
    const card = bankAccountRecord(
      "ctbc",
      { sourceId, accountType: "credit", currency: "TWD" },
      now,
    );
    const make = (status: "pending" | "posted") =>
      bankTransactionRecord(
        "ctbc",
        {
          accountId: sourceId,
          sourceId: `ctbc:card:tx:${status}:1`,
          status,
          authorizedAt:
            status === "pending" ? "2026-10-05T09:00:00+08:00" : "2026-10-05",
          amount: -252,
          currency: "TWD",
          raw: { cardLast4: "1234", authorizationHash: "same" },
        },
        now,
      );
    const pending = make("pending"),
      posted = make("posted");
    await persistStagedSyncWrite(db, { records: [card, pending, posted] });
    const prepared = await prepareCtbcAuthorizationWrite(db, [posted]);
    await db.batch(
      [pending, posted].flatMap((record, index) => [
        db
          .prepare(
            "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES (?, 'einvoice', ?, '2026-10-05', 252, 't', 't')",
          )
          .bind(`invoice${index}`, `invoice${index}`),
        db
          .prepare(
            "INSERT INTO invoice_transaction_preferences VALUES (?, ?, 'linked', 't', 't')",
          )
          .bind(`invoice${index}`, record.recordKey),
      ]),
    );
    await expect(persistStagedSyncWrite(db, prepared)).rejects.toThrow();
    await persistStagedSyncWrite(
      db,
      await prepareCtbcAuthorizationWrite(db, [posted]),
    );
    expect(await listBankTransactions(db, 20)).toHaveLength(2);
    expect(
      (
        await db
          .prepare(
            "SELECT transaction_id FROM invoice_transaction_preferences ORDER BY invoice_id",
          )
          .all()
      ).results,
    ).toEqual([
      { transaction_id: pending.recordKey },
      { transaction_id: posted.recordKey },
    ]);
    expect(
      await db
        .prepare("SELECT status FROM bank_transactions WHERE id = ?")
        .bind(pending.recordKey)
        .first("status"),
    ).toBe("pending");
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it.each([
    "卡片不明",
    "不同卡",
    "消費日不明",
    "不同消費日",
    "不同金額",
    "不同幣別",
    "不同方向",
  ])("台新不強配%s", async (scenario) => {
    await taishinSettings();
    const authorization = structuredClone(realtime);
    if (scenario === "卡片不明")
      authorization.value.fmtRealTxListMap[0].cardname = "無卡號";
    await writeTaishin(
      parseTaishinCreditCardData(
        { ...taishinBase, realtime: authorization },
        bankNow,
      ),
    );
    const unposted = structuredClone(unbilled);
    const incoming = parseTaishinCreditCardData(
      { ...taishinBase, unbilled: unposted },
      bankNow,
    );
    if (scenario === "不同卡")
      incoming.bankTransactions[0].raw = { cardLast4: "5678" };
    if (scenario === "消費日不明")
      incoming.bankTransactions[0].authorizedAt = undefined;
    if (scenario === "不同消費日")
      incoming.bankTransactions[0].authorizedAt = "2026-10-04";
    if (scenario === "不同幣別") incoming.bankTransactions[0].currency = "USD";
    if (scenario === "不同金額") incoming.bankTransactions[0].amount = -253;
    if (scenario === "不同方向") incoming.bankTransactions[0].amount = 252;
    await writeTaishin(incoming);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM bank_transactions WHERE matched_transaction_id IS NOT NULL",
        )
        .first("n"),
    ).toBe(0);
    expect(await listBankTransactions(db, 20)).toHaveLength(2);
  });

  it("台新正式交易已有決定時保留分類、排除與發票衝突，不覆寫或重新分配關係", async () => {
    await taishinSettings();
    const pending = parseTaishinCreditCardData(
      { ...taishinBase, realtime },
      bankNow,
    );
    const posted = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    await persistStagedSyncWrite(db, {
      records: [...taishinRecords(pending), ...taishinRecords(posted)],
    });
    const pendingId = taishinRecords(pending).find(
      (row) => row.entityType === "bank_transaction",
    )!.recordKey;
    const postedId = taishinRecords(posted).find(
      (row) => row.entityType === "bank_transaction",
    )!.recordKey;
    for (const [id, excluded, category] of [
      [pendingId, 1, "shopping"],
      [postedId, 0, "food"],
    ] as const) {
      await db.batch([
        db
          .prepare(
            "INSERT INTO bank_transaction_preferences VALUES (?, ?, 't', 't')",
          )
          .bind(id, excluded),
        db
          .prepare(
            "INSERT INTO classification_overrides VALUES (?, 'bank_transaction', ?, ?, 't', 't')",
          )
          .bind(`override:${id}`, id, category),
        db
          .prepare(
            "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES (?, 'einvoice', ?, '2026-10-05', 252, 't', 't')",
          )
          .bind(`invoice:${id}`, id),
        db
          .prepare(
            "INSERT INTO invoice_transaction_preferences VALUES (?, ?, 'linked', 't', 't')",
          )
          .bind(`invoice:${id}`, id),
      ]);
    }
    await writeTaishin(posted);
    expect(
      await db
        .prepare(
          "SELECT excluded_from_calculation FROM bank_transaction_preferences WHERE transaction_id = ?",
        )
        .bind(postedId)
        .first("excluded_from_calculation"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_id = ?",
        )
        .bind(postedId)
        .first("category_id"),
    ).toBe("food");
    expect(
      await db
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = ?",
        )
        .bind(`invoice:${pendingId}`)
        .first("transaction_id"),
    ).toBe(pendingId);
    expect(
      await db
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = ?",
        )
        .bind(`invoice:${postedId}`)
        .first("transaction_id"),
    ).toBe(postedId);
  });

  it("台新相同 ID 入帳及舊版借用授權 ID 的正式紀錄維持一筆", async () => {
    await taishinSettings();
    const pending = parseTaishinCreditCardData(
      { ...taishinBase, realtime },
      bankNow,
    );
    await writeTaishin(pending);
    const sameId = structuredClone(pending);
    sameId.bankTransactions[0].status = "posted";
    sameId.bankTransactions[0].postedDate = "2026-10-06";
    sameId.bankTransactions[0].authorizedAt = "2026-10-05";
    await writeTaishin(sameId);
    const official = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    expect((await writeTaishin(official)).bankTransactions).toBe(0);
    expect(await listBankTransactions(db, 20)).toHaveLength(1);
    expect((await listBankTransactions(db, 20))[0].authorizedAt).toBe(
      "2026-10-05T09:15:30+08:00",
    );
  });

  it("台新 promotion 失敗一起回滾配對與 cursor，憑證變更後舊同步也不能移動偏好", async () => {
    await taishinSettings();
    const pending = parseTaishinCreditCardData(
      { ...taishinBase, realtime },
      bankNow,
    );
    const posted = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    await writeTaishin(pending);
    const prepared = await prepareTaishinAuthorizationWrite(
      db,
      taishinRecords(posted),
      "config",
    );
    const finalize = connectorStateStatement(
      db,
      "taishin",
      "new-session",
      null,
      "new-cursor",
      now,
      "config",
    );
    await expect(
      persistStagedSyncWrite(db, {
        records: prepared.records,
        settingsGuard: { connectorId: "taishin", encryptedConfig: "config" },
        afterPromoteStatements: prepared.afterPromoteStatements,
        finalizeStatements: [
          finalize,
          db.prepare(
            "INSERT INTO bank_transaction_preferences VALUES ('missing', 1, 't', 't')",
          ),
        ],
      }),
    ).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM bank_transactions")
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT matched_transaction_id FROM bank_transactions")
        .first("matched_transaction_id"),
    ).toBeNull();
    expect(
      await db
        .prepare(
          "SELECT sync_cursor FROM connector_settings WHERE connector_id = 'taishin'",
        )
        .first("sync_cursor"),
    ).toBe("old-cursor");
    // Both transactions already exist: clearing staging alone would not protect
    // their relationship from a stale authorization promotion.
    await persistStagedSyncWrite(db, { records: taishinRecords(posted) });
    const stale = await prepareTaishinAuthorizationWrite(db, [], "config");
    await db
      .prepare(
        "UPDATE connector_settings SET encrypted_config = 'changed' WHERE connector_id = 'taishin'",
      )
      .run();
    await persistStagedSyncWrite(db, {
      records: stale.records,
      settingsGuard: { connectorId: "taishin", encryptedConfig: "config" },
      afterPromoteStatements: stale.afterPromoteStatements,
      finalizeStatements: [finalize],
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM bank_transactions WHERE matched_transaction_id IS NOT NULL",
        )
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT encrypted_config, sync_cursor FROM connector_settings WHERE connector_id = 'taishin'",
        )
        .first(),
    ).toEqual({ encrypted_config: "changed", sync_cursor: "old-cursor" });
  });

  it("台新無卡仍保存存款，重抓不增副本，集保同帳戶不重複計入資產", async () => {
    await taishinSettings();
    const deposits = await fetchTaishinDeposits(depositRequest, bankNow);
    const credit = parseTaishinCreditCardData(
      { ...taishinBase, hasCreditCard: false },
      bankNow,
    );
    const merged = {
      bankAccounts: [...deposits.bankAccounts, ...credit.bankAccounts],
      bankBalanceSnapshots: [
        ...deposits.bankBalanceSnapshots,
        ...credit.bankBalanceSnapshots,
      ],
      bankTransactions: [
        ...deposits.bankTransactions,
        ...credit.bankTransactions,
      ],
    };
    const settlement = bankAccountRecord(
      "tdcc",
      {
        sourceId: "settlement:812:1234:TWD",
        accountType: "settlement_cash",
        currency: "TWD",
      },
      now,
    );
    await persistStagedSyncWrite(db, {
      records: [
        settlement,
        bankBalanceSnapshotRecord(
          "tdcc",
          {
            accountId: "settlement:812:1234:TWD",
            sourceId: "balance",
            balance: 1000,
            currency: "TWD",
            asOfAt: bankNow.toISOString(),
          },
          now,
        ),
      ],
    });
    expect((await writeTaishin(merged)).bankTransactions).toBe(5);
    expect((await writeTaishin(merged)).bankTransactions).toBe(0);
    await db
      .prepare(
        "INSERT INTO exchange_rates (currency, rate_to_twd, updated_at) VALUES ('USD', 31, 't') ON CONFLICT(currency) DO UPDATE SET rate_to_twd = 31",
      )
      .run();
    const accounts = await listBankAccounts(db);
    expect(accounts).toHaveLength(3);
    expect(
      accounts.every(
        (row) => row.connectorId === "taishin" && row.bankCode === "812",
      ),
    ).toBe(true);
    expect(accounts.find((row) => row.currency === "TWD")).toMatchObject({
      accountLast4: "1234",
      accountName: "末四碼 1234",
      balance: 2000,
    });
    await rebuildBankDepositHistory(db, ["2026-10-07"]);
    expect(
      await db
        .prepare(
          "SELECT net_worth FROM net_worth_history WHERE id = 'bank:deposit:2026-10-07'",
        )
        .first("net_worth"),
    ).toBe(5883);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM bank_balance_snapshots WHERE connector_id = 'taishin'",
        )
        .first("n"),
    ).toBe(3);
  });

  it("重抓與入帳只保留一筆交易、原始時刻及使用者排除決定，空結果也保留歷史", async () => {
    const records = [account, transaction("pending")];
    expect(
      (await persistStagedSyncWrite(db, { records })).bankTransactions,
    ).toBe(1);
    await db
      .prepare(
        "INSERT INTO bank_transaction_preferences VALUES ('sinopac:purchase', 1, 'created', 'updated')",
      )
      .run();
    for (const records of [
      [transaction("posted")],
      [transaction("pending")],
      [],
    ]) {
      expect(
        (await persistStagedSyncWrite(db, { records })).bankTransactions,
      ).toBe(0);
    }
    expect(
      (
        await db
          .prepare(
            "SELECT id, amount, status, authorized_at, posted_date, raw_payload FROM bank_transactions",
          )
          .all()
      ).results,
    ).toEqual([
      {
        id: "sinopac:purchase",
        amount: -252,
        status: "posted",
        authorized_at: now,
        posted_date: "2026-09-03",
        raw_payload: JSON.stringify({ status: "posted" }),
      },
    ]);
    expect(
      await db.prepare("SELECT * FROM bank_transaction_preferences").first(),
    ).toEqual({
      transaction_id: "sinopac:purchase",
      excluded_from_calculation: 1,
      created_at: "created",
      updated_at: "updated",
    });
  });

  it("後續資料缺少繳款欄位時保留已確認的繳款資料", async () => {
    const bill: SyncWriteRecord = {
      entityType: "credit_card_bill",
      recordKey: "sinopac:bill",
      payload: {
        id: "sinopac:bill",
        connector_id: "sinopac",
        account_id: account.recordKey,
        source_id: "bill",
        billing_period: "2026-09",
        statement_amount: 1000,
        paid_amount: 1000,
        is_paid: 1,
        currency: "TWD",
        raw_payload: "{}",
        created_at: now,
        updated_at: now,
      },
    };
    await persistStagedSyncWrite(db, { records: [account, bill] });
    await persistStagedSyncWrite(db, {
      records: [
        {
          ...bill,
          payload: { ...bill.payload, paid_amount: null, is_paid: null },
        },
      ],
    });
    expect(
      await db
        .prepare("SELECT paid_amount, is_paid FROM credit_card_bills")
        .first(),
    ).toEqual({ paid_amount: 1000, is_paid: 1 });
  });

  it("暫存後變更憑證時，舊同步不能寫入金融資料或覆蓋新憑證與 cursor", async () => {
    const records = [account, transaction("posted")];
    await stageSyncWriteRecords(db, "stale-run", records);
    await db
      .prepare(
        "UPDATE connector_settings SET encrypted_config = 'new-config', sync_cursor = NULL WHERE connector_id = 'sinopac'",
      )
      .run();
    const staleState = connectorStateStatement(
      db,
      "sinopac",
      "stale-session",
      null,
      "stale-cursor",
      now,
      "old-config",
    );
    await promoteStagedSyncWrite(db, {
      runId: "stale-run",
      entityTypes: ["bank_account", "bank_transaction"],
      settingsGuard: { connectorId: "sinopac", encryptedConfig: "old-config" },
      finalizeStatements: [staleState],
    });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM bank_accounts").first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM bank_transactions")
        .first("n"),
    ).toBe(0);
    expect(
      await updateConnectorEncryptedConfigIfCurrent(
        db,
        "sinopac",
        "old-config",
        "stale-session",
      ),
    ).toBe(false);
    expect((await staleState.run()).meta.changes).toBe(0);
    expect(
      await db
        .prepare("SELECT encrypted_config, sync_cursor FROM connector_settings")
        .first(),
    ).toEqual({ encrypted_config: "new-config", sync_cursor: null });
    expect(
      (
        await persistStagedSyncWrite(db, {
          records,
          settingsGuard: {
            connectorId: "sinopac",
            encryptedConfig: "new-config",
          },
          finalizeStatements: [
            connectorStateStatement(
              db,
              "sinopac",
              "current-session",
              null,
              "current-cursor",
              now,
              "new-config",
            ),
          ],
        })
      ).bankTransactions,
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT encrypted_config, sync_cursor FROM connector_settings")
        .first(),
    ).toEqual({
      encrypted_config: "current-session",
      sync_cursor: "current-cursor",
    });
  });
});
