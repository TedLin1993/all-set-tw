import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    let body: unknown;
    if (path === "/api/runtime") body = { demoMode: true };
    else if (path === "/api/summary")
      body = {
        totalAssetsTwd: 0,
        totalLiabilitiesTwd: 0,
        netWorthTwd: 0,
        monthlyIncomeTwd: 0,
        monthlyExpenseTwd: 0,
        accounts: 0,
        investments: 0,
        transactions: 0,
      };
    else if (path === "/api/bank") body = { accounts: [], transactions: [] };
    else if (path === "/api/investments") body = [];
    else if (path === "/api/investment-transactions") body = [];
    else if (path === "/api/invoices") body = [];
    else if (path === "/api/activity/invoice-mappings") body = [];
    else if (path === "/api/manual-assets") body = [];
    else if (path === "/api/exchange-rates") body = [];
    else if (path === "/api/history/net-worth/chart") body = [];
    else if (path === "/api/sync-jobs") body = [];
    else if (path === "/api/classification/categories")
      body = [
        { id: "salary", label: "薪資", sortOrder: 1, isSystem: true },
        { id: "transfer", label: "轉帳", sortOrder: 2, isSystem: true },
        { id: "food", label: "餐飲", sortOrder: 3, isSystem: true },
        { id: "transport", label: "交通", sortOrder: 4, isSystem: true },
        { id: "shopping", label: "購物", sortOrder: 5, isSystem: true },
        { id: "housing", label: "居住", sortOrder: 6, isSystem: true },
        { id: "health", label: "醫療", sortOrder: 7, isSystem: true },
        { id: "education", label: "教育", sortOrder: 8, isSystem: true },
        {
          id: "entertainment",
          label: "娛樂",
          sortOrder: 9,
          isSystem: true,
        },
        { id: "investment", label: "投資", sortOrder: 10, isSystem: true },
        { id: "fee", label: "手續費", sortOrder: 11, isSystem: true },
        { id: "insurance", label: "保險", sortOrder: 12, isSystem: true },
        { id: "tax", label: "稅務", sortOrder: 13, isSystem: true },
        { id: "other", label: "未分類", sortOrder: 14, isSystem: true },
      ];
    else if (path === "/api/classification/rules") body = [];
    else if (path.includes("/connectors/") && path.endsWith("/settings"))
      body = { configured: false, publicConfig: {} };
    else throw new Error(`Unexpected API request in E2E mock: ${path}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
});

test("loads the responsive shell and changes primary views", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Taiwan Fin Hub").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "總覽", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "資產", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "資產", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/assets$/);

  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "總覽", exact: true }),
  ).toBeVisible();
});

test("renders the mobile bottom navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("navigation", { name: "主要導覽" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "更多" }).click();
  await expect(
    page.getByRole("heading", { name: "更多", exact: true }),
  ).toBeVisible();
});

test("shows a loading state while a connector sync is pending", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/runtime", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ demoMode: false }),
    }),
  );
  await page.route("**/api/connectors/ctbc/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connectorId: "ctbc",
        configured: true,
        credentialsComplete: true,
        sessionAvailable: false,
        publicConfig: {},
      }),
    }),
  );

  let releaseSync!: () => void;
  const pendingSync = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  await page.route("**/api/connectors/ctbc/sync", async (route) => {
    await pendingSync;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        connectorId: "ctbc",
        scope: "all",
        records: 0,
        cursorUpdated: true,
      }),
    });
  });

  await page.goto("/#/data-sources");
  await page.getByRole("button", { name: "管理設定" }).last().click();
  const syncButton = page.getByRole("button", {
    name: "同步",
    exact: true,
  });
  await syncButton.click();

  const pendingButton = page.getByRole("button", { name: "同步中…" });
  await expect(pendingButton).toBeDisabled();
  await expect(pendingButton.locator("svg")).toHaveClass(/animate-spin/);

  releaseSync();
  await expect(syncButton).toBeEnabled();
});

test("keeps the desktop overview within the viewport with long data", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [],
        transactions: [
          {
            id: "long-transaction",
            connectorId: "cathaybk",
            accountId: "account-1",
            sourceId: "long-source-id",
            postedDate: new Date().toISOString().slice(0, 10),
            amount: -88,
            currency: "TWD",
            description:
              "YSSL80300000051500038491812BDF7C03202607172521LONGACTIVITY",
            institutionName: "測試銀行",
            status: "posted",
          },
        ],
      }),
    });
  });

  await page.goto("/#/overview");
  await expect(
    page.getByRole("heading", { name: "本月財務脈動" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "值得留意" })).toBeVisible();
  const pageWidth = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scroll).toBe(pageWidth.client);
});

test("shows this month's cash flow on the overview and opens activity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const month = new Date().toISOString().slice(0, 7);
  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [],
        transactions: [
          {
            id: "monthly-income",
            connectorId: "cathaybk",
            accountId: "account-1",
            sourceId: "monthly-income",
            postedDate: `${month}-02`,
            amount: 50_000,
            currency: "TWD",
            description: "薪資",
            status: "posted",
          },
          {
            id: "monthly-expense",
            connectorId: "cathaybk",
            accountId: "account-1",
            sourceId: "monthly-expense",
            postedDate: `${month}-03`,
            amount: -12_000,
            currency: "TWD",
            description: "生活支出",
            status: "posted",
          },
        ],
      }),
    });
  });

  await page.goto("/#/overview");
  const cashFlowSection = page.getByRole("region", { name: "本月收支" });
  await expect(cashFlowSection).toBeVisible();
  await expect(cashFlowSection.getByText("+NT$50,000")).toBeVisible();
  await expect(cashFlowSection.getByText("−NT$12,000")).toBeVisible();
  await expect(cashFlowSection.getByText("NT$38,000")).toBeVisible();
  await expect(page.getByRole("heading", { name: "資產配置" })).toHaveCount(0);
  const insightsSection = page.getByRole("region", { name: "值得留意" });
  await expect(
    insightsSection.getByText("目前沒有需要處理的事項"),
  ).toBeVisible();
  await expect(page.getByText(/存款佔全部資產/)).toHaveCount(0);

  await cashFlowSection.getByRole("button", { name: "查看活動 →" }).click();
  await expect(page).toHaveURL(/#\/activity$/);
});

test("filters activity by cash flow and keeps source filters composable", async ({
  page,
}) => {
  const month = new Date().toISOString().slice(0, 7);
  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [
          {
            id: "deposit-account",
            connectorId: "cathaybk",
            sourceId: "deposit-account",
            accountType: "deposit",
            currency: "TWD",
          },
          {
            id: "card-account",
            connectorId: "cathaybk",
            sourceId: "card-account",
            accountType: "credit",
            currency: "TWD",
          },
        ],
        transactions: [
          {
            id: "bank-income",
            connectorId: "cathaybk",
            accountId: "deposit-account",
            sourceId: "bank-income",
            postedDate: `${month}-02`,
            amount: 50_000,
            currency: "TWD",
            description: "薪資入帳",
            status: "posted",
          },
          {
            id: "bank-expense",
            connectorId: "cathaybk",
            accountId: "deposit-account",
            sourceId: "bank-expense",
            postedDate: `${month}-03`,
            amount: -18_000,
            currency: "TWD",
            description: "房租支出",
            status: "posted",
          },
          {
            id: "card-income",
            connectorId: "cathaybk",
            accountId: "card-account",
            sourceId: "card-income",
            postedDate: `${month}-04`,
            amount: 300,
            currency: "TWD",
            description: "信用卡退款",
            status: "posted",
          },
          {
            id: "card-expense",
            connectorId: "cathaybk",
            accountId: "card-account",
            sourceId: "card-expense",
            postedDate: `${month}-05`,
            amount: -600,
            currency: "TWD",
            description: "信用卡消費",
            status: "posted",
          },
        ],
      }),
    });
  });

  await page.goto("/#/activity");

  const activityRows = page.locator("tbody tr");
  const sourceFilters = page.getByRole("tablist", { name: "活動來源" });

  await expect(activityRows).toHaveCount(4);
  await page.getByRole("button", { name: "查看收入活動" }).click();
  await expect(activityRows).toHaveCount(2);
  await expect(activityRows.filter({ hasText: "薪資入帳" })).toBeVisible();
  await expect(activityRows.filter({ hasText: "信用卡退款" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "顯示全部活動" }),
  ).toHaveAttribute("aria-pressed", "true");

  await sourceFilters.getByRole("tab", { name: "銀行" }).click();
  await expect(activityRows).toHaveCount(1);
  await expect(activityRows).toContainText("薪資入帳");

  await page.getByRole("button", { name: "查看支出活動" }).click();
  await expect(activityRows).toHaveCount(1);
  await expect(activityRows).toContainText("房租支出");

  await sourceFilters.getByRole("tab", { name: "信用卡" }).click();
  await expect(activityRows).toHaveCount(1);
  await expect(activityRows).toContainText("信用卡消費");
});

test("uses app-like scrolling and history only in standalone display mode", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/is-standalone/);
  await expect(page.locator("html")).toHaveCSS("touch-action", "manipulation");

  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query !== "(display-mode: standalone)")
        return nativeMatchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      };
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  await expect(page.locator("html")).toHaveClass(/is-standalone/);
  await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(page.locator("#root")).toHaveCSS("touch-action", "pan-x pan-y");
  await expect(page.locator("#root")).toHaveCSS("overflow-y", "auto");
  await expect(page.locator("#root")).toHaveCSS("overscroll-behavior", "none");

  const historyLength = await page.evaluate(() => window.history.length);
  await page.getByRole("button", { name: "資產", exact: true }).last().click();
  await expect(page).toHaveURL(/#\/assets$/);
  await expect(
    page.getByRole("heading", { name: "資產", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});

test("opens a primary view from its hash route", async ({ page }) => {
  await page.goto("/#/invoices");
  await expect(
    page.getByRole("heading", { name: "發票", exact: true }),
  ).toBeVisible();
});

test("excludes a bank transaction from activity calculations and restores it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", {
      configurable: true,
      value: true,
    });
  });
  let excludedFromCalculation = false;
  const month = new Date().toISOString().slice(0, 7);

  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [
          {
            id: "account-1",
            connectorId: "cathaybk",
            sourceId: "account-source-1",
            institutionName: "測試銀行",
            accountName: "活期帳戶",
            accountType: "checking",
            currency: "TWD",
          },
        ],
        transactions: [
          {
            id: "transaction-1",
            connectorId: "cathaybk",
            accountId: "account-1",
            sourceId: "transaction-source-1",
            postedDate: `${month}-07`,
            amount: -8318,
            currency: "TWD",
            description: "台新卡費",
            status: "posted",
            excludedFromCalculation,
            classification: {
              categoryId: "other",
              label: "未分類",
              source: "fallback",
            },
          },
        ],
      }),
    });
  });
  await page.route(
    "**/api/bank/transactions/transaction-1/calculation",
    async (route) => {
      const body = route.request().postDataJSON() as {
        excludedFromCalculation: boolean;
      };
      excludedFromCalculation = body.excludedFromCalculation;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, excludedFromCalculation }),
      });
    },
  );

  await page.goto("/#/activity");
  await expect(page.locator("html")).toHaveClass(/is-standalone/);
  const expenseSlice = page.getByRole("button", {
    name: "未分類 100.0% NT$8,318",
  });
  await expect(expenseSlice).toBeVisible();

  await page.getByRole("button", { name: "查看 台新卡費 活動詳情" }).click();
  await expect(page.getByRole("heading", { name: "活動明細" })).toBeVisible();
  const desktopDetailDialog = page.getByRole("dialog", { name: "活動明細" });
  await page
    .getByRole("button", { name: "關閉活動明細" })
    .click({ position: { x: 20, y: 200 } });
  await expect(desktopDetailDialog).toBeHidden();

  await page.getByRole("button", { name: "查看 台新卡費 活動詳情" }).click();
  await page
    .getByRole("checkbox", { name: "排除 台新卡費 的統計計算" })
    .click();
  const calculationDialog = page.getByRole("dialog", {
    name: "排除統計計算",
  });
  await expect(calculationDialog).toBeVisible();
  await expect(
    calculationDialog.getByRole("checkbox", {
      name: "同時新增分類規則",
    }),
  ).not.toBeChecked();
  await calculationDialog.getByRole("button", { name: "取消" }).click();
  await expect(calculationDialog).toBeHidden();
  await expect(
    page.getByRole("checkbox", { name: "排除 台新卡費 的統計計算" }),
  ).not.toBeChecked();
  await expect(expenseSlice).toBeVisible();

  await page
    .getByRole("checkbox", { name: "排除 台新卡費 的統計計算" })
    .click();
  await calculationDialog.getByRole("button", { name: "確認排除" }).click();
  await expect(calculationDialog).toBeHidden();
  await expect(
    page.getByRole("checkbox", { name: "恢復 台新卡費 的統計計算" }),
  ).toBeChecked();
  await expect(expenseSlice).toBeHidden();
  await page.getByRole("button", { name: "返回活動列表" }).click();
  const excludedExpenseSlice = page.getByRole("button", {
    name: "未分類 0.0% NT$0",
  });
  await expect(excludedExpenseSlice).toBeVisible();
  await excludedExpenseSlice.click();
  await page.getByRole("button", { name: "查看 台新卡費 活動詳情" }).click();
  await expect(
    page.getByRole("checkbox", { name: "恢復 台新卡費 的統計計算" }),
  ).toBeChecked();

  await page.reload();
  await expect(excludedExpenseSlice).toBeVisible();
  await page.getByRole("button", { name: "查看 台新卡費 活動詳情" }).click();
  await expect(
    page.getByRole("checkbox", { name: "恢復 台新卡費 的統計計算" }),
  ).toBeChecked();

  await page
    .getByRole("checkbox", { name: "恢復 台新卡費 的統計計算" })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "排除 台新卡費 的統計計算" }),
  ).not.toBeChecked();
  await expect(expenseSlice).toBeVisible();

  await page.getByRole("button", { name: "返回活動列表" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("combobox", { name: "更新 台新卡費 分類" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "查看 台新卡費 活動詳情" }).click();
  const detailDialog = page.getByRole("dialog", { name: "活動明細" });
  const detailBox = await detailDialog.boundingBox();
  if (!detailBox) throw new Error("Mobile activity detail is not visible.");
  expect(detailBox.width).toBe(390);
  expect(detailBox.height).toBe(844);
  await expect(
    page.getByRole("combobox", { name: "更新 台新卡費 分類" }),
  ).toBeVisible();

  await detailDialog.evaluate((element) => {
    const start = new Touch({
      identifier: 1,
      target: element,
      clientX: 8,
      clientY: 300,
    });
    const end = new Touch({
      identifier: 1,
      target: element,
      clientX: 38,
      clientY: 420,
    });
    element.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        changedTouches: [start],
        targetTouches: [start],
        touches: [start],
      }),
    );
    element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        changedTouches: [end],
        targetTouches: [],
        touches: [],
      }),
    );
  });
  await expect(detailDialog).toBeVisible();

  await detailDialog.evaluate((element) => {
    const start = new Touch({
      identifier: 2,
      target: element,
      clientX: 8,
      clientY: 300,
    });
    const end = new Touch({
      identifier: 2,
      target: element,
      clientX: 108,
      clientY: 312,
    });
    element.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        changedTouches: [start],
        targetTouches: [start],
        touches: [start],
      }),
    );
    element.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        cancelable: true,
        changedTouches: [end],
        targetTouches: [],
        touches: [],
      }),
    );
  });
  await expect(detailDialog).toBeHidden();
});

test("can add a classification rule while excluding a transaction", async ({
  page,
}) => {
  const month = new Date().toISOString().slice(0, 7);
  let ruleBody: Record<string, unknown> | undefined;
  let overrideBody: Record<string, unknown> | undefined;

  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [],
        transactions: [
          {
            id: "fallback-transaction",
            connectorId: "cathaybk",
            accountId: "account-1",
            sourceId: "fallback-source",
            postedDate: `${month}-08`,
            amount: -1200,
            currency: "TWD",
            description: "每月家庭轉帳",
            status: "posted",
            excludedFromCalculation: false,
            classification: {
              categoryId: "other",
              label: "未分類",
              source: "fallback",
            },
          },
        ],
      }),
    });
  });
  await page.route(
    "**/api/bank/transactions/fallback-transaction/calculation",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          excludedFromCalculation: true,
        }),
      });
    },
  );
  await page.route(
    "**/api/classification/overrides/bank_transaction/fallback-transaction",
    async (route) => {
      overrideBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    },
  );
  await page.route("**/api/classification/rules", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    ruleBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: "user:new-rule", success: true }),
    });
  });

  await page.goto("/#/activity");
  await page
    .getByRole("button", { name: "查看 每月家庭轉帳 活動詳情" })
    .click();
  await page
    .getByRole("checkbox", { name: "排除 每月家庭轉帳 的統計計算" })
    .click();

  const dialog = page.getByRole("dialog", { name: "排除統計計算" });
  await dialog.getByRole("combobox", { name: "分類" }).selectOption("transfer");
  await dialog.getByRole("checkbox", { name: "同時新增分類規則" }).check();
  await dialog.getByRole("textbox").fill("每月家庭轉帳");
  await dialog.getByRole("button", { name: "確認排除" }).click();

  await expect(dialog).toBeHidden();
  expect(overrideBody).toEqual({ categoryId: "transfer" });
  expect(ruleBody).toMatchObject({
    categoryId: "transfer",
    targetType: "bank_transaction",
    field: "any_text",
    operator: "contains",
    pattern: "每月家庭轉帳",
    excludedFromCalculation: true,
  });
});

test("can modify an existing user rule while excluding a transaction", async ({
  page,
}) => {
  const month = new Date().toISOString().slice(0, 7);
  let updatedRuleBody: Record<string, unknown> | undefined;

  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [],
        transactions: [
          {
            id: "rule-transaction",
            connectorId: "cathaybk",
            accountId: "account-1",
            sourceId: "rule-source",
            postedDate: `${month}-09`,
            amount: -350,
            currency: "TWD",
            description: "固定轉帳",
            status: "posted",
            excludedFromCalculation: false,
            classification: {
              categoryId: "transfer",
              label: "轉帳",
              source: "user_rule",
              ruleId: "user:transfer-rule",
            },
          },
        ],
      }),
    });
  });
  await page.route(
    "**/api/bank/transactions/rule-transaction/calculation",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          excludedFromCalculation: true,
        }),
      });
    },
  );
  await page.route(
    "**/api/classification/rules/user%3Atransfer-rule",
    async (route) => {
      updatedRuleBody = route.request().postDataJSON() as Record<
        string,
        unknown
      >;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    },
  );

  await page.goto("/#/activity");
  await page.getByRole("button", { name: "查看 固定轉帳 活動詳情" }).click();
  await page
    .getByRole("checkbox", { name: "排除 固定轉帳 的統計計算" })
    .click();

  const dialog = page.getByRole("dialog", { name: "排除統計計算" });
  await expect(
    dialog.getByRole("checkbox", { name: "同時修改目前分類規則" }),
  ).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: "同時修改目前分類規則" }).check();
  await dialog.getByRole("button", { name: "確認排除" }).click();

  await expect(dialog).toBeHidden();
  expect(updatedRuleBody).toEqual({
    categoryId: "transfer",
    excludedFromCalculation: true,
  });
});

test("merges a matching invoice and counts an unmatched invoice as expense", async ({
  page,
}) => {
  const month = new Date().toISOString().slice(0, 7);
  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accounts: [
          {
            id: "card-1",
            connectorId: "sinopac",
            sourceId: "card-source-1",
            institutionName: "測試銀行",
            accountName: "測試信用卡",
            accountType: "credit",
            currency: "TWD",
          },
        ],
        transactions: [
          {
            id: "transaction-1",
            connectorId: "sinopac",
            accountId: "card-1",
            sourceId: "transaction-source-1",
            postedDate: `${month}-10`,
            authorizedAt: `${month}-10T12:00:00.000Z`,
            amount: -860,
            currency: "TWD",
            description: "信用卡消費",
            counterparty: "好食餐飲",
            status: "posted",
            excludedFromCalculation: false,
            classification: {
              categoryId: "food",
              label: "餐飲",
              source: "fallback",
            },
          },
        ],
      }),
    });
  });
  await page.route("**/api/invoices**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "invoice-matched",
          connectorId: "einvoice",
          sourceId: "invoice-source-1",
          invoiceDate: `${month}-10`,
          invoiceNumber: "AB12345678",
          sellerName: "好食餐飲有限公司",
          amount: 860,
          items: [],
        },
        {
          id: "invoice-unmatched",
          connectorId: "einvoice",
          sourceId: "invoice-source-2",
          invoiceDate: `${month}-08`,
          invoiceNumber: "CD12345678",
          sellerName: "未支援銀行商店",
          amount: 1490,
          items: [],
        },
      ]),
    });
  });

  await page.goto("/#/activity");

  await expect(
    page.getByRole("button", { name: "發票 63.4% NT$1,490" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "餐飲 36.6% NT$860" }),
  ).toBeVisible();
  await expect(
    page.getByText("−NT$2,350", { exact: true }).first(),
  ).toBeVisible();

  const activityRows = page.locator("tbody tr");
  await expect(activityRows).toHaveCount(2);
  const matchedActivityRow = activityRows.filter({
    hasText: "信用卡消費",
  });
  await expect(matchedActivityRow).toContainText("測試銀行");
  await expect(matchedActivityRow).toContainText("測試信用卡");
  await expect(matchedActivityRow).toContainText("已配對發票");
  await expect(matchedActivityRow).not.toContainText("好食餐飲有限公司");
  await expect(
    activityRows.filter({ hasText: "未支援銀行商店" }),
  ).toContainText("−NT$1,490");

  await page.getByRole("tab", { name: "發票", exact: true }).click();
  await expect(activityRows).toHaveCount(2);
  await page.getByRole("tab", { name: "信用卡", exact: true }).click();
  await expect(activityRows).toHaveCount(1);
});

test("manually maps, manages, and separates a same-day invoice transaction on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const month = new Date().toISOString().slice(0, 7);
  let mappings: Array<{
    invoiceId: string;
    transactionId: string | null;
    decision: "linked" | "separate";
    updatedAt: string;
  }> = [];

  await page.route("**/api/activity/invoice-mappings**", async (route) => {
    const request = route.request();
    const invoiceId = new URL(request.url()).pathname.split("/").at(-1)!;
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { transactionId: string };
      const preference = {
        invoiceId,
        transactionId: body.transactionId,
        decision: "linked" as const,
        updatedAt: new Date().toISOString(),
      };
      mappings = [preference];
      await route.fulfill({ json: preference });
      return;
    }
    if (request.method() === "DELETE") {
      const preference = {
        invoiceId,
        transactionId: null,
        decision: "separate" as const,
        updatedAt: new Date().toISOString(),
      };
      mappings = [preference];
      await route.fulfill({ json: preference });
      return;
    }
    await route.fulfill({ json: mappings });
  });
  await page.route("**/api/bank**", async (route) => {
    await route.fulfill({
      json: {
        accounts: [
          {
            id: "card-1",
            connectorId: "sinopac",
            sourceId: "card-source-1",
            institutionName: "測試銀行",
            accountName: "信用卡",
            accountType: "credit",
            currency: "TWD",
          },
        ],
        transactions: [
          {
            id: "synthetic-drink",
            connectorId: "sinopac",
            accountId: "card-1",
            sourceId: "transaction-source-1",
            postedDate: `${month}-06`,
            amount: 100,
            currency: "TWD",
            description: "測試飲料店",
            counterparty: "測試飲料店",
            status: "posted",
            excludedFromCalculation: false,
            classification: {
              categoryId: "food",
              label: "餐飲",
              source: "fallback",
            },
          },
          {
            id: "synthetic-meal",
            connectorId: "sinopac",
            accountId: "card-1",
            sourceId: "transaction-source-2",
            postedDate: `${month}-06`,
            amount: -250,
            currency: "TWD",
            description: "測試餐飲店",
            counterparty: "測試餐飲店",
            status: "posted",
            excludedFromCalculation: false,
            classification: {
              categoryId: "food",
              label: "餐飲",
              source: "fallback",
            },
          },
        ],
      },
    });
  });
  await page.route("**/api/invoices**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const invoice = {
      id: "invoice-1",
      connectorId: "einvoice",
      sourceId: "invoice-source-1",
      invoiceDate: `${month}-06T12:00:00.000Z`,
      invoiceNumber: "TEST-0001",
      sellerName: "合成發票商店",
      amount: 120,
    };
    await route.fulfill({
      json:
        path === "/api/invoices/invoice-1"
          ? {
              ...invoice,
              items: [
                {
                  id: "invoice-line-1",
                  sourceId: "invoice-line-source-1",
                  lineNumber: 1,
                  description: "測試品項",
                  quantity: 1,
                  unitPrice: 120,
                  amount: 120,
                },
              ],
            }
          : [invoice],
    });
  });

  await page.goto("/#/activity");
  await page
    .getByRole("button", { name: "查看 合成發票商店 活動詳情" })
    .click();
  await expect(page.getByText("測試品項", { exact: true })).toBeVisible();
  await expect(page.getByText("尚未找到銀行／信用卡交易")).toBeVisible();
  await page.getByRole("button", { name: "配對交易" }).click();
  await expect(
    page.getByRole("heading", { name: "選擇同日候選交易" }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: /^測試飲料店 測試銀行/,
    })
    .click();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(
    page.getByRole("heading", { name: "確認合併這兩筆？" }),
  ).toBeVisible();
  await expect(page.getByText("差額 NT$20", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "確認配對" }).click();

  await expect(page.getByText("已完成配對，活動只顯示一筆")).toBeVisible();
  const mappedActivityRow = page.getByRole("button", {
    name: "查看 測試飲料店 活動詳情",
  });
  await expect(mappedActivityRow).toContainText("測試銀行");
  await expect(mappedActivityRow).toContainText("信用卡 · 餐飲");
  await expect(mappedActivityRow).toContainText("已配對發票");
  await mappedActivityRow.click();
  const detail = page.getByRole("dialog", { name: "活動明細" });
  await expect(
    detail
      .getByText("銀行／信用卡原始名稱")
      .locator("..")
      .getByText("測試飲料店", { exact: true }),
  ).toBeVisible();
  await expect(
    detail
      .getByText("發票商家名稱")
      .locator("..")
      .getByText("合成發票商店", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "管理配對" }).click();
  await page.getByRole("button", { name: "解除並保持分開" }).click();
  await expect(page.getByText("已解除配對，兩筆活動將保持分開")).toBeVisible();
  await expect(page.getByText("合成發票商店").first()).toBeVisible();
  await expect(page.getByText("測試飲料店").first()).toBeVisible();
});

test("loads invoice line items only after expanding an invoice", async ({
  page,
}) => {
  const month = new Date().toISOString().slice(0, 7);
  let detailRequests = 0;
  const invoice = {
    id: "lazy-invoice",
    connectorId: "einvoice",
    sourceId: "lazy-source",
    invoiceDate: `${month}-12T10:00:00.000Z`,
    invoiceNumber: "AB12345678",
    sellerName: "延遲載入商店",
    amount: 120,
  };
  await page.route("**/api/invoices**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/invoices/lazy-invoice") {
      detailRequests += 1;
      await route.fulfill({
        json: {
          ...invoice,
          items: [
            {
              id: "lazy-line",
              sourceId: "lazy-line-source",
              lineNumber: 1,
              description: "延遲載入品項",
              quantity: 1,
              unitPrice: 120,
              amount: 120,
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({ json: [invoice] });
  });

  await page.goto("/#/invoices");
  await expect(page.getByText("延遲載入商店")).toBeVisible();
  expect(detailRequests).toBe(0);

  await page.getByRole("button", { name: /延遲載入商店/ }).click();
  await expect(page.getByText("延遲載入品項", { exact: true })).toBeVisible();
  expect(detailRequests).toBe(1);
});
