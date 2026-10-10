import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createMegabankConnector,
  MegabankOtpRequiredError,
  MegabankProtocolError,
  MegabankVerificationRequiredError,
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
const LOGIN = "/fco/fco02003/login";
const LOGOUT = "/fco/fco02011/logout";

function bankApi(
  options: {
    highIpFar?: boolean;
    secondFactorFlag?: string;
    queryError?: { resource: string; code: string };
  } = {},
) {
  let verified = false;
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
      return Response.json({ code: "0000", rsData });
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
      expect(error).toMatchObject({ code });
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
});
