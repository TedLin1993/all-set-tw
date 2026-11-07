import { describe, expect, it } from "vitest";
import {
  applyRealizedPnl,
  parseForeignUnrealizedResponse,
  parseSavingsAssetHtml,
  parseSavingsTransactionTable,
  parseTaiwanRealizedResponse,
  parseTaiwanUnrealizedResponse,
  parseTaiwanStatementResponse,
  realizedDateWindows,
  SinotradeProtocolError,
  statementDateRange,
  taiwanRealizedRequestBody,
  taiwanStatementRequestBody,
  taiwanUnrealizedRequestBody,
} from "../../../src/sources/sinotrade/protocol";

const taiwanResponse = {
  success: "True",
  result: {
    unreal_sums: {
      unreal_sum: [
        {
          stock: "X001",
          stocknm: "虛構科技",
          ttype: "0",
          ttypename: "現股",
          real_qty: "12",
          qty: "12",
          bqty: "12",
          sqty: "0",
          avgprice: "100",
          lastprice: "112",
          cost: "1,200",
          nowamt: "1,300",
          unreal: "100",
        },
        {
          stock: null,
          stocknm: null,
          real_qty: "12",
          cost: "1,200",
          nowamt: "1,300",
          unreal: "100",
        },
      ],
    },
  },
};

const savingsUsHtml = `
<html>
  <script>
    const assetTable = {
      data() {
        return {
          assetDatas: [{
            "StockNum": "FICT",
            "StockName": "虛構全球",
            "AssetType": null,
            "AgreedUnit": true,
            "Delivery": null,
            "InStock": 0.375,
            "AvgPrice": 123.45,
            "StockValue": 150.125,
            "ProfitAndLoss": -3.25,
            "RateOfReturn": -2.11,
            "Cost": 153.375,
            "AlreadyOpenDividendReinvest": false,
            "NeedReCalculate": false
          }],
          actype: "US",
          showCurrency: false
        };
      }
    };
  </script>
</html>`;

const savingsTwHtml = `
<script>
const app = {
  data() {
    return {
      assetDatas: [{
        "StockNum": "X001",
        "StockName": "虛構科技",
        "AssetType": ["0"],
        "AgreedUnit": false,
        "Delivery": null,
        "InStock": 12,
        "AvgPrice": 100,
        "StockValue": 1300,
        "ProfitAndLoss": 100,
        "RateOfReturn": 8.33,
        "Cost": 1200,
        "AlreadyOpenDividendReinvest": false,
        "NeedReCalculate": false
      }],
      actype: "TW",
      showCurrency: false
    };
  }
};
</script>`;

const foreignResponse = {
  success: true,
  message: "",
  result: {
    market: "US",
    sum_data: [],
    status: {
      success: true,
      message: "",
      source: "position",
    },
    data: [
      {
        market: "US",
        symbol: "FICT",
        name: "虛構全球",
        last_inv: "0.375",
        ave_cost: "100.12",
        curr: "USD",
        settle_way: "2",
        cost: "37.545",
        amount: "39.123",
        pl: "1.578",
        roi: "4.20",
        cost_usd: "37.545",
        amount_usd: "39.123",
        pl_usd: "1.578",
        cost_twd: "1,200.00",
        amount_twd: "1,250.00",
        pl_twd: "50.00",
      },
    ],
  },
};

