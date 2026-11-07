import { describe, it, expect } from "vitest";
import {
  isSinotradeCookie,
  isSinotradeLoginUrl,
  parseSinotradeAccounts,
  parseSavingsAccountIdentities,
  describeSinotradeSession,
  restorableSinotradeState,
  selectSinotradeStorage,
} from "../../../src/sources/sinotrade/session-protocol";

describe("證券官方網頁認證邊界", () => {
  it("頁內登入只允許官方 HTTPS 登入及憑證頁，拒絕帳務、交易與假域名", () => {
    const allowed = [
      "https://www.sinotrade.com.tw/newweb/SinoTrade_login/",
      "https://www.sinotrade.com.tw/signature/webcaFrm.html",
      "https://ca.sinotrade.com.tw/WebCA/WebCA",
      "https://aiinvest.sinotrade.com.tw/Login",
      "https://aiinvest.sinotrade.com.tw/Content/CA/webcaFrm.html",
      "https://ca.sinotrade.com.tw/WebCAEx/WebCA",
    ];
    const denied = [
      "https://www.sinotrade.com.tw/newweb/tradingAccount/StockV3/?type=inventory",
      "https://www.sinotrade.com.tw/newweb/tradingAccount/AbroadV3/?type=inventory",
      "https://aiinvest.sinotrade.com.tw/Account/Asset",
      "https://aiinvest.sinotrade.com.tw/Stock/List/US",
      "https://www.sinotrade.com.tw.evil.invalid/newweb/SinoTrade_login/",
      "https://evil.sinotrade.com.tw/Login",
      "https://aiinvest.sinotrade.com.tw@evil.invalid/Login",
      "https://ca.sinotrade.com.tw.evil.invalid/WebCAEx/WebCA",
      "https://ca.sinotrade.com.tw:8443/WebCAEx/WebCA",
      "http://www.sinotrade.com.tw/newweb/SinoTrade_login/",
      "http://aiinvest.sinotrade.com.tw/Login",
      "http://ca.sinotrade.com.tw/WebCAEx/WebCA",
    ];

    for (const url of allowed) expect(isSinotradeLoginUrl(url), url).toBe(true);
    for (const url of denied) expect(isSinotradeLoginUrl(url), url).toBe(false);
  });

  it("只有未到期的短效 session 才回報等待驗證，缺少期限不視為有效", () => {
    const now = Date.now();
    const pending = {
      browserSessionId: "fixture-browser",
      loginPlatform: "newweb",
    };
    for (const browserSessionExpiresAt of [
      undefined,
      new Date(now - 1_000).toISOString(),
      new Date(now).toISOString(),
    ]) {
      expect(
        describeSinotradeSession({ ...pending, browserSessionExpiresAt }),
      ).toMatchObject({ sessionAvailable: false, verificationPending: false });
    }
    expect(
      describeSinotradeSession({
        ...pending,
        browserSessionExpiresAt: new Date(now + 300_000).toISOString(),
      }),
    ).toMatchObject({ sessionAvailable: false, verificationPending: true });
  });

  it("曾保存的認證確認失效後不再回報完整可同步，憑證仍可供後續登入復用", () => {
    const state = {
      cookies: [],
      localStorage: { TWCA123: "fixture-certificate" },
      capturedAt: "2027-01-01T00:00:00.000Z",
    };
    expect(
      describeSinotradeSession({
        webState: {
          newweb: state,
          savings: { ...state, authenticated: false },
        },
      }),
    ).toMatchObject({
      sessionAvailable: false,
      sinotradePlatforms: { newweb: true, savings: false },
    });
  });
  it("只保存選定 origin 的登入與索引指定憑證，不複製整份 storage", () => {
    const storage = {
      newweb_token: "fixture-token",
      acnts: "[]",
      TWCACertIdxRef: JSON.stringify({ TWCA123: {} }),
      TWCA123: "fixture-private-certificate",
      TWCA999: "unreferenced",
      marketing: "tracking",
      password: "not-selected",
    };
    expect(selectSinotradeStorage("newweb", storage)).toEqual({
      newweb_token: storage.newweb_token,
      acnts: "[]",
      TWCACertIdxRef: storage.TWCACertIdxRef,
      TWCA123: storage.TWCA123,
    });
    expect(selectSinotradeStorage("savings", storage)).toEqual({
      TWCACertIdxRef: storage.TWCACertIdxRef,
      TWCA123: storage.TWCA123,
    });
    expect(
      isSinotradeCookie("savings", {
        name: "aiinvest",
        domain: "aiinvest.sinotrade.com.tw",
      }),
    ).toBe(true);
    expect(
      isSinotradeCookie("newweb", {
        name: "aiinvest",
        domain: "aiinvest.sinotrade.com.tw",
      }),
    ).toBe(false);
    expect(
      isSinotradeCookie("savings", {
        name: "aiinvest",
        domain: "evil.sinotrade.com.tw",
      }),
    ).toBe(false);
    expect(
      isSinotradeCookie("savings", {
        name: "_ga",
        domain: ".sinotrade.com.tw",
      }),
    ).toBe(false);
    expect(() =>
      selectSinotradeStorage("newweb", {
        TWCACertIdxRef: JSON.stringify({ password: {} }),
        password: "fixture-secret",
      }),
    ).toThrow(/憑證/);
  });
  it("同一張憑證用於兩個平台：沒有自己憑證的平台從另一個平台還原，不重新簽發", () => {
    const certificate = {
      TWCACertIdxRef: JSON.stringify({ TWCA1: {} }),
      TWCA1: "fixture-certificate",
    };
    const newweb = {
      authenticated: true,
      cookies: [],
      localStorage: { newweb_token: "fixture-token", ...certificate },
      capturedAt: "2027-01-01T00:00:00.000Z",
    };
    // A platform that never saved anything gets only the certificate, not the other's login.
    expect(restorableSinotradeState({ newweb }, "savings")).toEqual({
      authenticated: false,
      cookies: [],
      localStorage: certificate,
      capturedAt: newweb.capturedAt,
    });
    // Its own certificate always wins, and no certificate anywhere restores nothing.
    const savings = { ...newweb, localStorage: { ...certificate } };
    expect(restorableSinotradeState({ newweb, savings }, "savings")).toBe(
      savings,
    );
    expect(restorableSinotradeState({ newweb }, "newweb")).toBe(newweb);
    expect(
      restorableSinotradeState(
        { newweb: { ...newweb, localStorage: {} } },
        "savings",
      ),
    ).toBeUndefined();
    expect(restorableSinotradeState(undefined, "savings")).toBeUndefined();
  });
  it("帳戶明確指定市場，缺少帳戶結構不當成零持倉", () => {
    expect(
      parseSavingsAccountIdentities({
        Data: {
          ActsData: [
            { AccType: "S", Broker: "Z999", Act: "0000001" },
            { AccType: "H", Broker: "Z999", Act: "0000002" },
            { AccType: "F", Broker: "Z999", Act: "0000003" },
          ],
        },
      }),
    ).toEqual([
      { brokerNo: "Z999", brokerAccount: "0000001", market: "TW" },
      { brokerNo: "Z999", brokerAccount: "0000002", market: "US" },
    ]);
    expect(() =>
      parseSavingsAccountIdentities({
        Data: { ActsData: [{ AccType: "S", Act: "0000001" }] },
      }),
    ).toThrow(/帳戶資料/);
    expect(
      parseSinotradeAccounts([
        { broker_id: "9999", account: "0000001", accttype: "S" },
        { broker_id: "9999", account: "0000002", accttype: "H" },
      ]),
    ).toEqual([
      { brokerNo: "9999", brokerAccount: "0000001", market: "TW" },
      { brokerNo: "9999", brokerAccount: "0000002", market: "US" },
    ]);
    expect(() => parseSinotradeAccounts([])).toThrow();
    expect(() =>
      parseSinotradeAccounts([{ account: "missing-broker", accttype: "S" }]),
    ).toThrow();
  });
});
