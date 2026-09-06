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
    else if (path === "/api/bank") body = { accounts: [], transactions: [] };
    else if (path.startsWith("/api/bank/")) body = [];
    else if (path === "/api/investments") body = [];
    else if (path === "/api/investment-transactions") body = [];
    else if (path === "/api/invoices") body = [];
    else if (path === "/api/activity/invoice-mappings") body = [];
    else if (path === "/api/manual-assets") body = [];
    else if (path === "/api/exchange-rates") body = [];
    else if (path === "/api/classification/categories") body = [];
    else throw new Error(`Unexpected API request in lazy-page test: ${path}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
});

test("loads a non-overview page on demand", async ({ page }) => {
  await page.goto("/#/assets");

  await expect(page.getByText("尚無資產資料", { exact: true })).toBeVisible();
});

test("shows a retry action when a lazy page fails to load", async ({
  page,
}) => {
  let shouldFail = true;
  await page.route(
    "**/src/features/activity/ActivityPage.svelte*",
    async (route) => {
      if (shouldFail) {
        shouldFail = false;
        await route.abort();
        return;
      }
      await route.continue();
    },
  );

  await page.goto("/#/activity");
  await expect(page.getByText("頁面載入失敗，請再試一次。")).toBeVisible();

  await page.getByRole("button", { name: "重新載入", exact: true }).click();
  await expect(page.getByPlaceholder("搜尋商家、銀行或分類")).toBeVisible();
});
