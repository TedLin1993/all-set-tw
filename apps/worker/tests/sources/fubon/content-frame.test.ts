import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectFubonTransactionAccounts,
  waitForFubonContentFrame,
  type FubonPageLike,
} from "../../../src/sources/fubon/connector";
import { parseFubonDepositOverview } from "../../../src/sources/fubon/protocol";

// 假的框架樹（不含任何真實資料）：top Index.faces → frame1 ContextFrame → txnFrame。
const ORIGIN = "https://ebank.taipeifubon.com.tw";
const CDSQU001 = "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces";

type FakeDoc = {
  readyState: string;
  hasForm: boolean;
  html: string;
  selects: { id: string; name: string; options: { value: string }[] }[];
};

class FakeFrame {
  detached = false;
  constructor(
    public currentUrl: string,
    public frameName: string,
    public parent: FakeFrame | null,
    public win: Record<string, unknown> = {},
    public doc: FakeDoc = {
      readyState: "complete",
      hasForm: false,
      html: "<html></html>",
      selects: [],
    },
  ) {}
  url() {
    return this.currentUrl;
  }
  name() {
    return this.frameName;
  }
  parentFrame() {
    return this.parent;
  }
  /** 模擬導向：新文件、新 window。 */
  navigate(
    path: string,
    doc: Partial<FakeDoc>,
    win: Record<string, unknown> = {},
  ) {
    this.currentUrl = `${ORIGIN}${path}`;
    this.win = win;
    this.doc = {
      readyState: "complete",
      hasForm: true,
      html: "<html></html>",
      selects: [],
      ...doc,
    };
  }
  evaluate = (async (
    fn: (...args: unknown[]) => unknown,
    ...args: unknown[]
  ) => {
    const doc = this.doc;
    const fakeDocument = {
      get readyState() {
        return doc.readyState;
      },
      documentElement: {
        get outerHTML() {
          return doc.html;
        },
      },
      get scripts() {
        return [
          ...doc.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
        ].map((match) => ({ text: match[1] ?? "" }));
      },
      querySelector(selector: string) {
        return selector.includes("form1") && doc.hasForm ? {} : null;
      },
      querySelectorAll(selector: string) {
        return selector === "select" ? doc.selects : [];
      },
    };
    const globals = globalThis as Record<string, unknown>;
    const saved = { window: globals.window, document: globals.document };
    globals.window = this.win;
    globals.document = fakeDocument;
    try {
      return fn(...args);
    } finally {
      globals.window = saved.window;
      globals.document = saved.document;
    }
  }) as unknown as FubonPageLike["mainFrame"] extends () => infer F
    ? F extends { evaluate: infer E }
      ? E
      : never
    : never;
}

function fakePage() {
  const top = new FakeFrame(`${ORIGIN}/B2C/common/Index.faces`, "", null);
  const context = new FakeFrame(
    `${ORIGIN}/B2C/common/ContextFrame.faces?fromIndex=true`,
    "frame1",
    top,
  );
  const txn = new FakeFrame(
    `${ORIGIN}/B2C/cboqu/cboqu003/CBOQU003_Home.faces`,
    "txnFrame",
    context,
  );
  const frames: FakeFrame[] = [top, context, txn];
  const page = {
    url: () => top.url(),
    frames: () => frames.filter((frame) => !frame.detached),
    mainFrame: () => top,
  };
  return { page: page as unknown as FubonPageLike, frames, context, txn };
}

const COMBO_SCRIPT =
  '<script>var comboAccountItems = new Array();comboAccountItems[0] = new Array("09876500001111", "012-0009876500001111-TWD-31", "_none");</script>';

