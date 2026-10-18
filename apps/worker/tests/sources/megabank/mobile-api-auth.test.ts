import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createMegabankConnector,
  MegabankOtpRequiredError,
  MegabankProtocolError,
  MegabankVerificationRequiredError,
  prepareMegabankCaptcha,
  type MegabankDiagnostic,
} from "../../../src/sources/megabank/mobile-api";

const device = {
  deviceCode: "synthetic-device-code",
  deviceUKey: "synthetic-device-key",
  deviceSeed: "synthetic-device-seed",
};
const config = {
  userId: "A123456789",
  account: "SYNTHETIC",
  password: "synthetic-only",
  ...device,
};
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const jwk = publicKey.export({ format: "jwk" });
const cipherToken = {
  SessionKey: "00112233445566778899aabbccddeeff",
  RSAPublicKeyModulus: Buffer.from(jwk.n!, "base64url").toString("hex"),
  RSAPublicKeyExponent: Buffer.from(jwk.e!, "base64url").toString("hex"),
};

const DEPOSITS = "/fco/fco10001/home";
const TRANSACTIONS = "/fao/fao01001/query";
const REQUEST_OTP = "/fco/fco00001/getverifycode";
const CAPTCHA = "/fco/fco00001/captcha";
const LOGIN = "/fco/fco02003/login";
const LOGOUT = "/fco/fco02011/logout";

function bankApi(
  options: {
    highIpFar?: boolean;
    secondFactorFlag?: string;
    loginExtras?: Record<string, unknown>;
    queryError?: { resource: string; code: string };
    /** 依序回覆每次登入請求的銀行代碼；用完後回 0000。 */
    loginCodes?: string[];
  } = {},
) {
  let verified = false;
  const loginCodes = [...(options.loginCodes ?? [])];
  const requests: Array<{
    resource: string;
    rqData: Record<string, unknown>;
    deviceIxd: string;
    deviceUKey: string;
    seed: string;
  }> = [];
  const payloads: Record<string, Record<string, unknown>> = {
    "/fco/fco00001/initialize": {},
    "/fco/fco00001/captcha": {
      image: Buffer.from("synthetic-image").toString("base64"),
    },
    "/fco/fco00001/e2ee": {
      isE2EE: true,
      cipherToken: JSON.stringify(cipherToken),
    },
    [LOGIN]: {
      ...options.loginExtras,
      resultType: "3",
      isHighIpFar: options.highIpFar ?? true,
      secondFactorFlag: options.secondFactorFlag ?? "N",
    },
    [REQUEST_OTP]: { checkCode: "AB12" },
    "/fco/fco00001/validatecode": { success: true },
    [LOGOUT]: {},
    [DEPOSITS]: {
      loanInfoList: [],
      depositInfoList: [
        {
          DRACT: "0000000000012345",
          DRCUR: "TWD",
          AVLBA: "1,000",
          NAME: "活存",
        },
      ],
    },
    "/fco/fco10007/home": { creditCardBillInfoList: [] },
    [TRANSACTIONS]: { list: [] },
  };
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        return Response.json({ access_token: "synthetic-token" });
      }
      if (url.endsWith("/main/init")) {
        return Response.json({ statusCode: "0000" });
      }
      if (url.endsWith("/resource/login")) return Response.json({});
      const request = JSON.parse(
        String(init?.body),
      ) as (typeof requests)[number];
      requests.push(request);
      if (!verified && options.queryError?.resource === request.resource) {
        return Response.json({ code: options.queryError.code });
      }
      if (request.resource === "/fco/fco00001/validatecode") {
        expect(request.rqData.code).toBe("654321");
        verified = true;
      }
      const rsData = payloads[request.resource];
      if (!rsData) throw new Error(`Unexpected resource: ${request.resource}`);
      const code =
        request.resource === LOGIN ? (loginCodes.shift() ?? "0000") : "0000";
      return Response.json({ code, rsData });
    },
  );
  return {
    fetcher,
    requests,
    resources: () => requests.map((request) => request.resource),
  };
}

