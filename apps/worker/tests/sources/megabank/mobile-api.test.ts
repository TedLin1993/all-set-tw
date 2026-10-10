import {
  constants,
  createCipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMegabankConnector,
  prepareMegabankCaptcha,
} from "../../../src/sources/megabank/mobile-api";
import { credentials, payloads } from "./fixtures/payloads";

const LOGOUT = "/fco/fco02011/logout";
const GETVERIFYCODE = "/fco/fco00001/getverifycode";
const CAPTCHA = "/fco/fco00001/captcha";
const LOAN_HOME = "/fln/fln01001/home";

// 建立一組合成 RSA 金鑰，模擬銀行 e2ee 回傳的 cipherToken。
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 1024,
});
const jwk = publicKey.export({ format: "jwk" });
const sessionKey = Buffer.from(randomBytes(24));
const cipherToken = {
  SessionKey: sessionKey.toString("hex"),
  RSAPublicKeyModulus: Buffer.from(jwk.n!, "base64url").toString("hex"),
  RSAPublicKeyExponent: Buffer.from(jwk.e!, "base64url").toString("hex"),
};

/** 可調整行為的假兆豐 mobile API；所有資料皆為合成。 */
function createFakeBank() {
  const state = {
    oauthCalls: 0,
    loginCode: "0000",
    malformedResource: null as string | null,
    resourceError: undefined as { resource: string; code: string } | undefined,
    logoutHttpError: false,
    loginGate: {} as Record<string, unknown>,
    otpVerified: false,
    validateCodeResult: { code: "0000", success: true } as {
      code: string;
      success?: boolean;
    },
    noCards: false,
    loanInfo: undefined as unknown[] | undefined,
    loanResponse: { code: "0000", rsData: {} } as Record<string, unknown>,
    requests: [] as string[],
    requestDeviceCodes: [] as string[],
  };
  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const body = init?.body?.toString() ?? "";
    let response: Record<string, unknown> = {};
    if (url.endsWith("/oauth/token")) {
      state.oauthCalls += 1;
      response = { access_token: "synthetic-token" };
    } else if (url.endsWith("/main/init")) {
      response = { statusCode: "0000" };
    } else if (url.endsWith("/resource/login")) {
      response = {};
    } else if (url.includes("/resource/")) {
      const request = JSON.parse(body) as {
        resource: string;
        rqData: Record<string, unknown>;
        deviceIxd: string;
      };
      const resource = request.resource;
      state.requests.push(resource);
      state.requestDeviceCodes.push(request.deviceIxd);
      if (resource.endsWith("/initialize")) {
        response = { code: "0000", rsData: {} };
      } else if (resource.endsWith("/captcha")) {
        response = {
          code: "0000",
          rsData: { image: Buffer.from("synthetic-image").toString("base64") },
        };
      } else if (resource.endsWith("/e2ee")) {
        response = {
          code: "0000",
          rsData: { isE2EE: true, cipherToken: JSON.stringify(cipherToken) },
        };
      } else if (resource.endsWith("/login")) {
        expect(request.rqData.captchaCode).toBe("12345");
        state.otpVerified = false;
        response = { code: state.loginCode, rsData: { ...state.loginGate } };
      } else if (resource === GETVERIFYCODE) {
        expect(request.rqData.type).toBe("sms");
        response = { code: "0000", rsData: { checkCode: "AB12" } };
      } else if (resource === "/fco/fco00001/validatecode") {
        expect(request.rqData.code).toBe("654321");
        state.otpVerified = state.validateCodeResult.success === true;
        response = {
          code: state.validateCodeResult.code,
          rsData: { success: state.validateCodeResult.success },
        };
      } else if (resource === LOGOUT) {
        response = { code: "0000" };
        if (state.logoutHttpError) {
          return new Response(JSON.stringify(response), { status: 503 });
        }
      } else if (resource === "/fco/fco10001/home") {
        response =
          state.loginGate.isHighIpFar === true && !state.otpVerified
            ? { code: "SYS014", desc: "權限不足" }
            : state.resourceError?.resource === resource
              ? { code: state.resourceError.code }
              : {
                  code: "0000",
                  rsData: {
                    ...(payloads.deposits as { rsData: object }).rsData,
                    ...(state.loanInfo ? { loanInfoList: state.loanInfo } : {}),
                  },
                };
      } else if (resource === LOAN_HOME) {
        response = state.loanResponse;
      } else if (resource === "/fco/fco10007/home" && state.noCards) {
        response = { code: "0000", rsData: { creditCardBillInfoList: [] } };
      } else if (state.noCards && resource.startsWith("/fao/fao0101")) {
        response = { code: "1120", rsData: {} };
      } else if (resource === "/fao/fao01009/home" && state.noCards) {
        response = { code: "1120", rsData: {} };
      } else if (resource === "/fco/fco10007/home") {
        response =
          state.malformedResource === resource
            ? { code: "0000", rsData: {} }
            : { code: "0000", ...(payloads.cardOverview as object) };
      } else if (resource === "/fao/fao01009/home") {
        response =
          state.malformedResource === resource
            ? { code: "0000", rsData: { returnCode: "1120" } }
            : { code: "0000", ...(payloads.cardBills as object) };
      } else if (resource === "/fao/fao01010/home") {
        response =
          state.malformedResource === resource
            ? { code: "0000", rsData: {} }
            : { code: "0000", ...(payloads.cardHome as object) };
      } else if (resource === "/fao/fao01010/query") {
        response =
          state.malformedResource === resource
            ? { code: "0000", rsData: {} }
            : { code: "0000", ...(payloads.cardTransactions as object) };
      } else if (resource === "/fao/fao01001/query") {
        response = {
          code: "0000",
          ...(payloads.depositTransactions[0]?.response as object),
        };
      } else {
        throw new Error(`Unexpected resource ${resource}`);
      }
    } else {
      throw new Error("Unexpected URL");
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const logoutCount = () =>
    state.requests.filter((resource) => resource === LOGOUT).length;
  return { state, fetcher, logoutCount };
}

async function freshSyncConfig(
  fetcher: ReturnType<typeof createFakeBank>["fetcher"],
) {
  const challenge = await prepareMegabankCaptcha(credentials, fetcher);
  return {
    ...credentials,
    pendingSession: challenge.pendingSession,
    pendingSessionExpiresAt: challenge.pendingSessionExpiresAt,
    captcha: "12345",
  };
}

describe("兆豐貸款同步", () => {
  const mortgageNo = "0000000000011111";
  const personalLoanNo = "0000000000022222";
  const loanRow = {
    loanNo: mortgageNo,
    loanType: "長擔購置住宅放款",
    loanStartDate: "2025/07/04",
    loanEndDate: "2065/07/04",
    loanAmt: "10,000,000",
    loanCurr: "TWD",
    intRate: "1.7750",
    payPeriod: "015",
    payAmt: "14,589",
    payDate: "2026/10/04",
    deductionDate: "04",
  };

  function bankWithLoans() {
    const bank = createFakeBank();
    bank.state.loanInfo = [
      { loanNo: mortgageNo, loanCurr: "TWD", loanBal: "10,000,000" },
      { loanNo: personalLoanNo, loanCurr: "TWD", loanBal: "300,000" },
    ];
    bank.state.loanResponse = {
      code: "0000",
      rsData: {
        loanList: [
          loanRow,
          {
            ...loanRow,
            loanNo: personalLoanNo,
            loanType: "個人信用貸款",
            loanStartDate: "114/01/15",
            loanEndDate: "121/01/15",
            loanAmt: "500,000",
            intRate: "2.5%",
            payPeriod: "第009期",
            deductionDate: "15號",
          },
        ],
      },
    };
    return bank;
  }

  it("住宅類貸款標 housing、其他貸款標 other，sourceId 皆為 loan:；條件寫入 raw，帳號只留末四碼", async () => {
    const bank = bankWithLoans();
    const result = await createMegabankConnector(bank.fetcher).sync(
      await freshSyncConfig(bank.fetcher),
    );
    const loanAccounts = (result.bankAccounts ?? []).filter(
      (account) => account.accountType === "loan",
    );
    expect(loanAccounts).toHaveLength(2);
    const mortgage = loanAccounts.find(
      (account) => account.loanCategory === "housing",
    )!;
    const personalLoan = loanAccounts.find(
      (account) => account.loanCategory === "other",
    )!;
    expect(mortgage).toBeDefined();
    expect(personalLoan).toBeDefined();
    expect(mortgage.accountName).toMatch(/長擔購置住宅放款 末四碼 1111/);
    expect(mortgage.raw).toEqual({
      last4: "1111",
      initialAmount: 10_000_000,
      totalPeriods: 480,
      remainingPeriods: 466,
      annualRatePct: 1.775,
      paymentDay: 4,
      nextPaymentDate: "2026-10-04",
      nextPaymentAmount: 14_589,
      drawdownDate: "2025-07-04",
    });
    const serialized = JSON.stringify(loanAccounts);
    expect(serialized).not.toContain(mortgageNo);
    expect(serialized).not.toContain(personalLoanNo);

    // 民國年日期、「第009期」、「15號」等格式正規化
    const personalRaw = personalLoan.raw as {
      drawdownDate: string;
      totalPeriods: number;
      paymentDay: number;
    };
    expect(personalRaw.drawdownDate).toBe("2025-01-15");
    expect(personalRaw.totalPeriods).toBe(84);
    expect(personalRaw.paymentDay).toBe(15);

    // 貸款餘額以負債（負值）快照
    const snapshot = (result.bankBalanceSnapshots ?? []).find(
      (row) => row.accountId === mortgage.sourceId,
    );
    expect(snapshot?.balance).toBe(-10_000_000);
    expect(snapshot?.sourceId).toMatch(/^snapshot:loan:megabank:/);
  });

  it("貸款解析失敗或查詢失敗只略過貸款，存款照常同步", async () => {
    const bank = bankWithLoans();
    const connector = createMegabankConnector(bank.fetcher);
    const hasLoan = (accounts?: Array<{ accountType?: string }>) =>
      (accounts ?? []).some((account) => account.accountType === "loan");

    bank.state.loanResponse = {
      code: "0000",
      rsData: { loanList: [{ foo: "bar" }] },
    };
    const unparsed = await connector.sync(await freshSyncConfig(bank.fetcher));
    expect(hasLoan(unparsed.bankAccounts)).toBe(false);
    expect(unparsed.bankAccounts?.length).toBeGreaterThan(0);

    bank.state.loanResponse = { code: "E999" };
    const failed = await connector.sync(await freshSyncConfig(bank.fetcher));
    expect(hasLoan(failed.bankAccounts)).toBe(false);
    expect(failed.bankAccounts?.length).toBeGreaterThan(0);
  });

  it("總覽明確沒有貸款時不查詢貸款 API", async () => {
    const bank = bankWithLoans();
    bank.state.loanInfo = [];
    bank.state.requests.length = 0;
    await createMegabankConnector(bank.fetcher).sync(
      await freshSyncConfig(bank.fetcher),
    );
    expect(bank.state.requests).not.toContain(LOAN_HOME);
  });
});