describe("waitForFubonContentFrame", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ignores the pre-navigation document (stale flag) and waits for the account marker", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { page, txn } = fakePage();
    // 舊文件已在目標路徑但被標記為導向前文件。
    txn.navigate(
      CDSQU001,
      { html: COMBO_SCRIPT },
      { __allSetFubonStale: true },
    );
    let polls = 0;
    const frame = await waitForFubonContentFrame(page, CDSQU001, {
      timeoutMs: 2_000,
      markerGraceMs: 1_000,
      pollMs: 1,
      onPoll: async () => {
        polls += 1;
        if (polls === 3)
          txn.navigate(CDSQU001, { html: "<form id=form1></form>" });
        if (polls === 6) txn.navigate(CDSQU001, { html: COMBO_SCRIPT });
      },
    });
    expect(frame).toBe(txn);
    expect(polls).toBeGreaterThanOrEqual(6);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("accepts a select with options or window.comboAccountItems as the marker", async () => {
    const { page, txn } = fakePage();
    txn.navigate(CDSQU001, {
      selects: [
        {
          id: "form1:comboAccount",
          name: "form1:comboAccount",
          options: [{ value: "012-0009876500001111-TWD-31" }],
        },
      ],
    });
    await expect(
      waitForFubonContentFrame(page, CDSQU001, {
        timeoutMs: 500,
        markerGraceMs: 400,
        pollMs: 1,
      }),
    ).resolves.toBe(txn);
    txn.navigate(CDSQU001, {}, { comboAccountItems: [["x", "y", "z"]] });
    await expect(
      waitForFubonContentFrame(page, CDSQU001, {
        timeoutMs: 500,
        markerGraceMs: 400,
        pollMs: 1,
      }),
    ).resolves.toBe(txn);
  });

  it("skips detached frames and returns the ready frame after the marker grace period", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { page, frames, context, txn } = fakePage();
    const ghost = new FakeFrame(`${ORIGIN}${CDSQU001}`, "txnFrame", context);
    ghost.doc = {
      readyState: "complete",
      hasForm: true,
      html: COMBO_SCRIPT,
      selects: [],
    };
    ghost.detached = true;
    // detached 但仍被列出（模擬舊 handle）
    frames.push(ghost);
    (page as unknown as { frames: () => FakeFrame[] }).frames = () => frames;
    txn.navigate(CDSQU001, { html: "<form id=form1></form>" });
    const frame = await waitForFubonContentFrame(page, CDSQU001, {
      timeoutMs: 2_000,
      markerGraceMs: 20,
      pollMs: 1,
    });
    expect(frame).toBe(txn);
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("fubon_page_marker_missing"),
    ]);
  });

  it("waits for the account dropdown on the overview-forwarded page (path stays CBOQU003)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { page, txn } = fakePage();
    const CBOQU003 = "/B2C/cboqu/cboqu003/CBOQU003_Home.faces";
    // 總覽本身已就緒但沒有帳號選單：requireMarker 時不可在寬限期後回傳。
    txn.navigate(CBOQU003, { html: "<form id=form1></form>" });
    await expect(
      waitForFubonContentFrame(page, [CBOQU003, CDSQU001], {
        timeoutMs: 60,
        markerGraceMs: 5,
        pollMs: 1,
        marker: "transactionAccounts",
        requireMarker: true,
      }),
    ).rejects.toThrow("CBOQU003_Home.faces");
    let polls = 0;
    const frame = await waitForFubonContentFrame(page, [CBOQU003, CDSQU001], {
      timeoutMs: 2_000,
      markerGraceMs: 5,
      pollMs: 1,
      marker: "transactionAccounts",
      requireMarker: true,
      onPoll: async () => {
        polls += 1;
        if (polls === 4) txn.navigate(CBOQU003, { html: COMBO_SCRIPT });
      },
    });
    expect(frame).toBe(txn);
    expect(polls).toBeGreaterThanOrEqual(4);
  });

  it("does not return blank.html children or the main frame", async () => {
    const { page, frames, txn } = fakePage();
    txn.currentUrl = `${ORIGIN}/B2C/dispatcher`;
    const blank = new FakeFrame(`${ORIGIN}/B2C/inc/blank.html`, "", txn);
    blank.doc.hasForm = true;
    frames.push(blank);
    await expect(
      waitForFubonContentFrame(page, CDSQU001, {
        timeoutMs: 30,
        markerGraceMs: 10,
        pollMs: 1,
      }),
    ).rejects.toThrow("CDSQU001_Home.faces");
  });
});

