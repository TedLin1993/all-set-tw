import { afterEach, describe, expect, it, vi } from "vitest";
import { parseKgibankData } from "@taiwan-fin-hub/connectors";
import {
  classifyKgibankLoginText,
  classifyKgibankTokenResponse,
  createKgibankConnector,
  kgibankCaptchaDataUrl,
  KgibankVerificationRequiredError,
  parseCaptchaDataUrl,
  syncDateRange,
} from "../../src/connectors/kgibank";

const ACCOUNT_NO = "00012345678901";

afterEach(() => vi.unstubAllGlobals());

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    payeeAcctNo: null,
    txnDateTime: "2026-09-14T16:11:02+08:00",
    txnTypeName: "轉帳",
    txnAmt: 904,
    effectDateTime: "2026-09-14T00:00:00+08:00",
    acctBal: 39268,
    desc: "定期定額",
    exRate: null,
    recNo: "999998818",
    ...overrides,
  };
}

function payloads(items: unknown[]) {
  return {
    accountsResponse: {
      items: [
        {
          acctBal: 29268,
          availBal: 29000,
          acctStatus: 0,
          acctNo: ACCOUNT_NO,
          acctTypeName: "活期儲蓄存款",
          acctNickName: "",
        },
      ],
    },
    transactionResponses: [{ accountNo: ACCOUNT_NO, response: { items } }],
  };
}

describe("KGI Bank connector parser", () => {
  it("parses demand deposit accounts and balance snapshots", () => {
    const data = parseKgibankData(
      payloads([]),
      new Date("2026-09-23T03:00:00.000Z"),
    );
    expect(data.bankAccounts).toEqual([
      expect.objectContaining({
        sourceId: `bank:kgibank:${ACCOUNT_NO}:TWD`,
        institutionName: "凱基銀行",
        accountName: "活期儲蓄存款 末四碼 8901",
        accountType: "savings",
        currency: "TWD",
      }),
    ]);
    expect(data.bankBalanceSnapshots).toEqual([
      expect.objectContaining({
        accountId: `bank:kgibank:${ACCOUNT_NO}:TWD`,
        balance: 29268,
        availableBalance: 29000,
        asOfAt: "2026-09-23T03:00:00.000Z",
      }),
    ]);
  });

  it("keeps signed amounts, source time and posted date", () => {
    const data = parseKgibankData(
      payloads([
        transaction({ txnAmt: -10000, acctBal: 29268 }),
        transaction({ txnAmt: 5, desc: "", txnTypeName: "利息" }),
      ]),
    );
    expect(data.bankTransactions).toEqual([
      expect.objectContaining({
        accountId: `bank:kgibank:${ACCOUNT_NO}:TWD`,
        amount: -10000,
        authorizedAt: "2026-09-14T16:11:02+08:00",
        postedDate: "2026-09-14",
        description: "定期定額",
        status: "posted",
      }),
      expect.objectContaining({ amount: 5, description: "利息" }),
    ]);
  });

  it("produces stable source ids across repeated and fractional-second responses", () => {
    const first = parseKgibankData(
      payloads([transaction({ txnDateTime: "2026-08-13T16:06:50+08:00" })]),
    );
    const second = parseKgibankData(
      payloads([
        transaction({ txnDateTime: "2026-08-13T16:06:50.43+08:00" }),
        transaction({ txnDateTime: "2026-09-01T08:13:09+08:00" }),
      ]),
    );
    expect(second.bankTransactions[0]?.sourceId).toBe(
      first.bankTransactions[0]?.sourceId,
    );
    expect(second.bankTransactions[1]?.sourceId).not.toBe(
      first.bankTransactions[0]?.sourceId,
    );
  });

  it("does not keep full account numbers in raw payloads", () => {
    const data = parseKgibankData(payloads([transaction()]));
    const raw = JSON.stringify([
      ...data.bankAccounts.map((account) => account.raw),
      ...data.bankTransactions.map((item) => item.raw),
    ]);
    expect(raw).not.toContain(ACCOUNT_NO);
    expect(raw).toContain("8901");
  });

  it("rejects transactions without time or amount", () => {
    expect(() =>
      parseKgibankData(payloads([transaction({ txnAmt: null })])),
    ).toThrow("凱基交易明細缺少交易時間或金額");
  });

  it("rejects unrecognized response shapes", () => {
    expect(() =>
      parseKgibankData({ accountsResponse: {}, transactionResponses: [] }),
    ).toThrow("AcctQuery");
  });
});

