import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFubonSessionState,
  describeFubonFrames,
  findFubonContextFrame,
  logoutFubon,
  readFubonLoggedIn,
  runWithFubonLogout,
  waitForFubonLoggedIn,
  type FubonLogoutPage,
} from "../../../src/sources/fubon/connector";
import {
  FUBON_LOGOUT_AJAX_ACTION,
  FubonExchangeLog,
} from "../../../src/sources/fubon/egress";

// 以 2026-10-14 實際同步的框架結構建立假頁面（不含任何真實資料）：
// 頂層 /B2C/common/Index.faces（frameset）→ frame1 ContextFrame.faces?fromIndex=true
// → txnFrame（先 dispatcher，再 CGEQU001 首頁）。
const ORIGIN = "https://ebank.taipeifubon.com.tw";

type FakeDocument = {
  readyState: string;
  selectors: Record<string, number>;
  viewState?: string;
};

class FakeFrame {
  constructor(
    public currentUrl: string,
    public frameName: string,
    public parent: FakeFrame | null,
    public win: Record<string, unknown> = {},
    public doc: FakeDocument = { readyState: "complete", selectors: {} },
  ) {}
  url() {
    return this.currentUrl;
  }
  name() {
    return this.frameName;
  }
  parentFrame() {
    return this.parent;
  }
  // 以假的 window/document 執行 page function（只支援本模組用到的 DOM API）。
  evaluate = (async (
    fn: (...args: unknown[]) => unknown,
    ...args: unknown[]
  ) => {
    const doc = this.doc;
    const fakeDocument = {
      get readyState() {
        return doc.readyState;
      },
      querySelector(selector: string) {
        if (selector.includes("javax.faces.ViewState")) {
          return doc.viewState === undefined ? null : { value: doc.viewState };
        }
        return (doc.selectors[selector] ?? 0) > 0 ? {} : null;
      },
      querySelectorAll(selector: string) {
        return { length: doc.selectors[selector] ?? 0 };
      },
    };
    const globals = globalThis as Record<string, unknown>;
    const saved = { window: globals.window, document: globals.document };
    globals.window = this.win;
    globals.document = fakeDocument;
    try {
      return fn(...args);
    } finally {
      globals.window = saved.window;
      globals.document = saved.document;
    }
  }) as unknown as FubonLogoutPage["mainFrame"] extends () => infer F
    ? F extends { evaluate: infer E }
      ? E
      : never
    : never;
}

const MENU_SELECTOR =
  "a[href*='/B2C/dispatcher?'][class*='taskId_'], a[href*='/B2C/dispatcher?'][class*='task_']";

function realFlowPage(options: {
  txnPath: string;
  contextWin?: Record<string, unknown>;
  contextDoc?: Partial<FakeDocument>;
}) {
  const top = new FakeFrame(`${ORIGIN}/B2C/common/Index.faces`, "", null);
  const context = new FakeFrame(
    `${ORIGIN}/B2C/common/ContextFrame.faces?fromIndex=true`,
    "frame1",
    top,
    options.contextWin ?? {},
    { readyState: "complete", selectors: {}, ...options.contextDoc },
  );
  const txn = new FakeFrame(`${ORIGIN}${options.txnPath}`, "txnFrame", context);
  const frames = [top, context, txn];
  const gotos: string[] = [];
  const page = {
    url: () => top.url(),
    frames: () => frames,
    mainFrame: () => top,
    on: vi.fn(),
    off: vi.fn(),
    goto: vi.fn(async (url: string) => {
      gotos.push(url);
      return { status: () => 200 };
    }),
  };
  return { page: page as unknown as FubonLogoutPage, top, context, txn, gotos };
}

const successState = () => ({
  ...createFubonSessionState(),
  loginRequested: true,
  lastOutcome: "success" as const,
});

