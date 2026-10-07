// 合成資料；不是登入後的真實帳務。欄位與金額方向來自 2026-10-07 官方
// RWD RB0100/0101/0102、RB0800/0802、RB0708 的表格與查詢程式。
// RB0101 balance 是帳戶餘額，availbalance 是可用餘額；dtltamt 是定存，不能加總。
// RB0102 txnamtOut 非 '-' 為支出；RB0802 DRWAMT 為支出、DEPAMT 為存入。
// RB0708 即時列[3]為新臺幣授權金額、[5]須等於成功、[6]為顯示店名。
// qryUnposted showRB0712_SUBTOTAL 為新臺幣未出帳合計，含退款但不含繳款。
export const TWD_ACCOUNT = "0".repeat(8) + "1234";
export const FX_ACCOUNT = "0".repeat(8) + "5678";
export const bankNow = new Date("2026-10-06T16:30:00Z");
export const twdOverview = {
  RESULT: "NORMAL",
  OUTPUTDATA: {
    SavingAccount: [
      { accountNo: TWD_ACCOUNT, accountTypeName: "綜合存款", balance: "2,000" },
    ],
    depositTotalBalance: "10,000",
  },
};
export const twdBalance = {
  RESULT: "NORMAL",
  OUTPUTDATA: { balance: "2,000", availbalance: "1,800", dtltamt: "10,000" },
};
export const fxOverview = {
  error: null,
  data: {
    FCS_ACCOUNT: [
      {
        ACCOUNT_NO: FX_ACCOUNT,
        ACCOUNT_NAME: "外幣綜存",
        FCS_ACCOUNT_DETAIL: [
          {
            ACCOUNT_NO: FX_ACCOUNT,
            CURRENCY_CODE: "USD",
            BALANCE: "125.25",
            TIME_DESPOSIT: "500",
            ALL_BALANCE: "625.25",
          },
          {
            ACCOUNT_NO: FX_ACCOUNT,
            CURRENCY_CODE: "JPY",
            BALANCE: "0",
            TIME_DESPOSIT: "1000",
            ALL_BALANCE: "1000",
          },
        ],
      },
    ],
  },
};
export const twdTransactions = {
  RESULT: "NORMAL",
  OUTPUTDATA: {
    inNo: 1,
    outNo: 2,
    userList: [
      {
        sysdate: "20261005 09150000",
        dateNew: "20261006",
        txnamt: "200",
        txnamtIn: "-",
        txnamtOut: "200",
        newbal: "1800",
        memo: "轉帳支出",
        message: TWD_ACCOUNT,
        procSeq: "1",
      },
      {
        sysdate: "20261005 09160000",
        dateNew: "20261006",
        txnamt: "200",
        txnamtIn: "-",
        txnamtOut: "200",
        newbal: "1600",
        memo: "轉帳支出",
        message: "",
        procSeq: "2",
      },
      {
        sysdate: "20261004",
        dateNew: "20261005",
        txnamt: "1,000",
        txnamtIn: "1000",
        txnamtOut: "-",
        newbal: "2000",
        memo: "薪資",
        message: "",
        procSeq: "3",
      },
    ],
  },
};
export const fxTransactions = {
  error: null,
  data: {
    TRANS_DETAILS: [
      {
        TRANSACTION_DATE_TIME: "20261005093000",
        TRANSACTION_DATE_TIME_DSC: "2026/10/05 09:30:00",
        TX_DATE: "2026/10/06",
        CCY_CODE: "USD",
        DRWAMT: "12.50",
        DEPAMT: "-",
        ACCT_BAL: "112.75",
        REMARKS: "換匯",
      },
      {
        TRANSACTION_DATE_TIME: "20261004",
        TRANSACTION_DATE_TIME_DSC: "2026/10/04",
        TX_DATE: "2026/10/05",
        CCY_CODE: "USD",
        DRWAMT: "-",
        DEPAMT: "20.25",
        ACCT_BAL: "125.25",
        REMARKS: "存入",
      },
    ],
  },
};
export const emptyRealtime = { error: null, value: { fmtRealTxListMap: [] } };
export const emptyUnbilled = { error: null, value: { unpostedTx: {} } };
export const realtime = {
  error: null,
  value: {
    fmtRealTxListMap: [
      {
        cardname: "測試信用卡 ****1234",
        txlist: [
          [
            "2026/10/05",
            "09:15:30",
            "DEMO SHOP",
            '<font color="red" >252</font>',
            "TW",
            "成功",
            "DEMO SHOP TAIPEI",
          ],
          ["2026/10/05", "09:15:31", "OTHER", "900", "TW", "未成功", "OTHER"],
          ["2026/10/05", "09:15:32", "OTHER", "900", "TW", "拒絕", "OTHER"],
        ],
      },
    ],
  },
};
export const unbilled = {
  error: null,
  value: {
    showRB0712_SUBTOTAL: "252",
    unpostedTx: {
      "001TWD": {
        data: [
          {
            cardname: "測試信用卡 ****1234",
            txlist: [
              [
                "2026/10/05",
                "2026/10/06",
                "DEMO SHOP TAIPEI",
                "252",
                "",
                "TW",
                "",
                "TWD",
              ],
            ],
          },
        ],
      },
    },
  },
};
export const bill = {
  error: null,
  value: {
    showAccoutnYM: "2026/10",
    showCbalance: "1000",
    showDueDate: "2026/10/25",
    showStmtDate: "2026/10/10",
    newAcctDetailList: [
      {
        order: "測試信用卡 ****1234",
        detail: [
          {
            showOutTXNDate: "2026/10/05",
            showOutPostDate: "2026/10/06",
            showOutDesc: "DEMO SHOP TAIPEI",
            showOutAmt: "252",
            showOutCurrency: "TWD",
            showOutCountry: "TW",
          },
        ],
      },
    ],
  },
};

export async function depositRequest(
  path: string,
  body: Record<string, unknown> | string,
): Promise<unknown> {
  const input = typeof body === "string" ? {} : body;
  if (path.endsWith("/rb0100/query")) return structuredClone(twdOverview);
  if (path.endsWith("/rb0101/query")) return structuredClone(twdBalance);
  if (path.endsWith("/rb0102/listaccount"))
    return {
      RESULT: "NORMAL",
      OUTPUTDATA: [{ value: TWD_ACCOUNT, text: "綜存" }],
    };
  if (path.endsWith("/rb0102/query")) return structuredClone(twdTransactions);
  if (path.endsWith("/getRB08000100Data")) return structuredClone(fxOverview);
  if (path.endsWith("/getRB08000100QueryRealtimeBalance"))
    return {
      error: null,
      data: [
        {
          ACCT_NO: FX_ACCOUNT,
          CURRENCY_CODE: input.requestCcyCode,
          BALANCE: input.requestCcyCode === "USD" ? "125.25" : "0",
        },
      ],
    };
  if (path.endsWith("/getRB08120100Options"))
    return {
      error: null,
      data: { ACCOUNT_OPTION: [{ value: FX_ACCOUNT }], RB0802_ORDER_TYPE: "0" },
    };
  if (path.endsWith("/getRB08020100ForeignTranDetail"))
    return input.requestCurrency === "USD"
      ? structuredClone(fxTransactions)
      : { error: null, data: { TRANS_DETAILS: [] } };
  throw new Error("fixture 未定義的存款查詢");
}
