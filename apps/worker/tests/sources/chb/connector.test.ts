import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChbConnectionError,
  ChbSessionEndedError,
  ChbStepRunner,
  ChbVerificationRequiredError,
  createChbSessionState,
  fetchChbExtras,
  isValidCaptcha,
  runWithChbLogout,
} from "../../../src/sources/chb/connector";
import {
  ChbSyncReport,
  parseChbRestResponse,
  type ChbRestRequest,
} from "../../../src/sources/chb/protocol";

describe("彰化銀行登入與登出", () => {
  afterEach(() => vi.restoreAllMocks());

  it("驗證碼只接受 6 位數字", () => {
    expect(isValidCaptcha("123456")).toBe(true);
    expect(isValidCaptcha("12345")).toBe(false);
    expect(isValidCaptcha("12a456")).toBe(false);
  });

  it("送出登入後即使同步失敗也一定嘗試登出，且不覆蓋原錯誤；未登入則不登出", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = createChbSessionState();
    const logout = vi.fn(async () => ({
      attempted: true,
      ok: true,
      reason: "http_200",
    }));
    await expect(
      runWithChbLogout(
        session,
        async () => {
          session.loginRequested = true;
          throw new ChbConnectionError("boom");
        },
        logout,
      ),
    ).rejects.toThrow("boom");
    expect(logout).toHaveBeenCalledTimes(1);

    const idle = vi.fn(async () => undefined);
    await expect(
      runWithChbLogout(createChbSessionState(), async () => "ok", idle),
    ).resolves.toBe("ok");
    expect(idle).not.toHaveBeenCalled();
  });
});

describe("彰化銀行逐項擷取", () => {
  it("單項失敗只略過並記錄，工作階段結束仍使整次同步失敗，連續三項失敗後停止", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = new ChbSyncReport();
    const steps = new ChbStepRunner(report);
    await expect(
      steps.run("twBalance", "fetch", async () => {
        throw new ChbConnectionError("單項失敗");
      }),
    ).resolves.toBeUndefined();
    await expect(
      steps.run("twTransactions", "fetch", async () => "ok"),
    ).resolves.toBe("ok");
    await expect(
      steps.run("fcBalance", "fetch", async () => {
        throw new ChbSessionEndedError();
      }),
    ).rejects.toBeInstanceOf(ChbSessionEndedError);
    // 致命錯誤往外拋之前也記一筆失敗，彙整才看得到在哪一項中斷。
    expect(report.counts.fcBalance.failed).toBe(1);

    const halting = new ChbStepRunner(report);
    const fail = async () => {
      throw new ChbConnectionError("x");
    };
    for (let i = 0; i < 3; i += 1)
      await halting.run("fcTransactions", "fetch", fail);
    const ran = vi.fn(async () => "never");
    await halting.run("fcTransactions", "fetch", ran);
    expect(ran).not.toHaveBeenCalled();
  });

  // 以回覆表模擬 `/chbnib/rest`：沒有列出的查詢回 E005「查無資料」（實機的空結果），
  // Error 照樣拋出，其他值包成 S001 回應。
  const restFrom = (replies: Record<string, unknown>) =>
    vi.fn(async (request: ChbRestRequest) => {
      if (!(request.url in replies)) {
        return parseChbRestResponse(
          JSON.stringify({
            isSuccess: false,
            data: "",
            returnCode: "E005",
            returnMessage: "查詢$$$CA001$$$查無資料$$$X",
          }),
        );
      }
      const reply = replies[request.url];
      if (reply instanceof Error) throw reply;
      return reply;
    });
  const LOAN_VIEW = "LO01001/lo01001_1_View";

  it("貸款是附加資料：不受存款連續失敗影響，中斷時保留已取得的存款", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loans = { generalLoanSuccess: true, generalLoanData: [] };
    const extras = async (
      replies: Record<string, unknown>,
      report = new ChbSyncReport(),
    ) => {
      const rest = restFrom(replies);
      return { result: await fetchChbExtras(report, rest), report, rest };
    };

    // 沒有貸款：查無資料的貸款為空物件，不算失敗。成功但內容是空字串也一樣。
    const none = await extras({});
    expect(none.result).toEqual({ loans: {} });
    expect(none.report.failedCount).toBe(0);
    expect((await extras({ [LOAN_VIEW]: "" })).result.loans).toEqual({});

    // 存款查詢已連續失敗三次：附加資料用自己的計數，照常查詢。
    const report = new ChbSyncReport();
    const deposits = new ChbStepRunner(report);
    for (let i = 0; i < 3; i += 1) {
      await deposits.run("fcTransactions", "fetch", async () => {
        throw new ChbConnectionError("x");
      });
    }
    const afterHalt = await extras({ [LOAN_VIEW]: loans }, report);
    expect(afterHalt.result.loans).toBe(loans);
    expect(afterHalt.rest).toHaveBeenCalledTimes(1);

    // 貸款查詢途中工作階段結束或瀏覽器斷線：記在貸款，不讓整次同步失敗，已取得的存款照常寫入。
    for (const error of [
      new ChbSessionEndedError(),
      new Error("Target closed"),
    ]) {
      const ended = await extras({ [LOAN_VIEW]: error });
      expect(ended.result).toEqual({});
      expect(ended.report.counts.loans.failed).toBe(1);
    }
    // 需要使用者處理的錯誤照常拋出。
    await expect(
      extras({ [LOAN_VIEW]: new ChbVerificationRequiredError("x") }),
    ).rejects.toBeInstanceOf(ChbVerificationRequiredError);
  });
});