describe("fubon post-login readiness (Index.faces → frame1 ContextFrame → txnFrame)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finds ContextFrame inside the Index.faces frameset, ignoring the query", () => {
    const { page, context } = realFlowPage({
      txnPath: "/B2C/cgequ/cgequ001/CGEQU001_Home.faces",
    });
    expect(findFubonContextFrame(page)).toBe(context);
  });

  it("recognizes the live home page when the top frame is Index.faces", async () => {
    const { page } = realFlowPage({
      txnPath: "/B2C/cgequ/cgequ001/CGEQU001_Home.faces",
    });
    await expect(readFubonLoggedIn(page)).resolves.toBe(true);
  });

  it("recognizes loggedIn or the menu in ContextFrame while txnFrame is still on the dispatcher", async () => {
    await expect(
      readFubonLoggedIn(
        realFlowPage({
          txnPath: "/B2C/dispatcher",
          contextWin: { loggedIn: true },
        }).page,
      ),
    ).resolves.toBe(true);
    await expect(
      readFubonLoggedIn(
        realFlowPage({
          txnPath: "/B2C/dispatcher",
          contextDoc: { selectors: { [MENU_SELECTOR]: 3 } },
        }).page,
      ),
    ).resolves.toBe(true);
  });

  it("still recognizes the old flow with ContextFrame as the top document", async () => {
    const top = new FakeFrame(
      `${ORIGIN}/B2C/common/ContextFrame.faces?t=1`,
      "",
      null,
    );
    const txn = new FakeFrame(
      `${ORIGIN}/B2C/cgequ/cgequ001/CGEQU001_Home.faces`,
      "txnFrame",
      top,
    );
    const page = {
      url: () => top.url(),
      frames: () => [top, txn],
      mainFrame: () => top,
    };
    await expect(readFubonLoggedIn(page)).resolves.toBe(true);
  });

  it("is not logged in without ContextFrame or any logged-in signal", async () => {
    const login = new FakeFrame(
      `${ORIGIN}/B2C/cmfqu/cmfqu021/CMFQU021_Home.faces?showLogin=true`,
      "",
      null,
      { loggedIn: true },
    );
    await expect(
      readFubonLoggedIn({
        url: () => login.url(),
        frames: () => [login],
        mainFrame: () => login,
      }),
    ).resolves.toBe(false);
    await expect(
      readFubonLoggedIn(realFlowPage({ txnPath: "/B2C/dispatcher" }).page),
    ).resolves.toBe(false);
  });

  it("logs a de-identified frame diagnostic on timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { page } = realFlowPage({
      txnPath: "/B2C/dispatcher",
      contextWin: { doLogout: () => undefined, signonToken: "SECRET" },
      contextDoc: { viewState: "SECRET-VIEWSTATE" },
    });
    await expect(waitForFubonLoggedIn(page, 0)).rejects.toThrow(
      "台北富邦登入後沒有在期限內載入網銀首頁。",
    );
    const logged = warn.mock.calls.map((call) => String(call[0]));
    const diagnostic = logged
      .map((line) => JSON.parse(line))
      .find((event) => event.event === "fubon_logged_in_timeout");
    expect(diagnostic).toMatchObject({
      topPath: "/B2C/common/Index.faces",
      frames: [
        { path: "/B2C/common/Index.faces", parentIndex: -1 },
        {
          name: "frame1",
          path: "/B2C/common/ContextFrame.faces",
          parentIndex: 0,
          isContextFrame: true,
          readyState: "complete",
          hasDoLogout: true,
          hasViewState: true,
          hasLoggedIn: false,
        },
        { name: "txnFrame", path: "/B2C/dispatcher", parentIndex: 1 },
      ],
    });
    const text = logged.join("\n");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("fromIndex");
  });

  it("describes frames without query strings", async () => {
    const { page } = realFlowPage({
      txnPath: "/B2C/dispatcher?ParamValue=abc",
    });
    const described = JSON.stringify(await describeFubonFrames(page));
    expect(described).not.toContain("ParamValue");
  });
});

