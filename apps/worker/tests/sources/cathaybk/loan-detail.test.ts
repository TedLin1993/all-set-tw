import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { Page } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeLoans } from "../../../src/sources/cathaybk/connector";
import {
  extractCathayLoanDetailDom,
  getCathayApiSession,
  parseCathayLoanAutopayAccount,
  queryCathayLoanAutopayApi,
} from "../../../src/sources/cathaybk/loan-detail";

const readFixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
const detailHtml = readFixture("cathay-loan-detail.html");
const overviewHtml = readFixture("cathay-loan-overview-table.html");
const detailUrl =
  "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInqDetail";
const loanNumber = "0000000000000002";

const detailDocument = (html = detailHtml) =>
  new JSDOM(html, { url: detailUrl }).window.document;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("國泰世華貸款明細扣款帳戶", () => {
  it("窄版 li 版面依標籤對應扣款行庫與扣款帳號，只回傳末四碼", () => {
    const extraction = extractCathayLoanDetailDom(detailDocument());

    expect(extraction).toMatchObject({
      fieldSource: "list",
      loanAccountDigits: loanNumber,
      autopayRowFound: true,
      bankText: "(013)國泰世華商業銀行",
      accountLast4: "1234",
      accountPlainText: null,
    });
    expect(JSON.stringify(extraction)).not.toContain("0000000000001234");
    expect(parseCathayLoanAutopayAccount(extraction, loanNumber)).toEqual({
      bankCode: "013",
      last4: "1234",
    });
  });

  it("頁面不是同一筆貸款或缺欄位時不覆寫", () => {
    const extraction = extractCathayLoanDetailDom(detailDocument());
    expect(
      parseCathayLoanAutopayAccount(extraction, "0000000000000003"),
    ).toBeUndefined();

    const missing = detailDocument();
    Array.from(missing.querySelectorAll("li"))
      .find((item) => item.textContent?.includes("扣款行庫"))
      ?.remove();
    expect(
      parseCathayLoanAutopayAccount(
        extractCathayLoanDetailDom(missing),
        loanNumber,
      ),
    ).toBeUndefined();
  });

  it("桌面表格版面依 th 與 td 欄位對應", () => {
    const tableDocument = detailDocument();
    const container = tableDocument.createElement("div");
    container.innerHTML =
      "<table><thead><tr>" +
      "<th><p>額度號碼</p></th><th><p>扣款行庫</p><p>扣款帳號</p></th><th><p>科目別</p></th>" +
      "</tr></thead><tbody><tr>" +
      "<td><p>10000001</p></td><td><p>(013)國泰世華商業銀行</p><p>0000000000001234</p></td><td><p>中期擔保放款</p></td>" +
      "</tr></tbody></table>";
    tableDocument.querySelector("ul")!.replaceWith(container);
    const extraction = extractCathayLoanDetailDom(tableDocument);
    expect(extraction.fieldSource).toBe("table");
    expect(JSON.stringify(extraction)).not.toContain("0000000000001234");
    expect(parseCathayLoanAutopayAccount(extraction, loanNumber)).toEqual({
      bankCode: "013",
      last4: "1234",
    });
  });

  it("扣款行庫與帳號明確為無時視為未設定", () => {
    const unset = detailHtml
      .replace("(013)國泰世華商業銀行", "無")
      .replace("0000000000001234", "無");
    expect(
      parseCathayLoanAutopayAccount(
        extractCathayLoanDetailDom(detailDocument(unset)),
        loanNumber,
      ),
    ).toBe(null);
  });

  it("scrapeLoans 逐筆開啟明細並寫入對應貸款", async () => {
    const overview = new JSDOM(overviewHtml, {
      url: "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInq",
    }).window.document;
    let current = overview;
    let currentUrl = "";
    const page = {
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
        current = url.includes(`account=${loanNumber}`)
          ? detailDocument()
          : overview;
      }),
      url: vi.fn(() => currentUrl),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn(async (callback: (root: Document) => unknown) =>
        callback(current),
      ),
    } as unknown as Page;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    const target = result.bankAccounts.find(
      (account) => account.sourceId === `loan:cathaybk:${loanNumber}`,
    );
    expect(target?.autopayAccount).toEqual({ bankCode: "013", last4: "1234" });
    expect(
      result.bankAccounts.filter((account) => "autopayAccount" in account),
    ).toHaveLength(1);
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain('"event":"cathaybk_loan_autopay"');
    expect(logs).not.toContain("1234");
    expect(logs).not.toContain(loanNumber);
    expect(logs).toContain('"event":"cathaybk_loan_autopay_detail"');
    expect(logs).toContain('"found":1');
  });
});