describe("selectFubonTransactionAccounts", () => {
  afterEach(() => vi.restoreAllMocks());

  const twd = (accountNo: string) => ({
    accountNo,
    sourceId: `bank:fubon:${accountNo.slice(-4)}:x:TWD`,
    typeName: "活儲存款",
    currency: "TWD",
    balance: 1,
  });

  it("skips overview accounts missing from the dropdown with a de-identified warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { matched, missing } = selectFubonTransactionAccounts(
      [twd("09876500001111"), twd("09876500002222")],
      {
        framePath: CDSQU001,
        html: "<form id=form1></form>",
        windowValues: ["012-0009876500001111-TWD-31"],
        windowHasItems: true,
        liveOptionValues: ["none"],
      },
    );
    expect(matched.map((item) => item.account.accountNo)).toEqual([
      "09876500001111",
    ]);
    // 缺少的帳戶交由存款總覽「交易明細查詢」補查。
    expect(missing.map((account) => account.accountNo)).toEqual([
      "09876500002222",
    ]);
    const logs = warn.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(logs[0]).toMatchObject({
      event: "fubon_transaction_accounts",
      framePath: "CDSQU001_Home.faces",
      hasComboScript: true,
      hasComboSelect: true,
      optionCount: 1,
      twdOptionCount: 1,
      overviewTwdCount: 2,
      matched: 1,
      optionDigitLengths: [16],
      overviewDigitLengths: [14],
      optionShapes: ["N3-N16-TWD-N2"],
      unparsedShapes: ["none"],
      missingWithOtherCurrencyOption: 0,
    });
    expect(logs[1]).toMatchObject({
      event: "fubon_transaction_account_skipped",
      reason: "not_in_transaction_dropdown",
      fallback: "overview_quick_link",
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toMatch(/98765/);
  });

  it("fails only when the dropdown has no parsable options at all", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() =>
      selectFubonTransactionAccounts([twd("09876500001111")], {
        framePath: CDSQU001,
        html: "<form id=form1><select id='form1:comboAccount'></select></form>",
        windowValues: [],
        windowHasItems: false,
        liveOptionValues: [],
      }),
    ).toThrow("沒有找到任何帳號選項");
  });

  it("reports a TWD account listed only under another currency (live 2026-10-15 shape)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { matched, missing } = selectFubonTransactionAccounts(
      [twd("09876500001111")],
      {
        framePath: CDSQU001,
        html: "<form id=form1></form>",
        windowValues: ["012-0009876500001111-CNY-12"],
        windowHasItems: true,
        liveOptionValues: ["012-0009876500001111-CNY-12"],
        selectedValue: "012-0009876500001111-CNY-12",
      },
      { allowEmpty: true },
    );
    expect(matched).toEqual([]);
    expect(missing).toHaveLength(1);
    const logs = warn.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(logs[0]).toMatchObject({
      twdOptionCount: 0,
      missingWithOtherCurrencyOption: 1,
      selectedShape: "N3-N16-CNY-N2",
    });
    expect(JSON.stringify(logs)).not.toMatch(/98765/);
  });

  it("keeps the overview-to-dropdown match on the de-identified fixtures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { readFileSync } = await import("node:fs");
    const fixture = (name: string) =>
      readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
    const { accounts } = parseFubonDepositOverview(
      fixture("deposit-overview.html"),
    );
    const matched = selectFubonTransactionAccounts(
      accounts.filter((account) => account.currency === "TWD"),
      {
        framePath: CDSQU001,
        html: fixture("deposit-transactions.html"),
        windowValues: [],
        windowHasItems: false,
        liveOptionValues: [],
      },
    );
    expect(matched.matched).toHaveLength(1);
    expect(matched.missing).toHaveLength(0);
  });
});
