import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFubonTransactionQuery,
  assertFubonTransactionRange,
} from "../../../src/sources/fubon/connector";
import {
  FUBON_CREDIT_ACCOUNT_ID,
  FubonSyncReport,
  depositTransactions,
  exceedsFubonRangeLimit,
  fubonTransactionRange,
  parseFubonData,
  parseFubonDepositTransactionsPage,
  splitFubonRange,
  type FubonDepositTransactionRow,
  type FubonPayloads,
} from "../../../src/sources/fubon/protocol";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// 合成表單：依 2026-10 HAR 的 CDSQU001 欄位結構（id、name、class、value）建立，
// 不含任何真實帳號或 token。
const ACCOUNT_VALUE = "012-0000123450009999-TWD-31";
const formHtml = `<!doctype html><html><body><form id="form1">
<select id="form1:comboAccount" name="form1:comboAccount">
  <option value="none">請選擇</option>
  <option value="${ACCOUNT_VALUE}">${ACCOUNT_VALUE}</option>
</select>
<input id="form1:rdoTxDetail" type="radio" name="form1:rdoGroup1" value="1" checked>
<input id="form1:rdoInternal" type="radio" name="form1:rdoGroup1" value="2">
<input id="form1:rdoFast" type="radio" name="form1:rdoGroup21" value="1" checked class="queryTime">
<input id="form1:rdoDay1" type="radio" name="form1:rdoGroup3" value="1" checked class="queryDate fast">
<input id="form1:rdoDay30" type="radio" name="form1:rdoGroup3" value="30" class="queryDate fast">
<input id="form1:rdoDay90" type="radio" name="form1:rdoGroup3" value="90" class="queryDate fast">
<input id="form1:thisMonth" type="radio" name="form1:rdoGroup3" value="0" class="queryTime fastBtn hide">
<input id="form1:rdoCustom" type="radio" name="form1:rdoGroup21" value="2" class="queryTime">
<input id="form1:startDate" type="text" name="form1:startDate" class="date queryTime" value="2026/10/15">
<input id="form1:endDate" type="text" name="form1:endDate" class="date queryTime" value="2026/10/15">
<input id="form1:type" type="hidden" name="form1:type" value="">
<span id="dateMsgEnd"></span>
</form></body></html>`;

type PageHooks = {
  ajax?: (period: string | undefined) => { startDate: string; endDate: string };
  validate?: () => boolean;
};

function withForm<T>(hooks: PageHooks, run: (doc: Document) => T): T {
  const dom = new JSDOM(formHtml);
  const win = dom.window as unknown as Record<string, unknown>;
  const doc = dom.window.document;
  win.doValidateAndSubmitOnSubmit = () => false;
  if (hooks.ajax) {
    win.ajaxGetQueryDate = () => {
      const checked = doc.querySelector<HTMLInputElement>(
        "input.queryDate:checked",
      );
      const response = hooks.ajax!(checked?.value);
      (doc.getElementById("form1:startDate") as HTMLInputElement).value =
        response.startDate;
      (doc.getElementById("form1:endDate") as HTMLInputElement).value =
        response.endDate;
    };
  }
  if (hooks.validate) win.validate = hooks.validate;
  const globals = globalThis as Record<string, unknown>;
  const saved = { document: globals.document, window: globals.window };
  globals.document = doc;
  globals.window = win;
  try {
    return run(doc);
  } finally {
    globals.document = saved.document;
    globals.window = saved.window;
  }
}

function posted(doc: Document) {
  const form = doc.getElementById("form1") as HTMLFormElement;
  const data = new (doc.defaultView as unknown as typeof globalThis).FormData(
    form,
  );
  return Object.fromEntries(
    [...data.entries()].map(([key, value]) => [key, String(value)]),
  );
}