/** null 表示網路錯誤（httpStatus 0）；NON_JSON 表示 HTTP 200 但內容不是 JSON。 */
const NON_JSON = Symbol("non-json");
type ApiReply = Record<string, unknown> | null | typeof NON_JSON;

/**
 * 以假的 XMLHttpRequest 執行頁面內 API 函式；回應依貸款帳號與該帳號第幾次
 * 請求（從 1 起算）決定。`stats.maxInFlight` 記錄同時進行中的明細請求數。
 */
function stubCathayXhr(
  jwtData: Record<string, unknown> | null,
  replyFor: (account: string, attempt: number) => ApiReply,
  userProfile: ApiReply = ok({ idType: "11" }),
) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const attemptsByAccount = new Map<string, number>();
  const stats = { inFlight: 0, maxInFlight: 0 };
  class FakeXhr {
    url = "";
    responseText = "";
    status = 0;
    withCredentials = false;
    timeout = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body: string | null) {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      requests.push({ url: this.url, body: parsed });
      let reply: ApiReply;
      let isDetail = false;
      if (this.url === "/MyBank/Customized/GetJWT") {
        reply = jwtData ? { Data: jwtData } : null;
      } else if (this.url.endsWith("/ClientCommon/G_COMM_Q_UserProfile")) {
        reply = userProfile;
      } else {
        const content = parsed.content as { account: string };
        const attempt = (attemptsByAccount.get(content.account) ?? 0) + 1;
        attemptsByAccount.set(content.account, attempt);
        reply = replyFor(content.account, attempt);
        isDetail = true;
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      }
      // 以 setTimeout 讓回應延後，若呼叫端並行送出，inFlight 會大於 1。
      setTimeout(() => {
        if (isDetail) stats.inFlight--;
        if (reply === null) {
          this.onerror?.();
          return;
        }
        this.status = 200;
        this.responseText =
          reply === NON_JSON ? "<html>error</html>" : JSON.stringify(reply);
        this.onload?.();
      }, 1);
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return Object.assign(requests, { stats });
}

const ok = (content: Record<string, unknown>) => ({
  success: true,
  returnCode: "0000",
  content,
});
const jwt = { JwtToken: "token", CustomerId: "A000000000" };

function apiPage(document: Document) {
  const gotoUrls: string[] = [];
  let currentUrl = "";
  const page = {
    goto: vi.fn(async (url: string) => {
      gotoUrls.push(url);
      currentUrl = url;
    }),
    url: vi.fn(() => currentUrl),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(
      async (callback: (input: unknown) => unknown, input?: unknown) =>
        callback === queryCathayLoanAutopayApi ||
        callback === (getCathayApiSession as unknown)
          ? callback(input)
          : callback(document),
    ),
  } as unknown as Page;
  return { page, gotoUrls };
}

const overviewDocument = () =>
  new JSDOM(overviewHtml, {
    url: "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInq",
  }).window.document;