describe("Sinotrade 持倉協定解析", () => {
  it("解析台股現股並使用 nowamt，排除明確的末列合計", () => {
    expect(parseTaiwanUnrealizedResponse(taiwanResponse)).toEqual([
      {
        symbol: "X001",
        name: "虛構科技",
        quantity: 12,
        marketValue: 1300,
        costBasis: 1200,
        unrealizedPnl: 100,
        currency: "TWD",
        market: "TW",
        positionType: "現股",
      },
    ]);
  });

  it("台股庫存請求與官方頁面一致：ttype 為 A，空字串會被官方以 400 拒絕", () => {
    expect(
      taiwanUnrealizedRequestBody(
        { brokerNo: "9999", brokerAccount: "0000001" },
        "fixture-token",
      ),
    ).toEqual({
      action: "",
      bhno: "9999",
      cseq: "0000001",
      ctype: "A",
      stock: " ",
      ttype: "A",
      token: "fixture-token",
    });
  });

  it("台股 success、合計列或融資融券型別不符時不回傳空庫存", () => {
    expect(() =>
      parseTaiwanUnrealizedResponse({
        ...taiwanResponse,
        success: true,
      }),
    ).toThrowError(SinotradeProtocolError);

    expect(() =>
      parseTaiwanUnrealizedResponse({
        ...taiwanResponse,
        result: {
          unreal_sums: {
            unreal_sum: [taiwanResponse.result.unreal_sums.unreal_sum[0]],
          },
        },
      }),
    ).toThrowError(SinotradeProtocolError);

    expect(() =>
      parseTaiwanUnrealizedResponse({
        ...taiwanResponse,
        result: {
          unreal_sums: {
            unreal_sum: [
              {
                ...taiwanResponse.result.unreal_sums.unreal_sum[0],
                ttypename: "融券",
              },
              taiwanResponse.result.unreal_sums.unreal_sum[1],
            ],
          },
        },
      }),
    ).toThrowError(SinotradeProtocolError);
  });

  it("安全解析豐存美股 inline assetDatas 並保留小數與負損益", () => {
    expect(
      parseSavingsAssetHtml(savingsUsHtml, {
        market: "US",
        currency: "USD",
      }),
    ).toEqual([
      {
        symbol: "FICT",
        name: "虛構全球",
        quantity: 0.375,
        marketValue: 150.125,
        costBasis: 153.375,
        unrealizedPnl: -3.25,
        currency: "USD",
        market: "US",
      },
    ]);
  });

  it("解析豐存台股分類，且登入頁或模型缺欄不會被當成空庫存", () => {
    expect(
      parseSavingsAssetHtml(savingsTwHtml, {
        market: "TW",
        currency: "TWD",
      }),
    ).toMatchObject([
      {
        symbol: "X001",
        quantity: 12,
        positionType: "現股",
      },
    ]);

    expect(() =>
      parseSavingsAssetHtml("<html><body>登入</body></html>", {
        market: "US",
        currency: "USD",
      }),
    ).toThrowError(SinotradeProtocolError);

    expect(() =>
      parseSavingsAssetHtml(
        savingsUsHtml.replace('"StockValue": 150.125,', ""),
        { market: "US", currency: "USD" },
      ),
    ).toThrowError(SinotradeProtocolError);
    expect(() =>
      parseSavingsAssetHtml(savingsTwHtml.replace('["0"]', '["1"]'), {
        market: "TW",
        currency: "TWD",
      }),
    ).toThrowError(SinotradeProtocolError);
    expect(() =>
      parseSavingsAssetHtml(
        savingsUsHtml.replace(
          '"NeedReCalculate": false',
          '"NeedReCalculate": true',
        ),
        { market: "US", currency: "USD" },
      ),
    ).toThrowError(SinotradeProtocolError);
  });

  it("驗證海外外層與 nested success，並從原幣欄位建立持倉", () => {
    expect(parseForeignUnrealizedResponse(foreignResponse)).toEqual([
      {
        symbol: "FICT",
        name: "虛構全球",
        quantity: 0.375,
        marketValue: 39.123,
        costBasis: 37.545,
        unrealizedPnl: 1.578,
        currency: "USD",
        market: "US",
      },
    ]);

    expect(() =>
      parseForeignUnrealizedResponse({
        ...foreignResponse,
        success: false,
      }),
    ).toThrowError(SinotradeProtocolError);

    expect(() =>
      parseForeignUnrealizedResponse({
        ...foreignResponse,
        result: {
          ...foreignResponse.result,
          status: { ...foreignResponse.result.status, success: false },
        },
      }),
    ).toThrowError(SinotradeProtocolError);
  });
});