describe("KGI Bank login classification", () => {
  it("treats password and user id errors as credential failures", () => {
    expect(classifyKgibankLoginText("密碼錯誤，請再試試看（剩餘 2 次）")).toBe(
      "credential",
    );
    expect(
      classifyKgibankLoginText("使用者代號錯誤，請再試試看（剩餘 1 次）"),
    ).toBe("credential");
  });

  it("treats captcha messages as captcha failures", () => {
    expect(classifyKgibankLoginText("驗證碼有誤，請重新填寫")).toBe("captcha");
    expect(classifyKgibankLoginText("驗證碼已逾期，請點選重新發送")).toBe(
      "captcha",
    );
  });

  it("does not classify unrelated page text", () => {
    expect(classifyKgibankLoginText("歡迎使用凱基網路銀行")).toBe("unknown");
  });

  it.each([
    [400, { error: "invalid_grant" }],
    [401, { message: "使用者代號錯誤" }],
  ])(
    "treats an explicit token credential rejection as credential",
    (status, body) => {
      expect(classifyKgibankTokenResponse(status, body)).toBe("credential");
    },
  );

  it.each([
    [400, { error: "temporarily_unavailable" }],
    [429, { error: "invalid_grant" }],
    [500, { message: "upstream unavailable" }],
    [503, undefined],
  ])(
    "does not report a non-credential token failure as bad credentials",
    (status, body) => {
      expect(classifyKgibankTokenResponse(status, body)).toBe("unknown");
    },
  );
});

describe("KGI Bank sync window", () => {
  it("covers the last three months in Taipei time", () => {
    expect(syncDateRange(new Date("2026-09-23T03:00:00.000Z"))).toEqual({
      startDate: "2026-06-23T00:00:00.000+08:00",
      endDate: "2026-09-23T23:59:59.999+08:00",
    });
  });

  it("uses the Taipei calendar date near midnight UTC", () => {
    expect(syncDateRange(new Date("2026-09-22T17:30:00.000Z")).endDate).toBe(
      "2026-09-23T23:59:59.999+08:00",
    );
  });
});

describe("KGI Bank sync preconditions", () => {
  const credentials = {
    userId: "A123456789",
    account: "user01",
    password: "password",
  };
  const fetcher = {} as Fetcher;

  it("requires an OCR recognizer or a user-entered captcha before opening a browser", async () => {
    await expect(
      createKgibankConnector(fetcher).sync(credentials),
    ).rejects.toBeInstanceOf(KgibankVerificationRequiredError);
  });

  it("rejects an expired captcha session", async () => {
    await expect(
      createKgibankConnector(fetcher).sync({
        ...credentials,
        browserSessionId: "session",
        browserSessionExpiresAt: "2020-01-01T00:00:00.000Z",
        captcha: "123456",
      }),
    ).rejects.toThrow("逾時");
  });

  it("requires credentials", async () => {
    await expect(
      createKgibankConnector(fetcher).sync({ captcha: "123456" }),
    ).rejects.toThrow("請填寫身分證字號");
  });
});

describe("KGI Bank captcha image", () => {
  function stubCaptchaDocument(options: {
    host?: string;
    shadow?: string;
    legacy?: string;
  }) {
    vi.stubGlobal("document", {
      querySelector: (selector: string) => {
        if (selector === "ion-img.recaptcha-image") {
          return {
            src: options.host,
            shadowRoot: {
              querySelector: () =>
                options.shadow ? { getAttribute: () => options.shadow } : null,
            },
          };
        }
        if (selector === 'img[src^="data:image"]' && options.legacy) {
          return { getAttribute: () => options.legacy };
        }
        return null;
      },
    });
  }

  const selectors = {
    ionic: "ion-img.recaptcha-image",
    legacy: 'img[src^="data:image"]',
  };

  it.each([
    ["Ionic host", { host: "data:image/png;base64,HOST" }, "HOST"],
    [
      "Ionic shadow image",
      { shadow: "data:image/png;base64,SHADOW" },
      "SHADOW",
    ],
    ["legacy image", { legacy: "data:image/png;base64,LEGACY" }, "LEGACY"],
  ])("reads the CAPTCHA from the %s", (_label, options, suffix) => {
    stubCaptchaDocument(options);
    expect(kgibankCaptchaDataUrl(selectors)).toBe(
      `data:image/png;base64,${suffix}`,
    );
  });

  it("decodes the login data URL for Workers AI", () => {
    const result = parseCaptchaDataUrl("data:image/png;base64,AQID");
    expect(result.contentType).toBe("image/png");
    expect([...new Uint8Array(result.bytes)]).toEqual([1, 2, 3]);
  });

  it("rejects unsupported captcha image formats", () => {
    expect(() => parseCaptchaDataUrl("data:image/svg+xml;base64,AQID")).toThrow(
      "格式無法辨識",
    );
  });
});