describe("台北富邦交易明細查詢期間", () => {
  afterEach(() => vi.restoreAllMocks());

  it("近三個月以台灣日期計算（UTC 前一日的台灣凌晨、月底日期夾到該月最後一日）", () => {
    // 2026-10-14T17:00Z = 台灣 2026-10-15 01:00
    expect(fubonTransactionRange(new Date("2026-10-14T17:00:00Z"))).toEqual({
      start: "2026/07/15",
      end: "2026/10/15",
    });
    expect(fubonTransactionRange(new Date("2026-05-31T04:00:00Z"))).toEqual({
      start: "2026/02/28",
      end: "2026/05/31",
    });
  });

  it("完整三個月以官方「近3個月」快速查詢送出，伺服器回填起迄日與要求相同（HAR 做法）", () => {
    const periods: (string | undefined)[] = [];
    withForm(
      {
        ajax: (period) => {
          periods.push(period);
          return period === "90"
            ? { startDate: "2026/07/15", endDate: "2026/10/15" }
            : { startDate: "2026/10/15", endDate: "2026/10/15" };
        },
        validate: () => true,
      },
      (doc) => {
        expect(
          applyFubonTransactionQuery(
            ACCOUNT_VALUE,
            "2026/07/15",
            "2026/10/15",
            true,
            false,
          ),
        ).toEqual({ ok: true, mode: "convenient90" });
        expect(periods).toEqual(["90"]);
        expect(posted(doc)).toMatchObject({
          "form1:comboAccount": ACCOUNT_VALUE,
          "form1:rdoGroup1": "1",
          "form1:rdoGroup21": "1",
          "form1:rdoGroup3": "90",
          "form1:startDate": "2026/07/15",
          "form1:endDate": "2026/10/15",
          "form1:type": "btnType1",
        });
      },
    );
  });

  it("伺服器回填的期間與要求不同時改用自訂期間並填入要求的起迄日", () => {
    withForm(
      {
        ajax: () => ({ startDate: "2026/07/14", endDate: "2026/10/15" }),
        validate: () => true,
      },
      (doc) => {
        expect(
          applyFubonTransactionQuery(
            ACCOUNT_VALUE,
            "2026/07/15",
            "2026/10/15",
            true,
            false,
          ),
        ).toEqual({ ok: true, mode: "custom" });
        const data = posted(doc);
        expect(data).toMatchObject({
          "form1:rdoGroup21": "2",
          "form1:startDate": "2026/07/15",
          "form1:endDate": "2026/10/15",
        });
        // 隱藏的本月／上月快速按鈕不得被勾選。
        expect(data["form1:rdoGroup3"]).not.toBe("0");
      },
    );
  });

  it("分段期間以自訂期間送出，不呼叫快速查詢回填", () => {
    const ajax = vi.fn(() => ({
      startDate: "2026/10/15",
      endDate: "2026/10/15",
    }));
    withForm({ ajax, validate: () => true }, (doc) => {
      expect(
        applyFubonTransactionQuery(
          ACCOUNT_VALUE,
          "2026/07/15",
          "2026/08/30",
          false,
          false,
        ),
      ).toEqual({ ok: true, mode: "custom" });
      expect(ajax).not.toHaveBeenCalled();
      expect(posted(doc)).toMatchObject({
        "form1:rdoGroup21": "2",
        "form1:startDate": "2026/07/15",
        "form1:endDate": "2026/08/30",
      });
    });
  });

  it("官方檢核失敗或帳號不在選單時不送出，回傳原因", () => {
    withForm(
      {
        validate: () => {
          document.getElementById("dateMsgEnd")!.textContent =
            "起迄日不可晚於今日";
          return false;
        },
      },
      () => {
        expect(
          applyFubonTransactionQuery(
            ACCOUNT_VALUE,
            "2026/07/15",
            "2026/10/15",
            false,
            false,
          ),
        ).toEqual({
          ok: false,
          reason: "validate_failed",
          message: "起迄日不可晚於今日",
        });
        expect(
          applyFubonTransactionQuery(
            "012-9999-TWD-31",
            "2026/07/15",
            "2026/10/15",
            false,
            false,
          ),
        ).toEqual({ ok: false, reason: "no_account_option" });
      },
    );
  });

  it("回應頁回顯的期間（例如預設的當日）與要求不符時記錄 range_mismatch（只含日期）並失敗", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const todayOnly = fixture("deposit-transactions.html")
      .replace(/(name="form1:startDate"[^>]*value=")[^"]*/, "$12026/10/15")
      .replace(/(name="form1:endDate"[^>]*value=")[^"]*/, "$12026/10/15");
    const parsed = parseFubonDepositTransactionsPage(todayOnly);
    const requested = { start: "2026/07/15", end: "2026/10/15" };
    expect(() =>
      assertFubonTransactionRange(requested, parsed, "convenient90"),
    ).toThrow(/查詢期間/);
    const logged = JSON.parse(String(warn.mock.calls.at(-1)?.[0]));
    expect(logged).toEqual({
      event: "fubon_transaction_range_mismatch",
      connectorId: "fubon",
      requested,
      echoed: { start: "2026/10/15", end: "2026/10/15" },
      mode: "convenient90",
    });
    expect(() =>
      assertFubonTransactionRange(
        requested,
        { startDate: "2026/07/15", endDate: "2026/10/15" },
        "custom",
      ),
    ).not.toThrow();
  });

  it("單次查詢上限六個月：三個月與分段期間不超過，超過六個月才需分割", () => {
    expect(
      exceedsFubonRangeLimit({ start: "2026/07/15", end: "2026/10/15" }),
    ).toBe(false);
    expect(
      exceedsFubonRangeLimit({ start: "2026/04/15", end: "2026/10/15" }),
    ).toBe(false);
    expect(
      exceedsFubonRangeLimit({ start: "2026/04/14", end: "2026/10/15" }),
    ).toBe(true);
    expect(splitFubonRange({ start: "2026/07/15", end: "2026/10/15" })).toEqual(
      [
        { start: "2026/07/15", end: "2026/08/30" },
        { start: "2026/08/31", end: "2026/10/15" },
      ],
    );
  });
});