describe("兆豐查詢權限與簡訊驗證", () => {
  it.each([
    { trigger: "手動", allowOtpRequest: true },
    { trigger: "排程", allowOtpRequest: false },
  ])(
    "$trigger同步：異地旗標但查詢成功時不要求簡訊",
    async ({ allowOtpRequest }) => {
      const api = bankApi();
      const connector = createMegabankConnector(
        api.fetcher,
        async () => "12345",
        {
          allowOtpRequest,
        },
      );

      const result = await connector.sync(config);

      expect(result.bankAccounts).toHaveLength(1);
      expect(result.bankBalanceSnapshots).toEqual([
        expect.objectContaining({ balance: 1000, currency: "TWD" }),
      ]);
      expect(api.resources()).toContain(TRANSACTIONS);
      expect(api.resources()).not.toContain(REQUEST_OTP);
      expect(api.resources()).toContain(LOGOUT);
    },
  );

  it.each([DEPOSITS, TRANSACTIONS])(
    "手動查詢 %s 權限不足才寄簡訊，驗證後沿用同一次登入",
    async (resource) => {
      const api = bankApi({ queryError: { resource, code: "SYS014" } });
      const connector = createMegabankConnector(
        api.fetcher,
        async () => "12345",
        {
          allowOtpRequest: true,
        },
      );

      const error: unknown = await connector
        .sync(config)
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(MegabankOtpRequiredError);
      if (!(error instanceof MegabankOtpRequiredError)) throw error;
      expect(api.resources()).toContain(resource);
      expect(api.resources().indexOf(resource)).toBeLessThan(
        api.resources().indexOf(REQUEST_OTP),
      );
      expect(
        api.requests.find((request) => request.resource === REQUEST_OTP)
          ?.rqData,
      ).toEqual({ type: "sms" });
      expect(api.resources()).not.toContain(LOGOUT);
      expect(error.device).toEqual(device);

      const result = await connector.sync({
        ...config,
        pendingSession: error.pendingSession,
        pendingSessionExpiresAt: error.pendingSessionExpiresAt,
        otp: "654321",
      });

      expect(result.bankAccounts).toHaveLength(1);
      expect(api.resources().filter((path) => path === LOGIN)).toHaveLength(1);
      expect(
        api.resources().filter((path) => path === REQUEST_OTP),
      ).toHaveLength(1);
      expect(api.resources().filter((path) => path === LOGOUT)).toHaveLength(1);
      for (const request of api.requests) {
        expect(request).toMatchObject({
          deviceIxd: device.deviceCode,
          deviceUKey: device.deviceUKey,
          seed: device.deviceSeed,
        });
      }
    },
  );

  it("排程查詢權限不足時提示手動驗證並登出，不寄簡訊", async () => {
    const api = bankApi({ queryError: { resource: DEPOSITS, code: "SYS014" } });
    const connector = createMegabankConnector(api.fetcher, async () => "12345");

    await expect(connector.sync(config)).rejects.toBeInstanceOf(
      MegabankVerificationRequiredError,
    );
    expect(api.resources()).toContain(DEPOSITS);
    expect(api.resources()).not.toContain(REQUEST_OTP);
    expect(api.resources()).toContain(LOGOUT);
  });

  it.each([
    { highIpFar: false, code: "SYS014" },
    { highIpFar: true, code: "SYNTHETIC_ERROR" },
  ])(
    "查詢失敗 $code、異地旗標 $highIpFar：不誤啟動簡訊",
    async ({ highIpFar, code }) => {
      const api = bankApi({
        highIpFar,
        queryError: { resource: DEPOSITS, code },
      });
      const connector = createMegabankConnector(
        api.fetcher,
        async () => "12345",
        {
          allowOtpRequest: true,
        },
      );

      const error: unknown = await connector
        .sync(config)
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(MegabankProtocolError);
      expect(error).toMatchObject({ code, resource: DEPOSITS });
      expect(api.resources()).not.toContain(REQUEST_OTP);
      expect(api.resources()).toContain(LOGOUT);
    },
  );

  it("銀行明確要求未支援的雙重驗證時仍中止並登出", async () => {
    const api = bankApi({ secondFactorFlag: "Y" });
    const connector = createMegabankConnector(
      api.fetcher,
      async () => "12345",
      {
        allowOtpRequest: true,
      },
    );

    await expect(connector.sync(config)).rejects.toThrow("要求雙重驗證");
    expect(api.resources()).not.toContain(DEPOSITS);
    expect(api.resources()).not.toContain(REQUEST_OTP);
    expect(api.resources()).toContain(LOGOUT);
  });

  it("診斷記下登入旗標與觸發簡訊的端點，不含裝置、憑證或原始回應", async () => {
    const api = bankApi({
      queryError: { resource: TRANSACTIONS, code: "SYS014" },
      loginExtras: {
        userName: "synthetic-private-name",
        cookie: "synthetic-cookie",
        token: "synthetic-response-token",
      },
    });
    const diagnostics: MegabankDiagnostic[] = [];
    const saveDevice = vi.fn(async () => undefined);
    const connector = createMegabankConnector(
      api.fetcher,
      async () => "12345",
      {
        allowOtpRequest: true,
        onDevice: saveDevice,
        onDiagnostic: (event) => diagnostics.push(event),
      },
    );
    const error: unknown = await connector
      .sync(config)
      .catch((error: unknown) => error);
    if (!(error instanceof MegabankOtpRequiredError)) throw error;
    await connector.sync({
      ...config,
      pendingSession: error.pendingSession,
      pendingSessionExpiresAt: error.pendingSessionExpiresAt,
      otp: "654321",
    });

    expect(saveDevice.mock.calls).toEqual([
      [device, "stored"],
      [device, "pending_session"],
    ]);
    expect(diagnostics).toContainEqual({
      event: "megabank_login_result",
      code: "0000",
      resultType: "3",
      highIpFar: true,
      secondFactorFlag: "N",
    });
    expect(diagnostics).toContainEqual({
      event: "megabank_sms_gate",
      resource: TRANSACTIONS,
      code: "SYS014",
      action: "request_sms",
    });
    const logged = JSON.stringify(diagnostics);
    for (const secret of [
      ...Object.values(device),
      ...Object.values(config),
      "synthetic-private-name",
      "synthetic-cookie",
      "synthetic-response-token",
      "synthetic-token",
      "12345",
      "654321",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("首次 OCR 失敗前已交付裝置保存，重試沿用該裝置", async () => {
    const api = bankApi();
    let savedDevice: typeof device | undefined;
    const connector = createMegabankConnector(
      api.fetcher,
      async () => {
        throw new MegabankVerificationRequiredError("synthetic OCR failure");
      },
      {
        onDevice: async (identity) => {
          savedDevice = identity;
        },
      },
    );
    const {
      deviceCode: _code,
      deviceUKey: _key,
      deviceSeed: _seed,
      ...credentials
    } = config;
    await expect(connector.sync(credentials)).rejects.toThrow(
      "synthetic OCR failure",
    );
    expect(savedDevice).toBeDefined();
    expect(api.resources()).not.toContain(LOGIN);
    const result = await createMegabankConnector(
      api.fetcher,
      async () => "12345",
    ).sync({ ...credentials, ...savedDevice });
    expect(result.bankAccounts).toHaveLength(1);
    expect(new Set(api.requests.map((request) => request.deviceIxd))).toEqual(
      new Set([savedDevice!.deviceCode]),
    );
  });
});

describe("兆豐自動辨識驗證碼重試", () => {
  it.each([
    {
      case: "驗證碼錯誤後換新驗證碼重試並成功",
      answers: [],
      loginCodes: ["0113"],
      error: undefined,
      recognitions: 2,
      logins: 2,
    },
    {
      case: "登入送出三次仍是驗證碼錯誤時停止並要求人工驗證",
      answers: [],
      loginCodes: ["0113", "0113", "0113"],
      error: "自動登入已送出 3 次",
      recognitions: 3,
      logins: 3,
    },
    {
      case: "辨識格式不符的驗證碼不送出，也不扣登入額度",
      answers: ["1234", "1234"],
      loginCodes: ["0113", "0113"],
      error: undefined,
      recognitions: 5,
      logins: 3,
    },
    {
      case: "辨識六張都不符格式時停止，未送出任何登入",
      answers: Array.from({ length: 6 }, () => "1234"),
      loginCodes: [],
      error: "辨識已達 6 次上限（登入已送出 0 次）",
      recognitions: 6,
      logins: 0,
    },
    {
      case: "帳密或其他登入錯誤不重送",
      answers: [],
      loginCodes: ["9999"],
      error: "登入未通過",
      recognitions: 1,
      logins: 1,
    },
  ])("$case", async ({ answers, loginCodes, error, recognitions, logins }) => {
    const api = bankApi({ loginCodes });
    const pendingAnswers: string[] = [...answers];
    const recognize = vi.fn(async () => pendingAnswers.shift() ?? "12345");
    const sync = createMegabankConnector(api.fetcher, recognize).sync(config);

    if (error) await expect(sync).rejects.toThrow(error);
    else expect((await sync).bankAccounts).toHaveLength(1);
    const resources = api.resources();
    expect(resources.filter((resource) => resource === LOGIN)).toHaveLength(
      logins,
    );
    expect(resources.filter((resource) => resource === CAPTCHA)).toHaveLength(
      recognitions,
    );
    expect(recognize).toHaveBeenCalledTimes(recognitions);
  });

  it("人工輸入的驗證碼錯誤時不自動重試", async () => {
    const api = bankApi({ loginCodes: ["0113"] });
    const recognize = vi.fn(async () => "12345");
    const challenge = await prepareMegabankCaptcha(config, api.fetcher);

    await expect(
      createMegabankConnector(api.fetcher, recognize).sync({
        ...config,
        captcha: "54321",
        pendingSession: challenge.pendingSession,
        pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
      }),
    ).rejects.toThrow("圖形驗證碼錯誤");
    expect(
      api.resources().filter((resource) => resource === LOGIN),
    ).toHaveLength(1);
    expect(recognize).not.toHaveBeenCalled();
  });
});
