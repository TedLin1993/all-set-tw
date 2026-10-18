import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCtbcConnector,
  type CtbcFetch,
} from "../../../src/sources/ctbc/mobile-api";
import type { CtbcPendingSession } from "../../../src/sources/ctbc/protocol";

const credentials = {
  userId: "synthetic-id",
  account: "synthetic-user",
  password: "synthetic-password",
};
const privateValue = "private-bank-payload";
const privateFields = {
  custId: credentials.userId,
  accountId: "1234567890123456",
  email: "private@example.invalid",
  authId: "private-contact-auth-id",
  otp: "654321",
  unknownField: privateValue,
};

function bankApi(
  loginResponses: Response[],
  foreignResponse?: (resource: string) => Response,
) {
  const responses = [
    Response.json({ access_token: "private-oauth-token" }),
    Response.json({ statusCode: "0000" }),
    Response.json({
      success: true,
      token: "private-transaction-token",
      rsData: { seed: "private-seed" },
    }),
    ...loginResponses,
  ];
  const fetcher: CtbcFetch = vi.fn(async (_input, init) => {
    const resource = JSON.parse(String(init?.body || "{}")).resource;
    if (foreignResponse && resource?.startsWith("/twrbm-fx/"))
      return foreignResponse(resource);
    // Synthetic no-FX-account response, independent of login/logout fixtures.
    if (String(init?.body).includes('"/twrbm-fx/qu001/010"'))
      return Response.json({
        code: "0000",
        rsData: {
          fxAcctSummaryResponse: {
            demDepBalSummaryResponse: { rspCode: "9002", infoList: [] },
          },
        },
      });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected bank request");
    return response;
  });
  return fetcher;
}

function loginResponse(data: Record<string, unknown>, status = 200) {
  return Response.json(
    {
      sys: "SVC",
      code: "0131",
      message: privateValue,
      token: "private-response-token",
      rsData: { ...privateFields, seed: "private-response-seed" },
      ...data,
    },
    {
      status,
      headers: {
        "x-auth-token": "private-auth-token",
        "set-cookie": "private-session-cookie",
      },
    },
  );
}

