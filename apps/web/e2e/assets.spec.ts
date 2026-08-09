import { expect, test } from "@playwright/test";

const bankData = {
  accounts: [
    {
      id: "taishin-deposit",
      connectorId: "taishin",
      sourceId: "deposit-812",
      institutionName: "台新銀行",
      bankCode: "812",
      accountName: "薪轉戶",
      accountType: "savings",
      balance: 742_880,
      currency: "TWD",
      asOfAt: "2026-08-08T14:30:00+08:00",
    },
    {
      id: "taishin-card",
      connectorId: "taishin",
      sourceId: "card-812",
      institutionName: "台新銀行",
      bankCode: "812",
      accountName: "台新信用卡",
      accountType: "credit",
      balance: -10_060,
      currency: "TWD",
      paymentDueDate: "2026-08-20",
    },
    {
      id: "obank-usd",
      connectorId: "obank",
      sourceId: "deposit-048",
      institutionName: "王道銀行",
      bankCode: "048",
      accountName: "美元活存",
      accountType: "savings",
      balance: 1_000,
      currency: "USD",
      asOfAt: "2026-08-08T12:00:00+08:00",
    },
  ],
  transactions: [],
};

test.beforeEach(async ({ page }) => {
  const manualAssets = [
    {
      id: "home",
      name: "自住房屋",
      category: "real_estate",
      note: null,
      currency: "TWD",
      createdAt: "2026-01-01",
      value: 1_600_000,
      date: "2026-08-03",
    },
  ];
  const manualAssetHistory = new Map([
    ["home", [{ date: "2026-08-03", value: 1_600_000 }]],
  ]);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    let body: unknown;
    if (path === "/api/runtime") body = { demoMode: true };
    else if (path === "/api/bank") body = bankData;
    else if (path === "/api/bank/bills")
      body = [
        {
          id: "bill-1",
          connectorId: "taishin",
          accountId: "taishin-card",
          sourceId: "bill-1",
          billingPeriod: "2026-08",
          statementAmount: 10_060,
          isPaid: 0,
          paymentDueDate: "2026-08-20",
          currency: "TWD",
        },
        {
          id: "bill-2",
          connectorId: "taishin",
          accountId: "taishin-card",
          sourceId: "bill-2",
          billingPeriod: "2026-07",
          statementAmount: 8_000,
          isPaid: null,
          paymentDueDate: "2026-07-20",
          currency: "TWD",
        },
      ];
    else if (path === "/api/investments")
      body = [
        {
          id: "0050",
          assetType: "etf",
          symbol: "0050",
          name: "元大台灣50",
          quantity: 1_000,
          marketValue: 925_000,
          currency: "TWD",
          asOfDate: "2026-08-08",
        },
        {
          id: "00878",
          assetType: "etf",
          symbol: "00878",
          name: "國泰永續高股息",
          quantity: 10_000,
          marketValue: 268_800,
          currency: "TWD",
          asOfDate: "2026-08-08",
        },
      ];
    else if (path === "/api/investment-transactions")
      body = [
        {
          id: "trade-1",
          connectorId: "tdcc",
          accountId: "tdcc",
          sourceId: "trade-1",
          name: "元大台灣50",
          assetType: "etf",
          transactionName: "買進",
          tradeDate: "2026-08-01",
          quantity: 100,
          currency: "TWD",
        },
      ];
    else if (path === "/api/manual-assets" && method === "GET")
      body = manualAssets;
    else if (path === "/api/manual-assets" && method === "POST") {
      const input = route.request().postDataJSON();
      const id = `manual-${manualAssets.length + 1}`;
      manualAssets.push({
        id,
        name: input.name,
        category: input.category,
        note: input.note || null,
        currency: input.currency,
        createdAt: "2026-08-09",
        value: input.value,
        date: input.date,
      });
      manualAssetHistory.set(id, [{ date: input.date, value: input.value }]);
      body = { id };
    } else if (
      path.match(/^\/api\/manual-assets\/[^/]+\/history$/) &&
      method === "GET"
    ) {
      const assetId = path.split("/")[3]!;
      body = manualAssetHistory.get(assetId) ?? [];
    } else if (path === "/api/exchange-rates")
      body = [{ currency: "USD", rateTwd: 32, updatedAt: "2026-08-08" }];
    else throw new Error(`Unexpected assets E2E request: ${path}`);

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
});

test("uses the desktop asset ledger without losing detail workflows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/assets");

  await expect(
    page.getByRole("heading", { name: "資產清冊", exact: true }),
  ).toBeVisible();

  const ledger = page
    .locator('section[aria-label="資產清冊"]')
    .filter({ visible: true });
  await expect(ledger.getByText("薪轉戶", { exact: true })).toBeVisible();
  await ledger.locator("summary").filter({ hasText: "查看信用卡帳單" }).click();
  await expect(
    ledger.getByText("2026-08 · 期限 2026/8/20 · 待繳"),
  ).toBeVisible();
  await expect(
    ledger.getByText("2026-07 · 期限 2026/7/20 · 狀態未提供"),
  ).toBeVisible();
  await ledger.getByRole("button", { name: /^投資/ }).click();
  await expect(
    page.getByRole("heading", { name: "投資工作區", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "交易紀錄", exact: true }).click();
  await expect(page.getByText("買進 · 2026/8/1")).toBeVisible();

  await ledger.getByRole("button", { name: /^其他資產/ }).click();
  await expect(page.getByText("自住房屋", { exact: true })).toBeVisible();
  const manageHistory = ledger.getByRole("button", {
    name: "管理估值歷史",
    exact: true,
  });
  await manageHistory.click();
  await expect(
    ledger.getByRole("heading", { name: "估值歷史", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/assets$/);

  const addAsset = ledger.getByRole("button", {
    name: "新增資產",
    exact: true,
  });
  await addAsset.click();
  const editor = page.getByRole("dialog", { name: "新增資產" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("名稱")).toBeFocused();
  await editor.getByLabel("名稱").fill("緊急預備金");
  await editor.getByLabel("目前估值").fill("300000");
  await editor.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(ledger.getByText("緊急預備金", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/assets$/);

  await addAsset.click();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(addAsset).toBeFocused();
});

test("keeps the mobile ledger readable and expandable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/assets");

  const taishin = page.getByRole("button", { name: /^台 台新銀行/ });
  await expect(taishin).toHaveAttribute("aria-expanded", "true");
  const ledger = page
    .locator('section[aria-label="資產清冊"]')
    .filter({ visible: true });
  await expect(ledger.getByText("薪轉戶", { exact: true })).toBeVisible();
  await expect(
    page.getByText("信用卡負債", { exact: true }).first(),
  ).toBeVisible();
  await ledger.getByRole("button", { name: /^其他資產/ }).click();
  await expect(
    ledger.getByRole("button", { name: "管理估值歷史", exact: true }),
  ).toBeHidden();
  const homeAsset = ledger.getByRole("button", {
    name: /^自住房屋/,
  });
  await homeAsset.click();
  await expect(
    ledger.getByRole("heading", { name: "估值歷史", exact: true }),
  ).toBeVisible();
  await homeAsset.click();
  await expect(
    ledger.getByRole("heading", { name: "估值歷史", exact: true }),
  ).toBeHidden();
  const addAsset = ledger.getByRole("button", {
    name: "新增資產",
    exact: true,
  });
  await addAsset.click();
  await expect(page.getByRole("dialog", { name: "新增資產" })).toBeVisible();
  await expect(page).toHaveURL(/#\/assets$/);
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
});