describe("Sinotrade 交易紀錄解析", () => {
  const statementRow = (overrides: Record<string, unknown> = {}) => ({
    tdate: "20260105",
    ord_no: "A0001",
    bs: "B",
    stock: "X001",
    ttype: "1",
    qty: 10,
    price: 100,
    amt: 1000,
    fee: 1,
    tax: 0,
    payable: 1001,
    receivable: 0,
    net: 1001,
    currency: "TWD",
    market: "H",
    name_zh: "虛構科技",
    ...overrides,
  });
  const sellRow = statementRow({
    tdate: "20260110",
    ord_no: "A0002",
    bs: "S",
    stock: "0050",
    name_zh: "虛構 ETF",
    qty: 5,
    price: 120,
    amt: 600,
    fee: 1,
    tax: 2,
    payable: 0,
    receivable: 597,
    net: 597,
  });
  const statement = (
    rows: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ) => ({
    success: "True",
    result: {
      amt_sum: rows.reduce((sum, row) => sum + Number(row.amt), 0),
      payable_sum: rows.reduce((sum, row) => sum + Number(row.payable), 0),
      receivable_sum: rows.reduce(
        (sum, row) => sum + Number(row.receivable),
        0,
      ),
      data: rows,
      ...overrides,
    },
  });

  it("對帳單區間為近五年：從五年前的明天起算，請求欄位與官方頁面一致", () => {
    expect(statementDateRange("2026-11-07")).toEqual({
      start: "20211108",
      end: "20261107",
    });
    expect(statementDateRange("2028-02-29")).toEqual({
      start: "20230302",
      end: "20280229",
    });
    expect(
      taiwanStatementRequestBody(
        { brokerNo: "9999", brokerAccount: "0000001" },
        "fixture-token",
        { start: "20211108", end: "20261107" },
      ),
    ).toEqual({
      account: "0000001",
      broker_id: "9999",
      bs: "",
      currency: "",
      end_date: "20261107",
      start_date: "20211108",
      stock_id: "",
      token: "fixture-token",
      ttype: "",
    });
  });

  it("台股對帳單：買進為負的應付、賣出為正的應收，保留費稅與委託單號", () => {
    expect(
      parseTaiwanStatementResponse(statement([statementRow(), sellRow])),
    ).toEqual([
      {
        key: "2026-01-05:A0001:B:X001:10:100",
        symbol: "X001",
        name: "虛構科技",
        tradeDate: "2026-01-05",
        side: "B",
        quantity: 10,
        price: 100,
        amount: -1001,
        currency: "TWD",
        market: "TW",
        fee: 1,
        tax: 0,
        orderNo: "A0001",
      },
      {
        key: "2026-01-10:A0002:S:0050:5:120",
        symbol: "0050",
        name: "虛構 ETF",
        tradeDate: "2026-01-10",
        side: "S",
        quantity: 5,
        price: 120,
        amount: 597,
        currency: "TWD",
        market: "TW",
        fee: 1,
        tax: 2,
        orderNo: "A0002",
      },
    ]);
    // 同一天同標的同價量的重複成交各自保留。
    const twins = parseTaiwanStatementResponse(
      statement([statementRow(), statementRow()]),
    );
    expect(twins.map((trade) => trade.key)).toEqual([
      "2026-01-05:A0001:B:X001:10:100",
      "2026-01-05:A0001:B:X001:10:100#2",
    ]);
    // 區間內沒有成交，與沒有資料的回應都不是錯誤。
    expect(parseTaiwanStatementResponse(statement([]))).toEqual([]);
    expect(
      parseTaiwanStatementResponse({
        success: "True",
        result: { msg: "查無資料" },
      }),
    ).toEqual([]);
  });

  it("台股對帳單：總計不符、未知交易別、買賣欄位矛盾或日期不合法時不寫入", () => {
    const bad: unknown[] = [
      { success: "False", result: {} },
      statement([statementRow()], { amt_sum: 999 }),
      statement([statementRow()], { payable_sum: 1 }),
      statement([statementRow({ ttype: "2" })]),
      statement([statementRow({ bs: "X" })]),
      statement([statementRow({ currency: "USD" })]),
      statement([statementRow({ payable: 1001, receivable: 5 })]),
      statement([statementRow({ payable: 0 })]),
      statement([statementRow({ tdate: "20260230" })]),
      statement([statementRow({ qty: 0 })]),
      statement([statementRow({ ord_no: "" })]),
      { success: "True", result: { amt_sum: 0, data: "not-an-array" } },
    ];
    for (const payload of bad)
      expect(() => parseTaiwanStatementResponse(payload)).toThrowError(
        SinotradeProtocolError,
      );
  });

  const savingsHeaders = [
    "成交日",
    "股票名稱",
    "",
    "成交股",
    "成交均價",
    "手續費",
    "投入成本",
    "成交股 成交均價",
    "手續費 投入成本",
    "庫存別",
  ];
  const savingsRow = (overrides: Partial<Record<number, string>> = {}) =>
    [
      "2026/01/05",
      "TEST 虛構公司",
      "虛構公司",
      "1.2346",
      "10.00",
      "1.00",
      "13.35",
      "1.2346 10.00",
      "1.00 13.35",
      "定額外幣",
    ].map((cell, index) => overrides[index] ?? cell);
  const usContext = { market: "US", currency: "USD" } as const;

  it("豐存股成交頁：買進以含手續費的投入成本計為負的淨收付，保留庫存別", () => {
    expect(
      parseSavingsTransactionTable(
        { headers: savingsHeaders, rows: [savingsRow()] },
        usContext,
      ),
    ).toEqual([
      {
        key: "2026-01-05:B:TEST:1.2346:10",
        symbol: "TEST",
        name: "虛構公司",
        tradeDate: "2026-01-05",
        side: "B",
        quantity: 1.2346,
        price: 10,
        amount: -13.35,
        currency: "USD",
        market: "US",
        fee: 1,
        inventoryType: "定額外幣",
      },
    ]);
    // 沒有成交時頁面沒有表格。
    expect(parseSavingsTransactionTable(null, usContext)).toEqual([]);
  });

  it("豐存股成交頁：標題、欄位對應、賣出式的非正數量與金額不吻合時不猜測", () => {
    const rows = (...items: string[][]) => ({
      headers: savingsHeaders,
      rows: items,
    });
    const bad = [
      { headers: savingsHeaders.slice(0, 9), rows: [savingsRow()] },
      {
        headers: [
          "成交日",
          ...savingsHeaders.slice(1, 3),
          "數量",
          ...savingsHeaders.slice(4),
        ],
        rows: [savingsRow()],
      },
      rows(savingsRow().slice(0, 9)),
      rows(savingsRow({ 0: "2026-01-05" })),
      rows(savingsRow({ 2: "別的公司" })),
      rows(savingsRow({ 3: "-1.2346" })),
      rows(savingsRow({ 6: "0" })),
      rows(savingsRow({ 6: "99.00" })),
    ];
    for (const table of bad)
      expect(() => parseSavingsTransactionTable(table, usContext)).toThrowError(
        SinotradeProtocolError,
      );
    expect(() =>
      parseSavingsTransactionTable(null, { market: "US", currency: "TWD" }),
    ).toThrowError(SinotradeProtocolError);
  });
});

