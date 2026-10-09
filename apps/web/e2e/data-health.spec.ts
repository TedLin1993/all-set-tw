import { expect, test } from "@playwright/test";

const width = 1440;
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
});

test("離頁儲存保留已完成時間及其他排程變更", async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  let schedule = {
    intervalMinutes: 1440,
    preferredTime: "07:30",
    preferredWeekday: 1,
  };
  const updates: (typeof schedule)[] = [];
  let releaseFirstSave = () => {};
  const firstSave = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/sync-schedule") {
      if (request.method() === "PUT") {
        const input = request.postDataJSON() as typeof schedule;
        updates.push(input);
        if (updates.length === 1) await firstSave;
        schedule = input;
      }
      return route.fulfill({
        json: {
          ...schedule,
          timezone: "Asia/Taipei",
          updatedAt: "2026-10-09T00:00:00Z",
        },
      });
    }
    return route.fulfill({
      json:
        path === "/api/runtime"
          ? { demoMode: false }
          : path === "/api/bank"
            ? { accounts: [], transactions: [] }
            : path === "/api/notifications/config"
              ? { enabled: false }
              : [],
    });
  });

  try {
    await page.goto("/#/exchange-rates");
    await page.getByRole("button", { name: "同步與通知", exact: true }).click();
    const timePicker = page
      .getByRole("button", { name: "選擇時間，目前 07:30", exact: true })
      .filter({ visible: true });
    await expect(timePicker).toBeEnabled();
    await page
      .getByRole("combobox", { name: "同步頻率", exact: true })
      .filter({ visible: true })
      .selectOption("10080");
    await expect.poll(() => updates.length).toBe(1);
    await page
      .getByRole("combobox", { name: "執行日", exact: true })
      .filter({ visible: true })
      .selectOption("5");
    await timePicker.click();
    await page
      .getByRole("combobox", { name: "小時", exact: true })
      .selectOption("09");
    await expect(
      page.getByRole("button", { name: "完成", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#\/exchange-rates$/);
    await expect(
      page.getByRole("region", { name: "匯率摘要", exact: true }),
    ).toBeVisible();
    releaseFirstSave();
    await expect
      .poll(() => updates)
      .toEqual([
        { intervalMinutes: 10080, preferredTime: "07:30", preferredWeekday: 1 },
        { intervalMinutes: 10080, preferredTime: "07:30", preferredWeekday: 5 },
      ]);
    await page.getByRole("button", { name: "同步與通知", exact: true }).click();
    await expect(timePicker).toBeVisible();
    await expect(
      page
        .getByRole("combobox", { name: "執行日", exact: true })
        .filter({ visible: true }),
    ).toHaveValue("5");
  } finally {
    releaseFirstSave();
  }
});