describe("國泰世華貸款扣款帳戶 API 查詢", () => {
  it("頁面內呼叫 L_ACCT_Q_OverViewDetail，只回傳末四碼並對應三種結果", async () => {
    const requests = stubCathayXhr({ ...jwt, IdType: "1" }, (account) => {
      if (account === "0000000000000001")
        return ok({
          bankId: "812",
          bankName: "台新",
          deductionAccount: "00000000005678",
          isOtherBankDeduct: true,
        });
      if (account === "0000000000000002")
        return ok({
          deductionAccount: "0000000000001234",
          isOtherBankDeduct: false,
        });
      if (account === "0000000000000003") return ok({ deductionAccount: "" });
      if (account === "0000000000000004")
        return { success: false, returnCode: "E999", content: null };
      return ok({ deductionAccount: "0000000000004321" });
    });

    const { session, diagnostics } = await getCathayApiSession();
    expect(diagnostics).toEqual({
      jwtAvailable: true,
      userProfileReturnCode: "not_called",
    });
    expect(
      requests.some((request) => request.url.endsWith("G_COMM_Q_UserProfile")),
    ).toBe(false);
    const result = await queryCathayLoanAutopayApi({
      session,
      accounts: [
        "1",
        "0000000000000002",
        "0000000000000003",
        "0000000000000004",
        "0000000000000005",
      ],
    });

    expect(result.idTypeSent).toBe(true);
    expect(
      result.loans.map((loan) => [loan.result, loan.autopayAccount]),
    ).toEqual([
      ["found", { bankCode: "812", last4: "5678" }],
      ["found", { bankCode: "013", last4: "1234" }],
      ["unset", null],
      ["unknown", undefined],
      // 缺 bankId 且非明確自行扣款時不猜銀行代碼。
      ["unknown", undefined],
    ]);
    expect(result.loans[3]).toMatchObject({
      returnCode: "E999",
      usable: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("0000000000001234");
    expect(serialized).not.toContain("00000000005678");
    const detailRequest = requests.find((request) =>
      request.url.endsWith(
        "/ClientLoan/Api/ClientLoan/L_ACCT_Q_OverViewDetail",
      ),
    );
    expect(detailRequest?.body.content).toEqual({
      customerId: "A000000000",
      idType: "1",
      account: "0000000000000001",
    });
  });

  it("依序逐筆送出明細請求，不並行", async () => {
    const requests = stubCathayXhr(jwt, () => ok({ deductionAccount: "" }));

    const { session } = await getCathayApiSession();
    const result = await queryCathayLoanAutopayApi({
      session,
      accounts: ["1", "2", "3", "4", "5"],
    });

    expect(requests.stats.maxInFlight).toBe(1);
    const detailAccounts = requests
      .filter((request) => request.url.endsWith("L_ACCT_Q_OverViewDetail"))
      .map((request) => (request.body.content as { account: string }).account);
    expect(detailAccounts).toEqual([
      "0000000000000001",
      "0000000000000002",
      "0000000000000003",
      "0000000000000004",
      "0000000000000005",
    ]);
    expect(result.loans.map((loan) => loan.attempts)).toEqual([1, 1, 1, 1, 1]);
    const seqNos = requests
      .filter((request) => request.url.endsWith("L_ACCT_Q_OverViewDetail"))
      .map((request) => request.body.functionSeqNo);
    expect(new Set(seqNos).size).toBe(seqNos.length);
  });

  it("無回應或非 JSON 時重試該筆一次，第二次成功即採用", async () => {
    const requests = stubCathayXhr(jwt, (account, attempt) => {
      if (account === "0000000000000002" && attempt === 1) return null;
      if (account === "0000000000000003" && attempt === 1) return NON_JSON;
      if (account === "0000000000000004") return null;
      return ok({ bankId: "013", deductionAccount: "0000000000001234" });
    });

    const { session } = await getCathayApiSession();
    const result = await queryCathayLoanAutopayApi({
      session,
      accounts: ["1", "2", "3", "4"],
    });

    expect(requests.stats.maxInFlight).toBe(1);
    expect(
      result.loans.map((loan) => [loan.result, loan.attempts, loan.returnCode]),
    ).toEqual([
      ["found", 1, "0000"],
      ["found", 2, "0000"],
      ["found", 2, "0000"],
      // 兩次都無回應時維持 unknown，不再重試第三次。
      ["unknown", 2, "no_response"],
    ]);
    const detailAccounts = requests
      .filter((request) => request.url.endsWith("L_ACCT_Q_OverViewDetail"))
      .map((request) => (request.body.content as { account: string }).account);
    expect(detailAccounts).toEqual([
      "0000000000000001",
      "0000000000000002",
      "0000000000000002",
      "0000000000000003",
      "0000000000000003",
      "0000000000000004",
      "0000000000000004",
    ]);
  });

  it("有明確 returnCode 的業務錯誤不重試", async () => {
    const requests = stubCathayXhr(jwt, () => ({
      success: false,
      returnCode: "E999",
      content: null,
    }));

    const { session } = await getCathayApiSession();
    const result = await queryCathayLoanAutopayApi({
      session,
      accounts: ["1", "2"],
    });

    expect(
      requests.filter((request) =>
        request.url.endsWith("L_ACCT_Q_OverViewDetail"),
      ),
    ).toHaveLength(2);
    expect(
      result.loans.map((loan) => [loan.returnCode, loan.attempts]),
    ).toEqual([
      ["E999", 1],
      ["E999", 1],
    ]);
  });

  it("scrapeLoans 以 API 寫入貸款，不開明細頁；非 0000 的貸款不寫", async () => {
    stubCathayXhr(jwt, (account) =>
      account === loanNumber
        ? ok({ bankId: "013", deductionAccount: "0000000000001234" })
        : account === "0000000000000003"
          ? ok({ deductionAccount: "" })
          : { success: true, returnCode: "E001", content: {} },
    );
    const { page, gotoUrls } = apiPage(overviewDocument());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(gotoUrls.some((url) => url.includes("L0101_LoanInqDetail"))).toBe(
      false,
    );
    const byId = new Map(
      result.bankAccounts.map((account) => [account.sourceId, account]),
    );
    expect(byId.get(`loan:cathaybk:${loanNumber}`)?.autopayAccount).toEqual({
      bankCode: "013",
      last4: "1234",
    });
    expect(byId.get("loan:cathaybk:0000000000000003")?.autopayAccount).toBe(
      null,
    );
    expect(
      result.bankAccounts.filter((account) => "autopayAccount" in account),
    ).toHaveLength(2);
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain('"method":"api"');
    expect(logs).toContain('"source":"api"');
    expect(logs).toContain('"returnCode":"E001"');
    expect(logs).toContain('"idTypeSent":true');
    expect(logs).toContain('"userProfileReturnCode":"0000"');
    expect(logs).not.toContain("A000000000");
    expect(logs).not.toContain("token");
    expect(logs).toContain('"apiJwtAvailable":true');
    expect(logs).toContain('"elapsedMs":');
    expect(logs).toContain('"attempts":1');
    expect(logs).toContain('"found":1');
    expect(logs).toContain('"unset":1');
    expect(logs).not.toContain("1234");
    expect(logs).not.toContain(loanNumber);
  });

  it("GetJWT 沒有 IdType 時以 G_COMM_Q_UserProfile 取得 idType 並送出", async () => {
    const requests = stubCathayXhr(jwt, () => ok({ deductionAccount: "" }));

    const { session, diagnostics } = await getCathayApiSession();
    const result = await queryCathayLoanAutopayApi({
      session,
      accounts: ["1"],
    });

    expect(diagnostics).toEqual({
      jwtAvailable: true,
      userProfileReturnCode: "0000",
    });
    const profileRequest = requests.find((request) =>
      request.url.endsWith(
        "/OnlineBankingApi/Common/Api/ClientCommon/G_COMM_Q_UserProfile",
      ),
    );
    expect(profileRequest?.body.content).toEqual({ customerId: "A000000000" });
    expect(typeof profileRequest?.body.functionSeqNo).toBe("string");
    expect(result.idTypeSent).toBe(true);
    expect(requests.at(-1)?.body.content).toEqual({
      customerId: "A000000000",
      idType: "11",
      account: "0000000000000001",
    });
  });

  it("UserProfile 失敗時不送 idType，log 記錄 returnCode", async () => {
    const requests = stubCathayXhr(
      jwt,
      () => ({ success: false, returnCode: "A602", content: null }),
      { success: false, returnCode: "E500", content: null },
    );

    const { session, diagnostics } = await getCathayApiSession();
    const result = await queryCathayLoanAutopayApi({
      session,
      accounts: ["1"],
    });

    expect(diagnostics).toMatchObject({ userProfileReturnCode: "E500" });
    expect(result.idTypeSent).toBe(false);
    expect(requests.at(-1)?.body.content).toEqual({
      customerId: "A000000000",
      account: "0000000000000001",
    });
  });

  it("API 對所有貸款都失敗時改走明細頁", async () => {
    stubCathayXhr(jwt, () => ({
      success: false,
      returnCode: "E001",
      content: null,
    }));
    const overview = overviewDocument();
    let current = overview;
    const gotoUrls: string[] = [];
    let currentUrl = "";
    const page = {
      goto: vi.fn(async (url: string) => {
        gotoUrls.push(url);
        currentUrl = url;
        current = url.includes(`account=${loanNumber}`)
          ? detailDocument()
          : overview;
      }),
      url: vi.fn(() => currentUrl),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn(
        async (callback: (input: unknown) => unknown, input?: unknown) =>
          callback === queryCathayLoanAutopayApi ||
          callback === (getCathayApiSession as unknown)
            ? callback(input)
            : callback(current),
      ),
    } as unknown as Page;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(
      gotoUrls.filter((url) => url.includes("L0101_LoanInqDetail")),
    ).toHaveLength(5);
    expect(
      result.bankAccounts.find(
        (account) => account.sourceId === `loan:cathaybk:${loanNumber}`,
      )?.autopayAccount,
    ).toEqual({ bankCode: "013", last4: "1234" });
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain('"method":"page"');
    expect(logs).toContain('"apiJwtAvailable":true');
    expect(logs).not.toContain("1234");
  });

  it("取不到 JWT 時改走明細頁", async () => {
    stubCathayXhr(null, () => ok({ deductionAccount: "" }));
    const { page, gotoUrls } = apiPage(overviewDocument());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await scrapeLoans(page);

    expect(
      gotoUrls.filter((url) => url.includes("L0101_LoanInqDetail")),
    ).toHaveLength(5);
    const logs = log.mock.calls.map(([message]) => String(message)).join("\n");
    expect(logs).toContain('"method":"page"');
    expect(logs).toContain('"apiJwtAvailable":false');
    expect(logs).toContain('"userProfileReturnCode":"not_called"');
  });
});