describe("Sinotrade 已實現損益", () => {
  const realizedRow = (overrides: Record<string, unknown> = {}) => ({
    no: "1",
    tdate: "20260110",
    dseq: "A0002",
    ttype: "0",
    ttypename: "現股",
    stock: "0050",
    stocknm: "虛構 ETF",
    cqty: "5",
    price: "120",
    bcost: "500",
    scost: "597",
    profit: "97",
    prratio: "19.40%",
    currency: "NTD",
    ...overrides,
  });
  const total = (rows: Array<Record<string, unknown>>) => ({
    no: "合計",
    cqty: String(rows.reduce((sum, row) => sum + Number(row.cqty), 0)),
    bcost: String(rows.reduce((sum, row) => sum + Number(row.bcost), 0)),
    scost: String(rows.reduce((sum, row) => sum + Number(row.scost), 0)),
    profit: String(rows.reduce((sum, row) => sum + Number(row.profit), 0)),
  });
  const realized = (rows: Array<Record<string, unknown>>) => ({
    success: "True",
    result: {
      profit_sums: { profit_sum: [...rows, total(rows)] },
      msg: "成功",
    },
  });
  const sell = (overrides: Record<string, unknown> = {}) => ({
    key: "2026-01-10:A0002:S:0050:5:120",
    symbol: "0050",
    name: "虛構 ETF",
    tradeDate: "2026-01-10",
    side: "S" as const,
    quantity: 5,
    price: 120,
    amount: 597,
    currency: "TWD" as const,
    market: "TW" as const,
    fee: 1,
    tax: 2,
    orderNo: "A0002",
    ...overrides,
  });

  it("查詢區間依賣出日期切成官方可接受的長度，沒有賣出時不查詢", () => {
    expect(realizedDateWindows([])).toEqual([]);
    expect(
      realizedDateWindows([
        "2026-03-01",
        "2025-01-10",
        "2025-01-10",
        "2025-06-01",
        "2026-02-01",
      ]),
    ).toEqual([
      { start: "20250110", end: "20250601" },
      { start: "20260201", end: "20260301" },
    ]);
    expect(
      taiwanRealizedRequestBody(
        { brokerNo: "9999", brokerAccount: "0000001" },
        "fixture-token",
        { start: "20250110", end: "20250601" },
      ),
    ).toEqual({
      action: "0",
      bdate: "20250110",
      bhno: "9999",
      cseq: "0000001",
      ctype: "A",
      edate: "20250601",
      stock: "",
      token: "fixture-token",
      ttype: "A",
    });
  });

  it("解析已實現列並驗證 profit 與合計列；沒有資料不是錯誤", () => {
    expect(parseTaiwanRealizedResponse(realized([realizedRow()]))).toEqual([
      {
        tradeDate: "2026-01-10",
        orderNo: "A0002",
        symbol: "0050",
        quantity: 5,
        price: 120,
        proceeds: 597,
        cost: 500,
        profit: 97,
      },
    ]);
    expect(
      parseTaiwanRealizedResponse({
        success: "True",
        result: { msg: "查無資料" },
      }),
    ).toEqual([]);
    const bad: unknown[] = [
      { success: "False", result: { msg: "查詢區間設限為12個月的區間" } },
      realized([realizedRow({ profit: "98" })]),
      realized([realizedRow({ ttype: "2" })]),
      realized([realizedRow({ currency: "USD" })]),
      realized([realizedRow({ tdate: "20260230" })]),
      realized([realizedRow({ dseq: "" })]),
      realized([realizedRow({ cqty: "0" })]),
      {
        success: "True",
        result: {
          profit_sums: {
            profit_sum: [
              realizedRow(),
              { ...total([realizedRow()]), profit: "1" },
            ],
          },
        },
      },
      {
        success: "True",
        result: { profit_sums: { profit_sum: [realizedRow()] } },
      },
    ];
    for (const payload of bad)
      expect(() => parseTaiwanRealizedResponse(payload)).toThrowError(
        SinotradeProtocolError,
      );
  });

  it("只在官方有正數買進成本時，把損益對到同一筆賣出", () => {
    const buy = sell({ side: "B", amount: -501, key: "buy" });
    const rows = parseTaiwanRealizedResponse(realized([realizedRow()]));
    const [bought, sold] = applyRealizedPnl([buy, sell()], rows);
    expect(bought).toEqual(buy);
    expect(sold).toMatchObject({ realizedPnl: 97, realizedCost: 500 });
    // 同一筆賣出被拆成多個成本批次時加總。
    const lots = parseTaiwanRealizedResponse(
      realized([
        realizedRow({ cqty: "2", scost: "239", bcost: "190", profit: "49" }),
        realizedRow({
          no: "2",
          cqty: "3",
          scost: "358",
          bcost: "310",
          profit: "48",
        }),
      ]),
    );
    expect(applyRealizedPnl([sell()], lots)[0]).toMatchObject({
      realizedPnl: 97,
      realizedCost: 500,
    });
  });

  it("官方沒有買進成本時 profit 只是賣出收入，不當成損益", () => {
    for (const bcost of ["0", "-20"]) {
      const rows = parseTaiwanRealizedResponse(
        realized([realizedRow({ bcost, profit: String(597 - Number(bcost)) })]),
      );
      const [sold] = applyRealizedPnl([sell()], rows);
      expect(sold).not.toHaveProperty("realizedPnl");
      expect(sold).toMatchObject({ realizedCost: Number(bcost) });
    }
    // 尚未結算的賣出沒有已實現列，維持沒有損益。
    expect(applyRealizedPnl([sell()], [])[0]).toEqual(sell());
  });

  it("已實現列對不上對帳單賣出，或數量、淨收入不一致時不寫入", () => {
    const row = (overrides: Record<string, unknown> = {}) =>
      parseTaiwanRealizedResponse(realized([realizedRow(overrides)]));
    for (const rows of [
      row({ dseq: "A9999" }),
      row({ cqty: "4", scost: "597" }),
      row({ scost: "596", profit: "96" }),
    ])
      expect(() => applyRealizedPnl([sell()], rows)).toThrowError(
        SinotradeProtocolError,
      );
    expect(() => applyRealizedPnl([], row())).toThrowError(
      SinotradeProtocolError,
    );
    // 同委託單同價有兩筆賣出時無法分配損益，不猜測。
    const twins = [sell(), sell({ key: "twin#2" })];
    expect(
      applyRealizedPnl(twins, row()).map((trade) => trade.realizedPnl),
    ).toEqual([undefined, undefined]);
  });
});