function expectPrivateValuesAbsent(logged: string) {
  for (const value of [
    ...Object.values(credentials),
    ...Object.values(privateFields),
    "private-oauth-token",
    "private-transaction-token",
    "private-seed",
    "private-response-token",
    "private-response-seed",
    "private-auth-token",
    "private-session-cookie",
  ]) {
    expect(logged).not.toContain(value);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("中信登入診斷的憑證保護", () => {
  it("依公開 App 5.2.26 協定送出加密登入，無待驗證訊號時完成同步", async () => {
    const fetcher = bankApi([
      loginResponse({ code: "0000", rsData: { isTwoStageLogin: false } }),
      Response.json({
        code: "0000",
        rsData: {
          twdAcctSummaryResponse: {
            demDepBalSummaryResponse: { infoList: [] },
          },
        },
      }),
      Response.json({
        code: "0000",
        rsData: { cardDataList: [], billData: {} },
      }),
      Response.json({ code: "0000" }),
    ]);

    await expect(
      createCtbcConnector(fetcher).sync(credentials),
    ).resolves.toMatchObject({ records: [], bankAccounts: [] });

    const calls = vi.mocked(fetcher).mock.calls;
    const loginInit = calls[3]![1];
    const request = JSON.parse(String(loginInit?.body));
    expect(request).toMatchObject({
      resource: "/twrbm-general/ot001/010",
      appVer: "5.2.26",
      webVer: "(0812)",
      rqData: {
        loginType: "PW",
        version: "5.2.26",
        twoStageVerify: true,
        userAgent: expect.stringContaining("Android 15; Pixel 8"),
        checkDeviceShare: "Y",
        deviceBindBlackList: "Y",
      },
    });
    expect(new Headers(loginInit?.headers).get("User-Agent")).toBe(
      request.rqData.userAgent,
    );
    for (const field of ["userId", "pin"]) {
      expect(request.rqData[field]).toMatch(/^[\da-f]+\|[\da-f]{512}$/i);
    }
    expect(String(loginInit?.body)).not.toContain(credentials.account);
    expect(String(loginInit?.body)).not.toContain(credentials.password);
    expect(calls).toHaveLength(8);
    expect(JSON.parse(String(calls.at(-1)?.[1]?.body)).resource).toBe(
      "/twrbm-general/ot002/010",
    );
  });

  it.each([
    {
      label: "缺少描述與狀態碼",
      data: {},
      descCategory: "missing",
      statusCodeType: "missing",
    },
    {
      label: "更新提示與 null 狀態碼",
      data: {
        desc: `<p>請更新至最新版本使用 ${privateValue}</p>`,
        statusCode: null,
      },
      descCategory: "app_update_prompt",
      statusCodeType: "null",
    },
    {
      label: "其他描述與空字串狀態碼",
      data: { desc: privateValue, statusCode: "" },
      descCategory: "other",
      statusCodeType: "string",
    },
  ])("$label只記錄分類，不外洩銀行回應", async ({ data, ...expected }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      createCtbcConnector(bankApi([loginResponse(data)])).sync(credentials),
    ).rejects.toMatchObject({
      name: "CtbcConnectionError",
      message: "中國信託資料同步暫時無法完成。",
    });

    const logged = warn.mock.calls.flat().join("\n");
    expect(JSON.parse(logged)).toEqual({
      event: "ctbc_mobile_resource_failed",
      resource: "/twrbm-general/ot001/010",
      system: "SVC",
      code: "0131",
      statusCode: "",
      httpStatus: 200,
      loginAttempt: 1,
      confirmationType: "initial",
      appVer: expect.any(String),
      webVer: expect.any(String),
      statusCodeType: expected.statusCodeType,
      descCategory: expected.descCategory,
      hasRsData: true,
      verificationFlags: {
        deviceConfirmation: false,
        duplicateLoginConfirmation: false,
        sharedDeviceConfirmation: false,
        contactVerification: false,
        bindDevice: false,
        otp: false,
        twoStage: false,
        verificationRequired: false,
      },
    });
    expect(logged).not.toContain("<p>");
    expect(logged).not.toContain("更新至最新版本");
    expectPrivateValuesAbsent(logged);
  });

  it.each([
    {
      confirmationType: "duplicate",
      timestampField: "dupLoginCheckTimestamp",
      flag: "duplicateLoginConfirmation",
    },
  ])(
    "$confirmationType確認後的失敗保留次數及旗標，不外洩時間戳",
    async ({ confirmationType, timestampField, flag }) => {
      const timestamp = "private-confirmation-timestamp";
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const fetcher = bankApi([
        loginResponse({
          code: "0000",
          rsData: { [timestampField]: timestamp },
        }),
        loginResponse(
          { rsData: { ...privateFields, [timestampField]: timestamp } },
          201,
        ),
      ]);

      await expect(
        createCtbcConnector(fetcher).sync(credentials),
      ).rejects.toMatchObject({ name: "CtbcConnectionError" });

      const [initial, confirmation] = vi
        .mocked(fetcher)
        .mock.calls.slice(3)
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(initial.rqData).toMatchObject({
        version: "5.2.26",
        twoStageVerify: true,
        checkDeviceShare: "Y",
      });
      expect(confirmation.rqData).toEqual({
        ...initial.rqData,
        [timestampField]: timestamp,
      });

      const logged = warn.mock.calls.flat().join("\n");
      expect(JSON.parse(logged)).toMatchObject({
        httpStatus: 201,
        loginAttempt: 2,
        confirmationType,
        verificationFlags: { [flag]: true },
      });
      expect(logged).not.toContain(timestamp);
      expectPrivateValuesAbsent(logged);
    },
  );

  it.each(["0000", "SYNTHETIC_ERROR"])(
    "裝置異常確認（%s）會停止登入，不自動解除銀行的裝置綁定",
    async (code) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const fetcher = bankApi([
        loginResponse({
          code,
          rsData: {
            deviceBindBlackListCheckTimestamp: "private-confirmation-timestamp",
          },
        }),
      ]);
      await expect(
        createCtbcConnector(fetcher).sync(credentials),
      ).rejects.toMatchObject({
        name: "CtbcVerificationRequiredError",
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
    },
  );

  it("App 核准後沿用相同裝置、加密登入資料與 token，不重新送出密碼登入", async () => {
    const deviceCode = "11111111-2222-4333-8444-555555555555";
    let pending: CtbcPendingSession | undefined;
    const fetcher = bankApi([
      loginResponse({
        code: "0000",
        rsData: { isTwoStageLogin: true, twoStageCountDownSec: 120 },
      }),
      Response.json({
        code: "0000",
        token: "private-poll-token",
        rsData: { keepListen: true },
      }),
      Response.json({
        code: "0000",
        rsData: { keepListen: false, twoStageVerifySuccess: true },
      }),
      loginResponse({ code: "0000", rsData: { isTwoStageLogin: false } }),
      Response.json({ code: "0000", rsData: {} }),
      Response.json({
        code: "0000",
        rsData: { cardDataList: [], billData: {} },
      }),
      Response.json({ code: "0000" }),
    ]);
    const connector = createCtbcConnector(fetcher, {
      allowInteractiveVerification: true,
      onPendingSession: async (value) => {
        pending = value;
      },
    });
    const config = { ...credentials, deviceCode };
    await expect(connector.sync(config)).rejects.toMatchObject({
      name: "CtbcTwoStageRequiredError",
      method: "app",
    });
    const originalRequest = { ...pending!.loginRequest };
    const expiresAt = pending!.expiresAt;
    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(
      connector.sync({ ...config, pendingSession: pending }, undefined, {
        verification: "check",
      }),
    ).rejects.toMatchObject({ method: "app" });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(pending!.expiresAt).toBe(expiresAt);
    await expect(
      connector.sync({ ...config, pendingSession: pending }, undefined, {
        verification: "check",
      }),
    ).resolves.toMatchObject({ records: [] });
    expect(pending).toBeUndefined();
    const requests = vi
      .mocked(fetcher)
      .mock.calls.slice(3)
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.map((request) => request.resource)).toEqual([
      "/twrbm-general/ot001/010",
      "/twrbm-general/ot001/002",
      "/twrbm-general/ot001/002",
      "/twrbm-general/ot001/010",
      "/twrbm-deposit/qu001/010",
      "/twrbm-card/qu002/010",
      "/twrbm-fx/qu001/010",
      "/twrbm-general/ot002/010",
    ]);
    expect(new Set(requests.map((request) => request.deviceIxd))).toEqual(
      new Set([deviceCode.replaceAll("-", "")]),
    );
    expect(new Set(requests.map((request) => request.clientNo)).size).toBe(1);
    expect(requests[3].rqData).toEqual({
      ...originalRequest,
      loginType: "TWO_STAGE_VERIFY",
    });
    expect(requests[2].token).toBe("private-poll-token");
  });

  it("只有使用者選擇 Email 才寄送驗證碼，四位 OTP 通過後接續原登入", async () => {
    let pending: CtbcPendingSession | undefined;
    const fetcher = bankApi([
      loginResponse({
        code: "0000",
        rsData: { isTwoStageLogin: true, twoStageCountDownSec: 120 },
      }),
      Response.json({
        code: "0000",
        rsData: {
          twoStageVerifyEmail: privateFields.email,
          twoStageVerifyEmailAuthId: privateFields.authId,
          twoStageCountDownSec: 120,
        },
      }),
      Response.json({ code: "0000" }),
      loginResponse({ code: "0000", rsData: { isTwoStageLogin: false } }),
      Response.json({ code: "0000", rsData: {} }),
      Response.json({
        code: "0000",
        rsData: { cardDataList: [], billData: {} },
      }),
      Response.json({ code: "0000" }),
    ]);
    const connector = createCtbcConnector(fetcher, {
      allowInteractiveVerification: true,
      onPendingSession: async (value) => {
        pending = value;
      },
    });
    const config = {
      ...credentials,
      deviceCode: "11111111-2222-4333-8444-555555555555",
    };
    await expect(connector.sync(config)).rejects.toMatchObject({
      method: "app",
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    await expect(
      connector.sync({ ...config, pendingSession: pending }, undefined, {
        verification: "email",
      }),
    ).rejects.toMatchObject({ method: "email" });
    expect(JSON.stringify(pending)).not.toContain(privateFields.email);
    expect(JSON.stringify(pending)).not.toContain(privateFields.authId);
    await expect(
      connector.sync({ ...config, pendingSession: pending }, undefined, {
        verification: "email",
      }),
    ).rejects.toMatchObject({ method: "email" });
    expect(fetcher).toHaveBeenCalledTimes(5);
    await expect(
      connector.sync({ ...config, pendingSession: pending }, undefined, {
        otp: "1234",
      }),
    ).resolves.toMatchObject({ records: [] });
    expect(pending).toBeUndefined();
    const requests = vi
      .mocked(fetcher)
      .mock.calls.slice(3)
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests[1]).toMatchObject({
      resource: "/twrbm-general/ot001/003",
      rqData: { genType: "2" },
    });
    expect(requests[2]).toMatchObject({
      resource: "/twrbm-general/ot001/004",
      rqData: { twoStageVerifyEmailAuthCode: "1234" },
    });
    expect(requests[3].rqData).toMatchObject({ loginType: "TWO_STAGE_VERIFY" });
  });

  it.each(["app", "email"] as const)(
    "%s 驗證後的重複登入確認沿用已核准工作階段，不重新送出密碼登入",
    async (method) => {
      let pending: CtbcPendingSession | undefined;
      const timestamp = "private-duplicate-timestamp";
      const deviceCode = "11111111-2222-4333-8444-555555555555";
      const fetcher = bankApi([
        loginResponse({
          code: "0000",
          rsData: {
            isTwoStageLogin: true,
            twoStageCountDownSec: 120,
            ...(method === "email"
              ? {
                  twoStageVerifyEmail: privateFields.email,
                  twoStageVerifyEmailAuthId: privateFields.authId,
                }
              : {}),
          },
        }),
        Response.json({
          code: "0000",
          rsData: { keepListen: false, twoStageVerifySuccess: true },
        }),
        loginResponse({
          code: "0000",
          token: "private-confirmation-token",
          rsData: {
            dupLoginCheckTimestamp: timestamp,
            seed: "private-confirmation-seed",
          },
        }),
        loginResponse({ code: "0000", rsData: { isTwoStageLogin: false } }),
        Response.json({ code: "0000", rsData: {} }),
        Response.json({
          code: "0000",
          rsData: { cardDataList: [], billData: {} },
        }),
        Response.json({ code: "0000" }),
      ]);
      const connector = createCtbcConnector(fetcher, {
        allowInteractiveVerification: true,
        onPendingSession: async (value) => {
          pending = value;
        },
      });
      const config = { ...credentials, deviceCode };
      await expect(connector.sync(config)).rejects.toMatchObject({ method });
      const originalRequest = { ...pending!.loginRequest };

      await expect(
        connector.sync(
          { ...config, pendingSession: pending },
          undefined,
          method === "app" ? { verification: "check" } : { otp: "1234" },
        ),
      ).resolves.toMatchObject({ records: [] });
      expect(pending).toBeUndefined();

      const requests = vi
        .mocked(fetcher)
        .mock.calls.slice(3)
        .map(([, init]) => JSON.parse(String(init?.body)));
      expect(requests.map((request) => request.resource)).toEqual([
        "/twrbm-general/ot001/010",
        method === "app"
          ? "/twrbm-general/ot001/002"
          : "/twrbm-general/ot001/004",
        "/twrbm-general/ot001/010",
        "/twrbm-general/ot001/010",
        "/twrbm-deposit/qu001/010",
        "/twrbm-card/qu002/010",
        "/twrbm-fx/qu001/010",
        "/twrbm-general/ot002/010",
      ]);
      expect(requests[2].rqData).toEqual({
        ...originalRequest,
        loginType: "TWO_STAGE_VERIFY",
      });
      expect(requests[3]).toMatchObject({
        token: "private-confirmation-token",
        seed: "private-seed",
        rqData: {
          ...originalRequest,
          loginType: "TWO_STAGE_VERIFY",
          dupLoginCheckTimestamp: timestamp,
        },
      });
      expect(new Set(requests.map((request) => request.deviceIxd))).toEqual(
        new Set([deviceCode.replaceAll("-", "")]),
      );
      expect(new Set(requests.map((request) => request.seed))).toEqual(
        new Set(["private-seed"]),
      );
      expect(new Set(requests.map((request) => request.clientNo)).size).toBe(1);
    },
  );

  it.each([{ code: "8888" }, { code: "9201", sys: "ESB" }])(
    "OTP 的錯誤 $code 不套用帳務查詢的空產品例外，也不接續登入",
    async (failure) => {
      let pending: CtbcPendingSession | undefined;
      const fetcher = bankApi([
        loginResponse({
          code: "0000",
          rsData: {
            isTwoStageLogin: true,
            twoStageVerifyEmail: privateFields.email,
            twoStageVerifyEmailAuthId: privateFields.authId,
            twoStageCountDownSec: 120,
          },
        }),
        Response.json({ ...failure, success: true }),
      ]);
      const connector = createCtbcConnector(fetcher, {
        allowInteractiveVerification: true,
        onPendingSession: async (value) => {
          pending = value;
        },
      });
      await expect(connector.sync(credentials)).rejects.toMatchObject({
        method: "email",
      });
      await expect(
        connector.sync({ ...credentials, pendingSession: pending }, undefined, {
          otp: "1234",
        }),
      ).rejects.toMatchObject({ name: "CtbcVerificationExpiredError" });
      expect(fetcher).toHaveBeenCalledTimes(5);
      expect(
        JSON.parse(String(vi.mocked(fetcher).mock.calls[4]?.[1]?.body))
          .resource,
      ).toBe("/twrbm-general/ot001/004");
    },
  );

  it("要求換密碼時不查帳，結束登入並回傳安全的人工處理提示", async () => {
    const fetcher = bankApi([
      loginResponse({
        code: "0000",
        rsData: { ...privateFields, forcePwdChange: "Y" },
      }),
      Response.json({ code: "0000" }),
    ]);
    const failure = await createCtbcConnector(fetcher)
      .sync(credentials)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CtbcVerificationRequiredError",
      message: expect.stringContaining("變更密碼"),
    });
    const requests = vi
      .mocked(fetcher)
      .mock.calls.slice(3)
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.map((request) => request.resource)).toEqual([
      "/twrbm-general/ot001/010",
      "/twrbm-general/ot002/010",
    ]);
    expectPrivateValuesAbsent(String(failure));
  });

  it.each([
    {
      label: "兩階段登入",
      data: { isTwoStageLogin: true },
      flag: "twoStage",
    },
    {
      label: "Email 驗證",
      data: {
        verifyData: {
          verify: "11",
          email: privateFields.email,
          authId: privateFields.authId,
        },
      },
      flag: "contactVerification",
    },
    {
      label: "手機驗證",
      data: { verifyData: { verify: "21", authId: privateFields.authId } },
      flag: "contactVerification",
    },
    {
      label: "共享裝置確認",
      data: { verifySharedDeviceTimestamp: "private-shared-device-timestamp" },
      flag: "sharedDeviceConfirmation",
    },
  ])(
    "$label尚未完成時，不重送確認或查帳，也不外洩驗證資料",
    async ({ data, flag }) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const timestamp = "private-confirmation-timestamp";
      const fetcher = bankApi([
        loginResponse({
          code: "0000",
          rsData: {
            ...privateFields,
            deviceBindBlackListCheckTimestamp: timestamp,
            dupLoginCheckTimestamp: timestamp,
            ...data,
          },
        }),
      ]);

      const error = await createCtbcConnector(fetcher)
        .sync(credentials)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        name: "CtbcVerificationRequiredError",
        message: expect.stringContaining("目前無法自動完成"),
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
      const request = JSON.parse(
        String(vi.mocked(fetcher).mock.lastCall?.[1]?.body),
      );
      expect(request).toMatchObject({
        resource: "/twrbm-general/ot001/010",
        rqData: { loginType: "PW" },
      });
      expect(request.rqData).not.toHaveProperty(
        "deviceBindBlackListCheckTimestamp",
      );
      expect(request.rqData).not.toHaveProperty("dupLoginCheckTimestamp");
      expect(request.rqData).not.toHaveProperty("verifySharedDeviceTimestamp");

      const logged = warn.mock.calls.flat().join("\n");
      expect(JSON.parse(logged)).toMatchObject({
        event: "ctbc_login_verification_required",
        loginAttempt: 1,
        confirmationType: "initial",
        verificationFlags: { [flag]: true, verificationRequired: true },
      });
      const exposed = `${logged}\n${String(error)}`;
      expect(exposed).not.toContain(timestamp);
      expect(exposed).not.toContain("private-shared-device-timestamp");
      expectPrivateValuesAbsent(exposed);
    },
  );

  it.each(["0000", "0131"])(
    "登入回應 %s 需要驗證時，只記錄固定的布林旗標",
    async (code) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const fetcher = bankApi([
        loginResponse({
          code,
          rsData: {
            ...privateFields,
            needBindDevice: "Y",
            needOTP: true,
            needTwoStage: 1,
            [`needOTP_${privateValue}`]: true,
          },
        }),
      ]);

      await expect(
        createCtbcConnector(fetcher).sync(credentials),
      ).rejects.toMatchObject({ name: "CtbcVerificationRequiredError" });

      const logged = warn.mock.calls.flat().join("\n");
      expect(JSON.parse(logged)).toMatchObject({
        event:
          code === "0000"
            ? "ctbc_login_verification_required"
            : "ctbc_mobile_resource_failed",
        httpStatus: 200,
        loginAttempt: 1,
        confirmationType: "initial",
        verificationFlags: {
          deviceConfirmation: false,
          duplicateLoginConfirmation: false,
          sharedDeviceConfirmation: false,
          contactVerification: false,
          bindDevice: true,
          otp: true,
          twoStage: true,
          verificationRequired: true,
        },
      });
      expectPrivateValuesAbsent(logged);
    },
  );
});

