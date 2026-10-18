import { describe, expect, it } from "vitest";
import { scrapeCreditCards } from "../../../src/sources/cathaybk/connector";

type FakeRequest = {
  method: () => string;
  url: () => string;
};

type FakeResponse = {
  request: () => FakeRequest;
  status: () => number;
  json: () => Promise<unknown>;
};

type ResponseWaiter = {
  predicate: (response: FakeResponse) => boolean;
  resolve: (response: FakeResponse) => void;
};

const api = (content: unknown) => ({
  success: true,
  returnCode: "0000",
  content,
});

function createCardPage() {
  const listeners = new Map<string, Set<(request: FakeRequest) => void>>();
  const waiters: ResponseWaiter[] = [];
  let currentUrl = "https://www.cathaybk.com.tw/MyBank/";
  const overviewText = [
    "卡片末四碼: 1234",
    "國泰卡 VISA",
    "永久信用額度 TWD 100,000",
    "剩餘可用額度 TWD 90,000",
    "繳款截止日 2026/10/25",
    "臺幣帳單 TWD 1,234",
  ].join("\n");
  const apiResult = {
    recentBillInfo: api({
      recentBillDate: "2026-09-20",
      twBillInfo: { unPaidAmount: 200, paidAmount: 800 },
    }),
    billInfo: api({
      currencyBillInfoList: [
        {
          currency: "TWD",
          currencyDataType: "TWD",
          currentMinPaymentAmount: 100,
        },
      ],
    }),
    allBills: [
      {
        billDate: "2026-09-20",
        twdAmount: 900,
        usdAmount: null,
        billStatus: "history-copy",
      },
      {
        billDate: "2026-08-20",
        twdAmount: 700,
        usdAmount: null,
        billStatus: "old-history",
      },
    ],
    monthDetails: [],
  };

  const emitResponse = (apiName: string, payload: unknown) => {
    const request: FakeRequest = {
      method: () => "POST",
      url: () =>
        `https://www.cathaybk.com.tw/OnlineBankingApi/ClientCard/Api/ClientCard/${apiName}`,
    };
    for (const listener of listeners.get("request") ?? []) listener(request);
    const response: FakeResponse = {
      request: () => request,
      status: () => 200,
      json: async () => payload,
    };
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (!waiter.predicate(response)) continue;
      waiters.splice(index, 1);
      waiter.resolve(response);
    }
  };

  const page = {
    on(event: string, listener: (request: FakeRequest) => void) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return page;
    },
    off(event: string, listener: (request: FakeRequest) => void) {
      listeners.get(event)?.delete(listener);
      return page;
    },
    async goto(url: string) {
      currentUrl = url;
      if (!url.includes("C0101_BillOverview")) return null;
      emitResponse("C_COM_Q_CardStatus", {
        returnCode: "0000",
        content: { cardStatus: "Valid" },
      });
      emitResponse(
        "C_CardInfo_Q_LatestBill",
        api({
          dueDate: "2026-10-05",
          twdBillDetail: { payBillStatus: "Unmapped" },
        }),
      );
      return null;
    },
    async waitForResponse(predicate: (response: FakeResponse) => boolean) {
      return await new Promise<FakeResponse>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
    async waitForFunction() {
      return true;
    },
    async evaluate(...args: unknown[]) {
      return args.length === 1 ? overviewText : apiResult;
    },
    url() {
      return currentUrl;
    },
  };

  return page as unknown as Parameters<typeof scrapeCreditCards>[0];
}

describe("國泰信用卡 scrape 的帳單來源隔離", () => {
  it("擷取 C0101 最新帳單期限；總覽期限只進快照，舊歷史列沒有狀態或期限", async () => {
    const result = await scrapeCreditCards(createCardPage());

    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      balance: -1234,
      paymentDueDate: "2026-10-25",
      noPaymentNeeded: false,
    });
    expect(result.creditCardBills).toHaveLength(2);
    expect(result.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-09",
      statementAmount: 1000,
      minimumPayment: 100,
      isPaid: false,
      paymentDueDate: "2026-10-05",
      statementClosingDate: "2026-09-20",
    });
    expect(result.creditCardBills[1]).toMatchObject({
      billingPeriod: "2026-08",
      statementAmount: 700,
    });
    expect(result.creditCardBills[1].isPaid).toBeUndefined();
    expect(result.creditCardBills[1].paymentDueDate).toBeUndefined();
  });
});
