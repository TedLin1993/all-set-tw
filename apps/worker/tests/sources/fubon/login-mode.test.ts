import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchFubonPayloads,
  fillLoginForm,
} from "../../../src/sources/fubon/connector";
import {
  FubonSyncReport,
  parseFubonConfig,
  parseFubonData,
} from "../../../src/sources/fubon/protocol";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// 虛構資料；欄位順序與公開登入頁一致：身分證字號、使用者代碼、密碼、驗證碼。
const LOGIN_HTML = `
<div id="login_div"><ul class="login_m">
  <li class="active"><a class="m1">一般登入</a></li>
  <li><a class="m2">信用卡網路會員登入</a></li>
</ul>
<div id="tab1"><div class="m1_login_input"><table class="login_tb"><tbody><tr><td>
  <input id="a1"><input id="a2"><input id="a3" type="password" class="m1_password">
  <input id="m1_userCaptcha">
</td></tr></tbody></table></div></div>
<div id="tab2"><table class="login_tb"><tbody><tr><td>
  <input id="b1"><input id="b2"><input id="b3" type="password" class="m1_password input_txt">
  <input id="b4" class="userCaptcha">
</td></tr></tbody></table></div></div>`;

/** 以 jsdom 執行真實的頁面內函式，點擊頁籤時切換 li.active。 */
function loginPage() {
  const dom = new JSDOM(LOGIN_HTML);
  const { document } = dom.window;
  for (const link of Array.from(document.querySelectorAll("ul.login_m a"))) {
    link.addEventListener("click", () => {
      document
        .querySelectorAll("ul.login_m li")
        .forEach((li) => li.classList.remove("active"));
      link.parentElement?.classList.add("active");
    });
  }
  const page = {
    evaluate: async (
      fn: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => {
      const previous = {
        document: globalThis.document,
        Event: globalThis.Event,
      };
      Object.assign(globalThis, { document, Event: dom.window.Event });
      try {
        return fn(...args);
      } finally {
        Object.assign(globalThis, previous);
      }
    },
  };
  return { document, page: page as never };
}

describe("fubon 登入方式", () => {
  it("card_member 切到 m2 頁籤並填入 tab2 的欄位（不碰 tab1）", async () => {
    const { document, page } = loginPage();
    await fillLoginForm(
      page,
      parseFubonConfig({
        loginMode: "card_member",
        userId: "a123456789",
        account: "qiaoling01",
        password: "fake-password",
      }),
    );
    const value = (id: string) =>
      document.querySelector<HTMLInputElement>(`#${id}`)!.value;
    expect(document.querySelector("li.active a")?.className).toBe("m2");
    expect([value("b1"), value("b2"), value("b3"), value("b4")]).toEqual([
      "A123456789",
      "qiaoling01",
      "fake-password",
      "",
    ]);
    expect([value("a1"), value("a2"), value("a3")]).toEqual(["", "", ""]);
  });

  it("未設定 loginMode 時維持一般登入（m1／tab1）", async () => {
    const { document, page } = loginPage();
    await fillLoginForm(
      page,
      parseFubonConfig({
        userId: "a123456789",
        account: "qiaoling01",
        password: "fake-password",
      }),
    );
    const value = (id: string) =>
      document.querySelector<HTMLInputElement>(`#${id}`)!.value;
    expect(document.querySelector("li.active a")?.className).toBe("m1");
    expect([value("a1"), value("a2"), value("a3")]).toEqual([
      "A123456789",
      "qiaoling01",
      "fake-password",
    ]);
    expect([value("b1"), value("b2"), value("b3")]).toEqual(["", "", ""]);
  });
});

describe("fubon card_member 同步", () => {
  afterEach(() => vi.restoreAllMocks());

  /** 簡化的網銀頁框：記錄被要求開啟的功能頁，並依路徑回傳卡片固定頁。 */
  function bankPage() {
    const origin = "https://ebank.taipeifubon.com.tw";
    const visited: string[] = [];
    const htmlByPath: Record<string, string> = {
      "/B2C/cccqu/cccqu002/CCCQU002_Home.faces": fixture(
        "card-payment-status.html",
      ),
      "/B2C/cccqu/cccqu003/CCCQU003_Home.faces": fixture("card-bill.html"),
      "/B2C/cccqu/cccqu004/CCCQU004_Home.faces": fixture("card-unbilled.html"),
    };
    let contentUrl = `${origin}/B2C/cgequ/cgequ001/CGEQU001_Home.faces`;
    const host = {
      evaluate: async (_fn: unknown, _name: string, nextUrl: string) => {
        visited.push(new URL(nextUrl).pathname);
        contentUrl = nextUrl;
        return true;
      },
    };
    const mainFrame = {
      url: () => origin,
      name: () => "",
      parentFrame: () => null,
      evaluate: async () => ({}),
    };
    const content = {
      url: () => contentUrl,
      name: () => "txnFrame",
      parentFrame: () => host,
      // 依呼叫內容回應：就緒檢查、拒絕提示、輸出 HTML、其餘（標記過期、選單連結）。
      evaluate: async (fn: (...args: unknown[]) => unknown) => {
        const source = String(fn);
        if (source.includes("readyState")) {
          return { ready: true, stale: false, marker: true };
        }
        if (source.includes("outerHTML")) {
          return htmlByPath[new URL(contentUrl).pathname] ?? "<html></html>";
        }
        if (source.includes("deny")) return "";
        return {};
      },
    };
    const page = {
      url: () => origin,
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, content],
    };
    return { page: page as never, visited };
  }

  it("不開啟任何存款頁，存款類別不計失敗，資料可正常正規化", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { page, visited } = bankPage();
    const report = new FubonSyncReport();
    const payloads = await fetchFubonPayloads(
      page,
      report,
      parseFubonConfig({ loginMode: "card_member" }),
    );
    expect(visited.length).toBeGreaterThan(0);
    expect(visited.some((path) => /cccqu/.test(path))).toBe(true);
    expect(visited.some((path) => /cboqu|cdsqu/.test(path))).toBe(false);
    expect(payloads.depositOverviewHtml).toBeUndefined();
    expect(payloads.depositTransactions).toEqual([]);

    const categories = report.summary().categories;
    for (const key of [
      "twdDeposits",
      "foreignDeposits",
      "twdTransactions",
    ] as const) {
      expect(categories[key].failed).toBe(0);
    }
    const data = parseFubonData(payloads, new Date(), report);
    expect(data.bankAccounts.every((a) => a.accountType === "credit")).toBe(
      true,
    );
    expect(data.bankAccounts.length).toBeGreaterThan(0);
  });

  it("一般登入仍會先開啟存款總覽（行為不變）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { page, visited } = bankPage();
    await fetchFubonPayloads(page, new FubonSyncReport(), parseFubonConfig({}));
    expect(visited.some((path) => /cboqu003/.test(path))).toBe(true);
  });
});
