// 合成資料：兆豐銀行 parser／mobile API 測試共用（帳號、卡號皆為假值）。
import type { MegabankPayloads } from "../../../../src/sources/megabank/protocol";

export const credentials = {
  userId: "A123456789",
  account: "SYNTHETIC",
  password: "synthetic-only",
};
export const depositAccountNo = "0000000000012345";
export const cardNo = "0000000000006789";
export const payloads: MegabankPayloads = {
  deposits: {
    rsData: {
      depositInfoList: [
        { DRACT: depositAccountNo, DRCUR: "TWD", AVLBA: "1,000", NAME: "活存" },
        { DRACT: depositAccountNo, DRCUR: "TWD", AVLBA: "200", NAME: "活存" },
      ],
    },
  },
  depositTransactions: [
    {
      accountNo: depositAccountNo,
      currency: "TWD",
      response: {
        rsData: {
          list: [
            {
              txDate: "2026-09-20",
              serialNo: "S1",
              seq: "1",
              DRCR: "D",
              amount: "250",
              paymentItem: "轉出",
            },
            {
              txDate: "2026-09-21",
              serialNo: "S2",
              seq: "2",
              DRCR: "C",
              amount: "100",
              paymentItem: "入帳",
            },
          ],
        },
      },
    },
  ],
  cardOverview: {
    rsData: {
      creditCardBillInfoList: [
        {
          ACCT_TYPE: "01",
          ACCT_MON: "202609",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "1000",
          PAYMENT_AMT: "200",
        },
        {
          ACCT_TYPE: "01",
          ACCT_MON: "202608",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "900",
          PAYMENT_AMT: "0",
        },
        {
          ACCT_TYPE: "01",
          ACCT_MON: "999912",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "300",
          PAYMENT_AMT: "0",
        },
        {
          ACCT_TYPE: "05",
          ACCT_MON: "202609",
          CURR_CODE: "TWD",
          THIS_TTL_AMT: "200",
          PAYMENT_AMT: "0",
        },
      ],
    },
  },
  cardBills: {
    rsData: {
      generalRecordList: [
        {
          acctMon: "202609",
          currCode: "TWD",
          thisTtlAmt: "1000",
          minPay: "100",
          thisPayAmt: "200",
          lastpayDate: "2026/10/15",
        },
      ],
      fancyRecordList: [
        {
          acctMon: "202609",
          currCode: "TWD",
          thisTtlAmt: "200",
          minPay: "20",
          thisPayAmt: "0",
          lastpayDate: "2026/10/15",
        },
      ],
      ridoRecordList: [
        {
          acctMon: "999912",
          currCode: "TWD",
          thisTtlAmt: "300",
          minPay: "0",
          thisPayAmt: "0",
        },
      ],
    },
  },
  cardHome: { rsData: { cardNumbers: [{ cardNo, cardName: "測試卡" }] } },
  cardTransactions: {
    rsData: {
      detailList: [
        {
          cardNo,
          detailList: [
            {
              cardNo,
              purchaseDate: "2026/09/23",
              merchantChiName: "測試商店",
              sourceAmt: "300",
              sourceCurr: "TWD",
              destinationAmt: "300",
              destinationCurr: "TWD",
              acctMon: "999912",
            },
            {
              cardNo,
              purchaseDate: "2026/09/24",
              merchantChiName: "測試商店退款",
              sourceAmt: "50",
              sourceCurr: "TWD",
              destinationAmt: "50",
              destinationCurr: "TWD",
              acctMon: "202609",
            },
          ],
        },
      ],
    },
  },
};
