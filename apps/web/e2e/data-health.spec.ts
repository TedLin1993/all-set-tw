import { expect, test } from "@playwright/test";

for (const state of ["unconfigured", "pending", "healthy", "failed"] as const) {
  test(`settings reports ${state} sync health accurately`, async ({ page }) => {
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      const jobs =
        state === "unconfigured"
          ? []
          : [
              {
                id: "esun:all",
                connectorId: "esun",
                scope: "all",
                configured: true,
                enabled: false,
                running: false,
                scheduleMode: "inherit",
                intervalMinutes: 1440,
                lastSuccessAt:
                  state === "pending" ? null : "2026-09-01T00:00:00Z",
                lastStatus:
                  state === "failed"
                    ? "failed"
                    : state === "healthy"
                      ? "success"
                      : null,
              },
            ];
      await route.fulfill({
        json:
          path === "/api/runtime"
            ? { demoMode: true }
            : path === "/api/bank"
              ? { accounts: [], transactions: [] }
              : path === "/api/sync-jobs"
                ? jobs
                : path === "/api/notifications/config"
                  ? { enabled: false }
                  : [],
      });
    });
    await page.goto("/#/settings");
    const health = page.locator('[aria-label="資料健康度"]');
    await expect(health).toContainText(
      {
        unconfigured: "尚未設定",
        pending: "等待首次同步",
        healthy: "大致正常",
        failed: "需要處理",
      }[state],
    );
    if (state === "unconfigured") {
      await expect(health).not.toContainText("0 / 0");
    } else {
      await expect(health).toContainText(
        state === "healthy" ? "1 / 1" : "0 / 1",
      );
    }
    if (state !== "healthy") await expect(health).not.toContainText("大致正常");
  });
}

for (const width of [1440, 390]) {
  test(`activity API failure can recover without misleading empty data at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let bankFailed = true;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) {
        await route.continue();
        return;
      }
      if (path === "/api/bank" && bankFailed) {
        await route.fulfill({
          status: 500,
          json: { error: { code: "TEST_FAILURE", message: "暫時無法載入" } },
        });
        return;
      }
      await route.fulfill({
        json:
          path === "/api/runtime"
            ? { demoMode: true }
            : path === "/api/bank"
              ? { accounts: [], transactions: [] }
              : [],
      });
    });
    await page.goto("/#/activity");
    await expect(page.getByRole("alert")).toContainText("部分資料載入失敗", {
      timeout: 15000,
    });
    await expect(
      page.getByText("沒有符合條件的活動。", { exact: true }),
    ).not.toBeVisible();
    bankFailed = false;
    await page.getByRole("button", { name: /重試|重新載入/ }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page
        .getByText("沒有符合條件的活動。", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    expect(overflows).toBe(false);
  });
}

test("classification rules retains its working form without the duplicate header action", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      json:
        path === "/api/runtime"
          ? { demoMode: true }
          : path === "/api/bank"
            ? { accounts: [], transactions: [] }
            : path === "/api/notifications/config"
              ? { enabled: false }
              : [],
    });
  });
  await page.goto("/#/classification-rules");
  await expect(page.getByText("＋ 新增規則", { exact: true })).toHaveCount(0);
  const add = page.getByRole("button", { name: "新增規則", exact: true });
  await expect(add).toBeVisible();
  await expect(add).toBeDisabled();
  await page.getByRole("textbox", { name: "關鍵字", exact: true }).fill("咖啡");
  await expect(add).toBeEnabled();
});