describe("fubon logout after a successful login", () => {
  afterEach(() => vi.restoreAllMocks());

  it("success + readiness timeout ⇒ official logout is attempted in frame1's ContextFrame", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exchanges = new FubonExchangeLog();
    const doLogout = vi.fn(() => {
      exchanges.record({
        path: "/B2C/common/ContextFrame.faces",
        action: FUBON_LOGOUT_AJAX_ACTION,
        status: 200,
      });
    });
    // txnFrame 尚未離開 dispatcher、ContextFrame 也沒有 loggedIn：就緒判斷逾時。
    const { page } = realFlowPage({
      txnPath: "/B2C/dispatcher",
      contextWin: { doLogout },
      contextDoc: { viewState: "vs" },
    });
    const session = successState();
    await expect(
      runWithFubonLogout(
        session,
        () => waitForFubonLoggedIn(page, 0),
        () => logoutFubon(page, session, exchanges),
      ),
    ).rejects.toThrow("台北富邦登入後沒有在期限內載入網銀首頁。");
    expect(doLogout).toHaveBeenCalledTimes(1);
    const logoutEvents = warn.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((event) => event.event === "fubon_logout");
    expect(logoutEvents).toEqual([
      expect.objectContaining({
        attempted: true,
        ok: true,
        reason: "official",
      }),
    ]);
  });

  it("falls back to a direct doLogoutAction POST with the ContextFrame ViewState", async () => {
    const exchanges = new FubonExchangeLog();
    const fetchMock = vi.fn(
      async (_url: string, init: { body: URLSearchParams }) => {
        exchanges.record({
          path: "/B2C/common/ContextFrame.faces",
          action: init.body.get("ajaxAction") ?? "",
          status: 200,
        });
        return new Response("{}");
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { page } = realFlowPage({
      txnPath: "/B2C/dispatcher",
      contextDoc: { viewState: "vs-1" },
    });
    const result = await logoutFubon(page, successState(), exchanges);
    vi.unstubAllGlobals();
    expect(result).toEqual({ attempted: true, ok: true, reason: "direct" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/B2C/common/ContextFrame.faces",
      expect.objectContaining({ method: "POST" }),
    );
    const body = fetchMock.mock.calls[0]![1].body;
    expect(body.get("ajaxAction")).toBe(FUBON_LOGOUT_AJAX_ACTION);
    expect(body.get("javax.faces.ViewState")).toBe("vs-1");
  });

  it("reopens /B2C/ and finally GETs the logout URL when no ContextFrame is reachable", async () => {
    const login = new FakeFrame(`${ORIGIN}/B2C/somewhere.faces`, "", null);
    const gotos: string[] = [];
    const page = {
      url: () => login.url(),
      frames: () => [login],
      mainFrame: () => login,
      on: vi.fn(),
      off: vi.fn(),
      goto: vi.fn(async (url: string) => {
        gotos.push(url);
        return { status: () => 200 };
      }),
    } as unknown as FubonLogoutPage;
    const result = await logoutFubon(
      page,
      successState(),
      new FubonExchangeLog(),
      3_000,
    );
    expect(gotos).toEqual([
      `${ORIGIN}/B2C/`,
      `${ORIGIN}/B2C/common/ContextFrame.faces?logout=true`,
    ]);
    expect(result).toEqual({
      attempted: true,
      ok: true,
      reason: "no_context_frame+logout_url_reopened_status_200",
    });
  });

  it("an explicit rejection only logs out a logged-in page in place", async () => {
    const { page, gotos } = realFlowPage({ txnPath: "/B2C/dispatcher" });
    const result = await logoutFubon(
      page,
      {
        ...createFubonSessionState(),
        loginRequested: true,
        lastOutcome: "duplicate",
      },
      new FubonExchangeLog(),
    );
    expect(result).toEqual({
      attempted: false,
      ok: false,
      reason: "no_active_session",
    });
    expect(gotos).toEqual([]);
  });

  it("a home page seen after the login POST overrides a rejection outcome", async () => {
    const exchanges = new FubonExchangeLog();
    const doLogout = vi.fn(() =>
      exchanges.record({
        path: "/B2C/common/ContextFrame.faces",
        action: FUBON_LOGOUT_AJAX_ACTION,
        status: 200,
      }),
    );
    const { page } = realFlowPage({
      txnPath: "/B2C/dispatcher",
      contextWin: { doLogout },
    });
    const result = await logoutFubon(
      page,
      {
        ...createFubonSessionState(),
        loginRequested: true,
        lastOutcome: "unknown",
        homeSeen: true,
      },
      exchanges,
    );
    expect(result.reason).toBe("official");
    expect(doLogout).toHaveBeenCalledTimes(1);
  });
});
