import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChbConnectionError,
  ChbSessionEndedError,
  ChbStepRunner,
  ChbVerificationRequiredError,
  createChbSessionState,
  fetchChbCard,
  fetchChbExtras,
  isValidCaptcha,
  runWithChbLogout,
} from "../../../src/sources/chb/connector";
import {
  ChbApiError,
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
      const key =
        request.method === "POST"
          ? `${request.url}:${(request.data.data as { stmtDate: string }).stmtDate}`
          : request.url;
      if (!(key in replies)) {
        return parseChbRestResponse(
          JSON.stringify({
            isSuccess: false,
            data: "",
            returnCode: "E005",
            returnMessage: "查詢$$$CA001$$$查無資料$$$X",
          }),
        );
      }
      const reply = replies[key];
      if (reply instanceof Error) throw reply;
      return reply;
    });
  const LOAN_VIEW = "LO01001/lo01001_1_View";
  const STATUS_VIEW = "CA01021/ca01021_1_View";
  const LIMIT_VIEW = "CA01001/ca01001_1_View";
  const LIST_VIEW = "CA01002/ca01002_1_View";
  const status = {
    settleAccountDayOfMonth: "2026/10/31",
    stmtBillAmt: "0",
    notSendBillBal: "0",
  };
  const list = {
    list: ["20260731", "20261031", "20260930", "20260831"].map((stmtDate) => ({
      stmtDate,
      stmtBal: "0",
    })),
  };
  const runCard = async (replies: Record<string, unknown>) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = new ChbSyncReport();
    const rest = restFrom(replies);
    const card = await fetchChbCard(new ChbStepRunner(report), rest);
    return { card, report, requests: rest.mock.calls.map(([r]) => r) };
  };

  it("沒有信用卡：三個 View 都查無資料，或成功但內容是空的或全為 0，都不回傳信用卡資料、不算失敗", async () => {
    const none = await runCard({});
    expect(none.card).toBeUndefined();
    expect(none.report.failedCount).toBe(0);
    expect(none.requests.map((r) => [r.method, r.url])).toEqual([
      ["GET", STATUS_VIEW],
      ["GET", LIMIT_VIEW],
      ["GET", LIST_VIEW],
    ]);
    for (const replies of [
      { [STATUS_VIEW]: { stmtBillAmt: "0", notSendBillBal: "0" } },
      { [STATUS_VIEW]: "", [LIMIT_VIEW]: { creditLine: "0" } },
      { [LIST_VIEW]: { list: [] } },
    ]) {
      const result = await runCard(replies);
      expect(result.card).toBeUndefined();
      expect(result.report.failedCount).toBe(0);
    }
  });

  it("有信用卡：本期繳款查無資料不代表沒有卡；帳單由新到舊查三個月並帶回清單的原始列，同月兩期只查較新的一期", async () => {
    const bill = (stmtDate: string) => ({ stmtDate, info: [] });
    const full = await runCard({
      [STATUS_VIEW]: status,
      [LIMIT_VIEW]: { creditLine: "20,000" },
      [LIST_VIEW]: list,
      "CA01002/ca01002_1_Action:20261031": bill("2026/10/31"),
      "CA01002/ca01002_1_Action:20260930": bill("2026/09/30"),
      "CA01002/ca01002_1_Action:20260831": bill("2026/08/31"),
    });
    expect(full.card).toEqual({
      status,
      limit: { creditLine: "20,000" },
      bills: [bill("2026/10/31"), bill("2026/09/30"), bill("2026/08/31")],
    });
    expect(full.report.failedCount).toBe(0);
    expect(full.requests.slice(3)).toEqual(
      [list.list[1], list.list[2], list.list[3]].map((row) => ({
        url: "CA01002/ca01002_1_Action",
        method: "POST",
        taskID: "ca01002",
        data: { data: row },
      })),
    );
    // 同月兩期：只查較新的一期，仍查滿三個月。較新的一期解析失敗（`bill()` 沒有金額）時，
    // 較舊的一期也不會取代它而覆寫已存的帳單。
    const sameMonth = await runCard({
      [LIST_VIEW]: { list: [...list.list, { stmtDate: "20261001" }] },
      "CA01002/ca01002_1_Action:20261031": bill("2026/10/31"),
      "CA01002/ca01002_1_Action:20261001": {
        ...bill("2026/10/01"),
        totalCurrentBal: "1,000",
      },
      "CA01002/ca01002_1_Action:20260930": bill("2026/09/30"),
      "CA01002/ca01002_1_Action:20260831": bill("2026/08/31"),
    });
    expect(sameMonth.card?.bills).toEqual([
      bill("2026/10/31"),
      bill("2026/09/30"),
      bill("2026/08/31"),
    ]);
    expect(sameMonth.report.failedCount).toBe(0);
    // 新卡：本期繳款與帳單清單都查無資料，只有額度。
    const fresh = await runCard({ [LIMIT_VIEW]: { creditLine: "20,000" } });
    expect(fresh.card).toEqual({ limit: { creditLine: "20,000" }, bills: [] });
    expect(fresh.report.failedCount).toBe(0);
  });

  it("信用卡查詢失敗只略過該項：清單格式不符、清單列出的帳單查不到或期別不符都記為失敗", async () => {
    const { card, report } = await runCard({
      [STATUS_VIEW]: new ChbApiError("E999", "x"),
      [LIST_VIEW]: list,
      "CA01002/ca01002_1_Action:20261031": { stmtDate: "2026/10/31" },
      // 20260930 查無資料：清單有列卻查不到。銀行回了別期的帳單：不寫入。
      "CA01002/ca01002_1_Action:20260831": { stmtDate: "2026/07/31" },
    });
    expect(card).toEqual({ bills: [{ stmtDate: "2026/10/31" }] });
    expect(report.counts.cardStatus.failed).toBe(1);
    expect(report.counts.cardBills.failed).toBe(2);
    // 清單有一列的結帳日讀不懂：整個清單失敗，不送任何帳單查詢。
    const badList = await runCard({
      [STATUS_VIEW]: status,
      [LIST_VIEW]: { list: [...list.list, { stmtDate: "bad" }] },
    });
    expect(badList.card).toEqual({ status, bills: [] });
    expect(badList.report.counts.cardBills.failed).toBe(1);
    expect(badList.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("貸款與信用卡是附加資料：不受存款連續失敗影響，中斷或超時都保留已取得的資料", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const loans = { generalLoanSuccess: true, generalLoanData: [] };
    const extras = async (
      replies: Record<string, unknown>,
      report = new ChbSyncReport(),
      budgetMs?: number,
    ) => {
      const rest = restFrom(replies);
      return {
        result: await fetchChbExtras(report, rest, budgetMs),
        report,
        rest,
      };
    };

    // 沒有貸款也沒有信用卡：查無資料的貸款為空物件，不算失敗。成功但內容是空字串也一樣。
    const none = await extras({});
    expect(none.result).toEqual({ loans: {}, card: undefined });
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
    expect(afterHalt.rest).toHaveBeenCalledTimes(4);

    // 信用卡查詢途中工作階段結束或瀏覽器斷線：保留貸款，記在中斷的那一項，不讓整次同步失敗。
    for (const error of [
      new ChbSessionEndedError(),
      new Error("Target closed"),
    ]) {
      const ended = await extras({
        [LOAN_VIEW]: loans,
        [STATUS_VIEW]: status,
        [LIMIT_VIEW]: error,
      });
      expect(ended.result).toEqual({ loans });
      expect(ended.report.counts.cardLimit.failed).toBe(1);
      expect(ended.rest).toHaveBeenCalledTimes(3);
    }
    // 需要使用者處理的錯誤照常拋出。
    await expect(
      extras({ [LOAN_VIEW]: new ChbVerificationRequiredError("x") }),
    ).rejects.toBeInstanceOf(ChbVerificationRequiredError);

    // 超過總時間上限：不再送出請求，連續三項失敗後停止。
    const late = await extras({ [LOAN_VIEW]: loans }, undefined, -1);
    expect(late.rest).not.toHaveBeenCalled();
    expect(late.result).toEqual({ card: undefined });
    expect(late.report.counts.loans.failed).toBe(1);
  });
});
