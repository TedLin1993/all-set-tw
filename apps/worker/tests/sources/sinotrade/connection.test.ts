import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { getConnectorSettings } from "../../../src/db";
import {
  getConnectorSettingsView,
  updateConnectorSettings,
} from "../../../src/features/connectors/service";
import { decryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  startSinotradeConnection,
  finishSinotradeConnection,
  cancelSinotradeConnection,
  readSinotradeConnectionStatus,
  verifySinotradeConnection,
} from "../../../src/sources/sinotrade/sync";
import {
  SinotradeLoginExpiredError,
  type SinotradeConfig,
} from "../../../src/sources/sinotrade/session-protocol";

const mocked = vi.hoisted(() => ({
  prepare: vi.fn(),
  complete: vi.fn(),
  close: vi.fn(),
  read: vi.fn(),
  verify: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("../../../src/sources/sinotrade/connector", () => ({
  prepareSinotradeLogin: mocked.prepare,
  completeSinotradeLogin: mocked.complete,
  closeSinotradeLogin: mocked.close,
  readSinotradeLoginChallenge: mocked.read,
  verifySinotradeLogin: mocked.verify,
  captureSinotradeIssuedState: mocked.capture,
  fetchSinotradeSnapshot: vi.fn(),
}));
const key = "synthetic-connection-key";
const credentials = { userId: "A000000000", password: "fixture-password" };
const fixtureState = {
  cookies: [
    {
      name: "ASP.NET_SessionId",
      value: "fixture-cookie",
      domain: ".sinotrade.com.tw",
      path: "/",
    },
  ],
  localStorage: { newweb_token: "fixture-token" },
  capturedAt: "2027-01-01T00:00:00.000Z",
};
const birthday = {
  step: "birthday",
  fields: [{ key: "birthday", label: "生日", hint: "西元 YYYYMMDD" }],
  actions: ["request_otp"],
};
const ready = { step: "ready", fields: [], actions: [] };
const prepared = () => ({
  platform: "newweb",
  browserSessionId: "fixture-browser",
  challenge: birthday,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});

describe("證券原生驗證的敏感狀態生命週期（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let env: Env;
  beforeAll(async () => {
    harness = await createTestD1();
    env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
  }, 60_000);
  beforeEach(async () => {
    vi.resetAllMocks();
    await env.DB.prepare(
      "DELETE FROM connector_settings WHERE connector_id = 'sinotrade'",
    ).run();
    await updateConnectorSettings(env, "sinotrade", credentials);
    mocked.prepare.mockResolvedValue(prepared());
  });
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  const stored = async () =>
    decryptJson<SinotradeConfig>(
      (await getConnectorSettings(env.DB, "sinotrade"))!.encrypted_config,
      key,
    );

  it("重整只讀狀態，不寄 OTP；生日與 OTP 不寫設定，取消後保留帳密", async () => {
    expect(await startSinotradeConnection(env, "newweb")).toMatchObject({
      status: "verification_required",
      challenge: birthday,
    });
    const before = await getConnectorSettings(env.DB, "sinotrade");
    mocked.read.mockResolvedValue(birthday);
    expect(await readSinotradeConnectionStatus(env)).toMatchObject({
      challenge: birthday,
    });
    expect(mocked.verify).not.toHaveBeenCalled();
    mocked.verify.mockResolvedValue({
      step: "otp",
      fields: [{ key: "otp", label: "驗證碼" }],
      actions: ["verify_otp"],
    });
    await verifySinotradeConnection(env, {
      action: "request_otp",
      values: { birthday: "19990101" },
    });
    expect(mocked.verify).toHaveBeenCalledOnce();
    mocked.verify.mockResolvedValue(ready);
    expect(
      await verifySinotradeConnection(env, {
        action: "verify_otp",
        values: { otp: "123456" },
      }),
    ).toMatchObject({ challenge: ready });
    expect(await getConnectorSettings(env.DB, "sinotrade")).toEqual(before);
    expect(JSON.stringify(await stored())).not.toMatch(
      /19990101|123456|birthday|otp/,
    );
    expect(
      JSON.stringify(await getConnectorSettingsView(env, "sinotrade")),
    ).not.toMatch(
      /fixture-browser|fixture-password|A000000000|19990101|123456/,
    );
    await cancelSinotradeConnection(env);
    expect(await stored()).toEqual(credentials);
  });

  it("接續第二平台前不顯示完整連線，完成或逾時不清掉帳密與已完成狀態", async () => {
    await startSinotradeConnection(env, "newweb");
    mocked.complete.mockResolvedValueOnce({
      webState: { newweb: fixtureState },
      pending: { ...prepared(), platform: "savings" },
    });
    expect(await finishSinotradeConnection(env)).toMatchObject({
      status: "verification_required",
      platform: "savings",
      challenge: birthday,
    });
    expect(await getConnectorSettingsView(env, "sinotrade")).toMatchObject({
      sessionAvailable: false,
      verificationPending: true,
      sinotradePlatforms: { newweb: true, savings: false },
    });
    mocked.complete.mockRejectedValueOnce(new SinotradeLoginExpiredError());
    await expect(finishSinotradeConnection(env)).rejects.toThrow(/逾時/);
    expect(await stored()).toEqual({
      ...credentials,
      webState: { newweb: fixtureState },
    });
    await startSinotradeConnection(env, "newweb");
    const webState = {
      newweb: fixtureState,
      savings: { ...fixtureState, localStorage: {} },
    };
    mocked.complete.mockResolvedValueOnce({ webState });
    expect(await finishSinotradeConnection(env)).toEqual({
      status: "connected",
      success: true,
    });
    expect(await stored()).toEqual({ ...credentials, webState });
    expect(await getConnectorSettingsView(env, "sinotrade")).toMatchObject({
      sessionAvailable: true,
      verificationPending: false,
    });
  });

  it("驗證失敗不自動重送，也不更動保存的帳密與 pending reference", async () => {
    await startSinotradeConnection(env, "newweb");
    const before = await stored();
    mocked.verify.mockRejectedValueOnce(
      new Error("fixture verification failure"),
    );
    await expect(
      verifySinotradeConnection(env, {
        action: "verify_otp",
        values: { otp: "123456" },
      }),
    ).rejects.toThrow("fixture verification failure");
    expect(mocked.verify).toHaveBeenCalledOnce();
    expect(await stored()).toEqual(before);
  });

  it("同意條款後立即保存已簽發的憑證（未驗證），取消後仍保留，保存失敗不影響驗證結果", async () => {
    const issued = { ...fixtureState, localStorage: { TWCACertIdxRef: "{}" } };
    const acceptTerms = {
      action: "accept_terms",
      values: { agreement: "true" },
    } as const;
    await startSinotradeConnection(env, "newweb");
    mocked.verify.mockResolvedValue(ready);
    mocked.capture.mockResolvedValueOnce(issued);
    expect(await verifySinotradeConnection(env, acceptTerms)).toMatchObject({
      challenge: ready,
    });
    const remembered = { newweb: { ...issued, authenticated: false } };
    expect((await stored()).webState).toEqual(remembered);
    // Remembered, but not connected until connect/complete verifies the platform.
    expect(await getConnectorSettingsView(env, "sinotrade")).toMatchObject({
      sessionAvailable: false,
      verificationPending: true,
      sinotradePlatforms: { newweb: false, savings: false },
    });
    await cancelSinotradeConnection(env);
    expect((await stored()).webState).toEqual(remembered);

    await startSinotradeConnection(env, "newweb");
    const before = await stored();
    mocked.capture.mockRejectedValueOnce(new Error("fixture capture failure"));
    expect(await verifySinotradeConnection(env, acceptTerms)).toMatchObject({
      challenge: ready,
    });
    expect(await stored()).toEqual(before);

    // Before the certificate is issued there is nothing to remember.
    mocked.verify.mockResolvedValue({ step: "otp", fields: [], actions: [] });
    await verifySinotradeConnection(env, {
      action: "request_otp",
      values: { otpChannel: "1" },
    });
    expect(mocked.capture).toHaveBeenCalledTimes(2);
  });

  it("開啟登入期間設定已更新時關閉新 session，不覆蓋新設定", async () => {
    mocked.prepare.mockImplementationOnce(async () => {
      await env.DB.prepare(
        "UPDATE connector_settings SET updated_at = 'changed' WHERE connector_id = 'sinotrade'",
      ).run();
      return prepared();
    });
    await expect(startSinotradeConnection(env, "newweb")).rejects.toThrow(
      /設定已變更/,
    );
    expect(mocked.close).toHaveBeenCalledWith(undefined, {
      browserSessionId: "fixture-browser",
    });
    expect(await stored()).toEqual(credentials);
  });
});
