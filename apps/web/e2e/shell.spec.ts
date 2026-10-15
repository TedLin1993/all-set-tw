import { expect, test } from "@playwright/test";

/** 只比對 API 路徑；開發模式的 `/@fs/.../shared/api/*.ts` 模組不得被當成 API 攔截。 */
function isApiPath(prefix: string) {
  return (url: URL) => url.pathname.startsWith(prefix);
}

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
    else if (path === "/api/sync-reports/latest") body = null;
    else if (path === "/api/classification/categories")
      body = [
        { id: "food", label: "餐飲", sortOrder: 1, isSystem: true },
        { id: "other", label: "未分類", sortOrder: 2, isSystem: true },
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

  await page.route(isApiPath("/api/bank"), async (route) => {
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
  const expenseSlice = page.getByRole("button", {
    name: "未分類 100.0% NT$8,318",
  });
  await expect(expenseSlice).toBeVisible();

  await page.getByRole("button", { name: "查看 台新卡費 活動詳情" }).click();
  await expect(page.getByRole("heading", { name: "活動明細" })).toBeVisible();
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

  await page.route(
    isApiPath("/api/activity/invoice-mappings"),
    async (route) => {
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
    },
  );
  await page.route(isApiPath("/api/bank"), async (route) => {
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
  await page.route(isApiPath("/api/invoices"), async (route) => {
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
