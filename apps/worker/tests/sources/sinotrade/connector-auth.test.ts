import { describe, expect, it, vi } from "vitest";
import type { Page } from "@cloudflare/puppeteer";
import {
  querySinotradeSavings,
  querySinotradeSavingsTrades,
  readSinotradeNewwebSession,
  readSinotradeSavingsOverview,
} from "../../../src/sources/sinotrade/connector";
import {
  SINOTRADE_ORIGINS,
  SinotradeAuthenticationRequiredError,
  SinotradeConnectionError,
  isSinotradeAuthenticationRequiredError,
} from "../../../src/sources/sinotrade/session-protocol";

const account = {
  brokerNo: "9999",
  brokerAccount: "0000001",
  market: "TW" as const,
};

function response(status: number, payload: unknown = {}) {
  return {
    url: () => `${SINOTRADE_ORIGINS.savings}/API_Account/GetOverviewData`,
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: vi.fn().mockResolvedValue(payload),
  };
}

function overviewPage(options?: {
  afterGoto?: string;
  navigationStatus?: number;
  responseStatus?: number;
}) {
  let currentUrl =
    options?.afterGoto ?? `${SINOTRADE_ORIGINS.savings}/Account/Overview`;
  const networkResponse = response(options?.responseStatus ?? 200, {
    Data: {
      ActsData: [
        {
          AccType: "S",
          Broker: account.brokerNo,
          Act: account.brokerAccount,
        },
      ],
    },
  });
  const page = {
    url: () => currentUrl,
    waitForResponse: vi.fn(async (predicate: (value: unknown) => boolean) => {
      if (!predicate(networkResponse)) throw new Error("unexpected response");
      return networkResponse;
    }),
    goto: vi.fn(async () => {
      currentUrl = options?.afterGoto ?? currentUrl;
      return { status: () => options?.navigationStatus ?? 200 };
    }),
    $: vi.fn().mockResolvedValue({}),
  } as unknown as Page;
  return page;
}

describe("永豐證券登入恢復與豐存股 origin 邊界", () => {
  it("豐存股成交紀錄：拒絕錯誤 origin，非成交頁或查詢失敗不當成沒有交易，401 視為未登入", async () => {
    const wrongOrigin = {
      url: () => "https://evil.invalid/Account/Overview",
      evaluate: vi.fn(),
    } as unknown as Page;
    await expect(
      querySinotradeSavingsTrades(
        wrongOrigin,
        account,
        "2000/01/01 ~ 2027/01/01",
      ),
    ).rejects.toThrow(/origin 不符/);
    expect(wrongOrigin.evaluate).not.toHaveBeenCalled();

    const pageWith = (result: unknown) =>
      ({
        url: () => `${SINOTRADE_ORIGINS.savings}/Account/Overview`,
        evaluate: vi.fn().mockResolvedValue(result),
      }) as unknown as Page;
    const range = "2000/01/01 ~ 2027/01/01";
    // 頁面可辨識但沒有成交表格：沒有交易，不是錯誤。
    const empty = pageWith({ status: 200, recognized: true, table: null });
    await expect(
      querySinotradeSavingsTrades(empty, account, range),
    ).resolves.toEqual([]);
    expect(empty.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      accountValue: account.brokerAccount,
      expectedOrigin: SINOTRADE_ORIGINS.savings,
      url: `${SINOTRADE_ORIGINS.savings}/Account/Transaction`,
      dateRange: range,
    });
    for (const result of [
      { status: 200, recognized: false, table: null },
      { status: 0 },
      { status: 500 },
    ])
      await expect(
        querySinotradeSavingsTrades(pageWith(result), account, range),
      ).rejects.toThrow(/成交紀錄查詢失敗/);
    await expect(
      querySinotradeSavingsTrades(pageWith({ status: 401 }), account, range),
    ).rejects.toBeInstanceOf(SinotradeAuthenticationRequiredError);
  });

  it("只有明確未登入錯誤才允許跨平台重新提交帳密", () => {
    expect(
      isSinotradeAuthenticationRequiredError(
        new SinotradeAuthenticationRequiredError(),
      ),
    ).toBe(true);
    expect(
      isSinotradeAuthenticationRequiredError(
        new SinotradeConnectionError("回應格式錯誤"),
      ),
    ).toBe(false);
    expect(isSinotradeAuthenticationRequiredError(new Error())).toBe(false);
  });

  it("新理財網沒有 token 視為未登入，帳戶資料格式錯誤則停止", async () => {
    const noToken = {
      evaluate: vi.fn().mockResolvedValue({ token: null, accounts: null }),
    } as unknown as Page;
    await expect(readSinotradeNewwebSession(noToken)).rejects.toBeInstanceOf(
      SinotradeAuthenticationRequiredError,
    );

    const malformed = {
      evaluate: vi.fn().mockResolvedValue({
        token: "fixture-token",
        accounts: "not-json",
      }),
    } as unknown as Page;
    await expect(readSinotradeNewwebSession(malformed)).rejects.toBeInstanceOf(
      SinotradeConnectionError,
    );
    await expect(
      readSinotradeNewwebSession(malformed),
    ).rejects.not.toBeInstanceOf(SinotradeAuthenticationRequiredError);
  });

  it("豐存股導向登入頁或 HTTP 401 才視為未登入，其他 HTTP 錯誤不重送帳密", async () => {
    await expect(
      readSinotradeSavingsOverview(
        overviewPage({ afterGoto: `${SINOTRADE_ORIGINS.savings}/Login` }),
      ),
    ).rejects.toBeInstanceOf(SinotradeAuthenticationRequiredError);

    await expect(
      readSinotradeSavingsOverview(overviewPage({ responseStatus: 401 })),
    ).rejects.toBeInstanceOf(SinotradeAuthenticationRequiredError);

    await expect(
      readSinotradeSavingsOverview(overviewPage({ responseStatus: 500 })),
    ).rejects.toBeInstanceOf(SinotradeConnectionError);
    await expect(
      readSinotradeSavingsOverview(overviewPage({ responseStatus: 500 })),
    ).rejects.not.toBeInstanceOf(SinotradeAuthenticationRequiredError);
  });

  it("豐存股查詢拒絕錯誤 origin，並傳入固定絕對 Asset URL", async () => {
    const wrongOrigin = {
      url: () => "https://evil.invalid/Account/Overview",
      $$eval: vi.fn(),
      evaluate: vi.fn(),
    } as unknown as Page;
    await expect(querySinotradeSavings(wrongOrigin, account)).rejects.toThrow(
      /origin 不符/,
    );
    expect(wrongOrigin.$$eval).not.toHaveBeenCalled();
    expect(wrongOrigin.evaluate).not.toHaveBeenCalled();

    const evaluate = vi.fn().mockResolvedValue({ status: 200, html: null });
    const page = {
      url: () => `${SINOTRADE_ORIGINS.savings}/Account/Overview`,
      $$eval: vi
        .fn()
        .mockResolvedValue([{ value: account.brokerAccount, label: "台股" }]),
      evaluate,
    } as unknown as Page;
    await expect(querySinotradeSavings(page, account)).rejects.toThrow(
      /庫存查詢失敗/,
    );
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      accountValue: account.brokerAccount,
      expectedOrigin: SINOTRADE_ORIGINS.savings,
      url: `${SINOTRADE_ORIGINS.savings}/Account/Asset`,
    });
  });
});