describe("外幣查詢的重新驗證與失敗隔離", () => {
  const stages = [
    "/twrbm-fx/qu001/010",
    "/twrbm-fx/qu002/010",
    "/twrbm-fx/qu002/011",
  ];
  const account = {
    accountId: "987654321000",
    curCode: "USD",
    currentBal: "123.45",
    avialBal: "123.45",
  };

  for (const verificationRequired of [true, false]) {
    it.each(stages)(
      `%s ${verificationRequired ? "要求驗證時回傳人工處理錯誤" : "一般失敗仍略過外幣"}，登出且不外洩資料`,
      async (failedResource) => {
        const warn = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined);
        const fetcher = bankApi(
          [
            loginResponse({ code: "0000", rsData: { isTwoStageLogin: false } }),
            Response.json({ code: "0000", rsData: {} }),
            Response.json({
              code: "0000",
              rsData: { cardDataList: [], billData: {} },
            }),
            Response.json({ code: "0000" }),
          ],
          (resource) => {
            if (resource === failedResource) {
              return Response.json({
                code: verificationRequired ? "0000" : "8888",
                message: privateValue,
                rsData: {
                  ...privateFields,
                  ...(verificationRequired ? { needOTP: true } : {}),
                },
              });
            }
            return Response.json({
              code: "0000",
              rsData:
                resource === stages[0]
                  ? {
                      fxAcctSummaryResponse: {
                        demDepBalSummaryResponse: {
                          rspCode: "0000",
                          infoList: [account],
                        },
                      },
                    }
                  : { infoList: [account] },
            });
          },
        );
        const result = createCtbcConnector(fetcher).sync(credentials);
        if (verificationRequired) {
          await expect(result).rejects.toMatchObject({
            name: "CtbcVerificationRequiredError",
            message: "中國信託登入需要重新驗證，請先至官方 App 完成驗證。",
          });
          expect(warn).not.toHaveBeenCalled();
        } else {
          await expect(result).resolves.toMatchObject({
            bankAccounts: [],
            bankBalanceSnapshots: [],
            bankTransactions: [],
          });
          expect(warn.mock.calls).toEqual([
            [
              "[ctbc] foreign_deposits_skipped: foreign deposit sync incomplete; previous foreign data retained",
            ],
          ]);
        }
        const resources = vi
          .mocked(fetcher)
          .mock.calls.slice(3)
          .map(([, init]) => JSON.parse(String(init?.body)).resource);
        expect(resources).toEqual([
          "/twrbm-general/ot001/010",
          "/twrbm-deposit/qu001/010",
          "/twrbm-card/qu002/010",
          ...stages.slice(0, stages.indexOf(failedResource) + 1),
          "/twrbm-general/ot002/010",
        ]);
        const logged = warn.mock.calls.flat().join("\n");
        expectPrivateValuesAbsent(logged);
        expect(logged).not.toContain(account.accountId);
        expect(logged).not.toContain(account.currentBal);
      },
    );
  }
});