const ACCOUNT_ID = "fubon:deposit:01234500004321:TWD";
const row = (
  overrides: Partial<FubonDepositTransactionRow>,
): FubonDepositTransactionRow => ({
  bookingDate: "2026-09-01",
  transactedAt: "2026-09-01T10:00:00+08:00",
  summary: "轉帳",
  amount: -100,
  balanceAfter: 900,
  memo: "測試",
  ...overrides,
});

describe("台北富邦交易去重", () => {
  const julyRow = row({ bookingDate: "2026-07-20", balanceAfter: 1000 });
  // 同一日兩筆完全相同的合法交易（例如即時餘額未提供）。
  const twinA = row({ balanceAfter: undefined, transactedAt: undefined });
  const twinB = row({ balanceAfter: undefined, transactedAt: undefined });
  const octRow = row({
    bookingDate: "2026-10-01",
    amount: 500,
    balanceAfter: 1400,
  });

  it("同頁完全相同的合法交易以序號區分，不會被合併", () => {
    const result = depositTransactions(ACCOUNT_ID, "01234500004321", "TWD", [
      [twinA, twinB],
    ]);
    expect(result.duplicatesRemoved).toBe(0);
    expect(
      result.records.map((record) => record.sourceId.split(":").at(-1)),
    ).toEqual(["1", "2"]);
    expect(new Set(result.records.map((record) => record.sourceId)).size).toBe(
      2,
    );
  });

  it("ID 在不同同步、重疊的三個月期間與分段期間之間一致", () => {
    const id = (pages: FubonDepositTransactionRow[][]) =>
      depositTransactions(ACCOUNT_ID, "1234500004321", "TWD", pages)
        .records.map((record) => record.sourceId)
        .sort();
    const fullWindow = id([[julyRow, twinA, twinB, octRow]]);
    // 分段：七／八月一段，九／十月一段（以整日切割）。
    const splitWindows = id([[julyRow], [twinA, twinB, octRow]]);
    // 隔日同步：期間右移，七月那筆已在期間外。
    const nextDay = id([[twinA, twinB, octRow]]);
    expect(splitWindows).toEqual(fullWindow);
    expect(fullWindow).toEqual(expect.arrayContaining(nextDay));
    // 帳號前置補零不同（總覽 14 碼、選單 16 碼）也得到相同 ID。
    expect(
      depositTransactions(ACCOUNT_ID, "001234500004321", "TWD", [[octRow]])
        .records[0].sourceId,
    ).toBe(id([[octRow]])[0]);
    expect(
      fullWindow.every((value) => value.startsWith("fubon:deposit:tx:v2:")),
    ).toBe(true);
  });

  it("附註文字變動（例如截斷）不改變 ID；摘要、金額或餘額不同則為不同交易", () => {
    const base = depositTransactions(ACCOUNT_ID, "1", "TWD", [[octRow]])
      .records[0].sourceId;
    const memoChanged = depositTransactions(ACCOUNT_ID, "1", "TWD", [
      [{ ...octRow, memo: "測" }],
    ]).records[0].sourceId;
    expect(memoChanged).toBe(base);
    for (const changed of [
      { summary: "跨行轉帳" },
      { amount: 501 },
      { balanceAfter: 1401 },
    ]) {
      expect(
        depositTransactions(ACCOUNT_ID, "1", "TWD", [
          [{ ...octRow, ...changed }],
        ]).records[0].sourceId,
      ).not.toBe(base);
    }
  });

  it("同一次同步內重疊的期間只保留一筆並記入 fubon_sync_summary 的 duplicatesRemoved", () => {
    const result = depositTransactions(ACCOUNT_ID, "1", "TWD", [
      [julyRow, twinA, twinB],
      [twinA, twinB, octRow],
    ]);
    expect(result.records).toHaveLength(4);
    expect(result.duplicatesRemoved).toBe(2);

    const page = (rows: string) =>
      fixture("deposit-transactions.html").replace(
        /(<table[^>]*id="form1:resultGrid_DataGridBody"[^>]*>[\s\S]*?<\/tr>)[\s\S]*?(<\/table>)/,
        `$1${rows}$2`,
      );
    const tr = (cells: string[]) =>
      `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
    const a = tr([
      "2026/09/01",
      "2026/09/01 10:00:00",
      "轉帳",
      "100.00",
      "",
      "900.00",
      "",
    ]);
    const b = tr([
      "2026/09/02",
      "2026/09/02 11:00:00",
      "薪資",
      "",
      "1,000.00",
      "1,900.00",
      "",
    ]);
    const report = new FubonSyncReport();
    const data = parseFubonData(
      {
        depositOverviewHtml: fixture("deposit-overview.html"),
        depositTransactions: [
          {
            accountNo: "01234500004321",
            currency: "TWD",
            pages: [page(a + b), page(b)],
          },
        ],
      },
      new Date("2026-10-15T02:00:00Z"),
      report,
    );
    const deposits = data.bankTransactions.filter((tx) =>
      tx.sourceId.startsWith("fubon:deposit:tx:"),
    );
    expect(deposits).toHaveLength(2);
    expect(report.summary().duplicatesRemoved).toEqual({
      twdTransactions: 1,
      cardTransactions: 0,
    });
  });

  it("信用卡未出帳與帳單同卡同日同金額時不撞 ID；未出帳轉入帳單沿用相同 ID", () => {
    const base = {
      depositTransactions: [],
    } satisfies Partial<FubonPayloads>;
    const billHtml = fixture("card-bill.html");
    // 未出帳列改成與帳單中某筆（9876、2026-09-09、1,050）相同的卡、日期與金額。
    const unbilledHtml = fixture("card-unbilled.html")
      .replace(/2026\/09\/30/g, "2026/09/09")
      .replace(/>640</g, ">1,050<");
    const report = new FubonSyncReport();
    const data = parseFubonData(
      {
        ...base,
        card: {
          hasCreditCard: true,
          statusHtml: fixture("card-payment-status.html"),
          billHtmls: [billHtml],
          unbilledHtml,
        },
      },
      new Date("2026-10-15T02:00:00Z"),
      report,
    );
    const matching = data.bankTransactions.filter(
      (tx) =>
        tx.accountId === FUBON_CREDIT_ACCOUNT_ID &&
        tx.sourceId.startsWith("fubon:card:tx:v1:9876:2026-09-09:-1050:"),
    );
    expect(
      matching.map((tx) => [tx.sourceId.split(":").at(-1), tx.status]),
    ).toEqual([
      ["1", "posted"],
      ["2", "pending"],
    ]);
    expect(report.summary().duplicatesRemoved.cardTransactions).toBe(0);

    // 沒有相同帳單列時，未出帳列為序號 1，入帳後帳單列同樣為序號 1（upsert 同一筆）。
    const pendingOnly = parseFubonData(
      {
        ...base,
        card: {
          hasCreditCard: true,
          statusHtml: fixture("card-payment-status.html"),
          billHtmls: [billHtml],
          unbilledHtml: fixture("card-unbilled.html"),
        },
      },
      new Date("2026-10-15T02:00:00Z"),
    ).bankTransactions.find((tx) => tx.status === "pending");
    expect(pendingOnly?.sourceId).toBe(
      "fubon:card:tx:v1:9876:2026-09-30:-640:1",
    );
  });
});
