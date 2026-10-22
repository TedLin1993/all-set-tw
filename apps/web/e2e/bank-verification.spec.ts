import { expect, test } from "@playwright/test";

for (const method of ["app", "email"] as const) {
  test(`中信 ${method} 驗證接續原登入，待確認期間不重新同步`, async ({
    page,
  }) => {
    let pending = false;
    let channel: "app" | "email" = "app";
    let approved = false;
    const requests: unknown[] = [];
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const job = {
      id: "ctbc:all",
      connectorId: "ctbc",
      scope: "all",
      configured: true,
      enabled: true,
      running: false,
      scheduleMode: "inherit",
      intervalMinutes: 60,
      preferredTime: "06:00",
      preferredWeekdays: [1],
      lastStatus: null as string | null,
      lastError: null as string | null,
      lastErrorCode: null as string | null,
      lastRunAt: null as string | null,
      lastSuccessAt: null as string | null,
      manualRun: null as Record<string, unknown> | null,
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (path === "/api/connectors/ctbc/sync") {
        const body = route.request().postDataJSON();
        requests.push(body);
        if (Object.keys(body).length === 0) {
          // 一般同步在背景執行；結束時留下需要驗證的錯誤代碼。
          pending = true;
          job.lastStatus = "needs_user_action";
          job.lastError = "需要確認這次登入。";
          job.lastErrorCode = "CTBC_APP_APPROVAL_REQUIRED";
          job.lastRunAt = new Date().toISOString();
          job.manualRun = {
            id: "manual-run",
            status: "needs_user_action",
            errorCode: job.lastErrorCode,
            lastError: job.lastError,
            createdAt: job.lastRunAt,
            completedAt: job.lastRunAt,
          };
          return route.fulfill({
            status: 202,
            json: {
              success: true,
              connectorId: "ctbc",
              scope: "all",
              status: "queued",
              runId: "manual-run",
            },
          });
        }
        if (body.verification === "email") channel = "email";
        if (
          (body.verification === "check" && approved) ||
          body.otp === "1234"
        ) {
          pending = false;
          job.lastStatus = "success";
          job.lastError = null;
          job.lastRunAt = new Date().toISOString();
          job.lastSuccessAt = job.lastRunAt;
          return route.fulfill({ json: { success: true, records: 1 } });
        }
        pending = true;
        job.lastStatus = "needs_user_action";
        job.lastError = "需要確認這次登入。";
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code:
                channel === "app"
                  ? "CTBC_APP_APPROVAL_REQUIRED"
                  : "CTBC_EMAIL_OTP_REQUIRED",
              message: "請完成登入驗證。",
            },
          },
        });
      }
      const data =
        path === "/api/runtime"
          ? { demoMode: false }
          : path === "/api/sync-jobs"
            ? [job]
            : path.endsWith("/settings")
              ? {
                  configured: true,
                  credentialsComplete: true,
                  verificationPending: pending,
                  verificationChannel: pending ? channel : null,
                  verificationExpiresAt: pending ? expiresAt : null,
                }
              : path === "/api/sync-schedule"
                ? {
                    intervalMinutes: 60,
                    preferredTime: "06:00",
                    preferredWeekdays: [1],
                  }
                : path === "/api/notifications/config"
                  ? { enabled: false }
                  : path === "/api/bank"
                    ? { accounts: [], transactions: [] }
                    : [];
      return route.fulfill({ json: data });
    });
    await page.goto("/#/data-sources");
    await page
      .getByRole("button", { name: "管理中國信託銀行", exact: true })
      .click();
    const details = page.getByRole("region", { name: "連接器詳情" });
    const sync = details.getByRole("button", { name: "同步", exact: true });
    await sync.click();
    const verification = page.getByRole("region", {
      name: "中信兩階段登入驗證",
    });
    await expect(verification).toBeVisible();
    await expect(sync).toBeDisabled();
    expect(requests).toEqual([{}]);
    if (method === "email") {
      await verification
        .getByRole("button", { name: "改用 Email 驗證", exact: true })
        .click();
      const submit = verification.getByRole("button", {
        name: "驗證並同步",
        exact: true,
      });
      await expect(submit).toBeDisabled();
      await verification
        .getByRole("textbox", { name: "Email 驗證碼", exact: true })
        .fill("1234");
      await submit.click();
      await expect
        .poll(() => requests)
        .toEqual([{}, { verification: "email" }, { otp: "1234" }]);
    } else {
      const confirm = verification.getByRole("button", {
        name: "我已確認，繼續同步",
        exact: true,
      });
      await confirm.click();
      await expect
        .poll(() => requests)
        .toEqual([{}, { verification: "check" }]);
      await expect(confirm).toBeEnabled();
      approved = true;
      await confirm.click();
      await expect
        .poll(() => requests)
        .toEqual([{}, { verification: "check" }, { verification: "check" }]);
    }
    await expect(verification).toHaveCount(0);
    await expect(
      details.getByText("狀態：正常", { exact: true }),
    ).toBeVisible();
  });
}

test("銀行手動驗證失敗可重試，送出驗證碼後完成同步", async ({ page }) => {
  const job = {
    id: "nextbank:all",
    connectorId: "nextbank",
    scope: "all",
    configured: true,
    enabled: false,
    running: false,
    scheduleMode: "custom",
    intervalMinutes: 10080,
    preferredTime: "06:00",
    preferredWeekday: 1,
    preferredWeekdays: [1],
    lastStatus: "failed",
    lastError: "將來銀行 API：transport",
    lastErrorCode: "TEST_TRANSPORT" as string | null,
    lastRunAt: "2026-09-28T01:05:00Z",
    lastSuccessAt: "2026-09-27T01:05:00Z",
    manualRun: null as Record<string, unknown> | null,
  };
  let recover = false;
  let syncCalls = 0;
  let verified = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/connectors/nextbank/sync") {
      syncCalls++;
      if (request.postDataJSON()?.captcha === "A1234") {
        verified = true;
        return route.fulfill({
          json: { success: true, records: 1, cursorUpdated: true },
        });
      }
      // 一般同步在背景執行；自動辨識失敗時以錯誤代碼要求人工驗證碼。
      job.lastStatus = "needs_user_action";
      job.lastError = "請重新取得圖片。";
      job.lastErrorCode = "NEXTBANK_CAPTCHA_REQUIRED";
      job.lastRunAt = new Date().toISOString();
      job.manualRun = {
        id: "manual-run",
        status: "needs_user_action",
        errorCode: job.lastErrorCode,
        lastError: job.lastError,
        createdAt: job.lastRunAt,
        completedAt: job.lastRunAt,
      };
      return route.fulfill({
        status: 202,
        json: {
          success: true,
          connectorId: "nextbank",
          scope: "all",
          status: "queued",
          runId: "manual-run",
        },
      });
    }
    if (path === "/api/connectors/nextbank/captcha") {
      if (!recover)
        return route.fulfill({
          status: 502,
          json: {
            error: {
              code: "TEST_TRANSPORT",
              message: "將來銀行 API：transport",
            },
          },
        });
      return route.fulfill({
        json: {
          captchaImage:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
          captchaLength: 5,
          captchaKind: "alphanumeric",
        },
      });
    }
    const data =
      path === "/api/runtime"
        ? { demoMode: false }
        : path === "/api/bank"
          ? { accounts: [], transactions: [] }
          : path === "/api/sync-jobs"
            ? [job]
            : path.endsWith("/settings")
              ? {
                  configured: true,
                  credentialsComplete: true,
                  sessionAvailable: false,
                }
              : path === "/api/sync-schedule"
                ? {
                    intervalMinutes: 10080,
                    preferredTime: "06:00",
                    preferredWeekday: 1,
                    preferredWeekdays: [1],
                  }
                : path === "/api/notifications/config"
                  ? { enabled: false }
                  : [];
    await route.fulfill({ json: data });
  });
  await page.goto("/#/data-sources");
  await page.getByRole("button", { name: "管理將來銀行", exact: true }).click();
  await page.getByRole("button", { name: "改用手動驗證", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("無法取得驗證碼");
  await expect(page.getByRole("alert")).toContainText(
    "手動驗證無法解決連線問題",
  );
  recover = true;
  await page.getByRole("button", { name: "同步帳戶", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "將來銀行圖形驗證碼" }),
  ).toBeVisible();
  const submit = page.getByRole("button", { name: "驗證並同步", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByRole("textbox", { name: /驗證碼/ }).fill("A1234");
  await submit.click();
  await expect(
    page.getByRole("status").filter({ hasText: "同步成功，帳戶資料已更新" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "將來銀行圖形驗證碼" }),
  ).toHaveCount(0);
  expect(verified).toBe(true);
  expect(syncCalls).toBe(2);
});

for (const source of [
  {
    id: "einvoice",
    title: "電子發票",
    scope: "all",
    path: "/api/connectors/einvoice/sync",
  },
  {
    id: "tdcc",
    title: "集保 e 存摺",
    scope: "bank",
    path: "/api/connectors/tdcc/sync/bank",
  },
]) {
  test(`${source.title} 停滯 run 可重試，沿用 scope 並追蹤到完成`, async ({
    page,
  }) => {
    const job = {
      id: `${source.id}:all`,
      connectorId: source.id,
      scope: "all",
      configured: true,
      enabled: false,
      running: true,
      phase: "stalled",
      runId: "existing-run",
      lockScope: source.scope,
      lastProgressAt: "2026-09-28T01:00:00Z",
      retryAfterSeconds: 0,
      scheduleMode: "custom",
      intervalMinutes: 1440,
      preferredTime: "06:00",
      preferredWeekday: 1,
      preferredWeekdays: [1],
      lastStatus: null as string | null,
      lastError: null,
      lastRunAt: null as string | null,
      lastSuccessAt: null as string | null,
    };
    let syncCalls = 0;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (path === source.path) {
        syncCalls++;
        job.phase = source.id === "tdcc" ? "bank" : "processing";
        return route.fulfill({
          status: 202,
          json: {
            success: true,
            connectorId: source.id,
            scope: source.scope,
            status: "queued",
            runId: "existing-run",
          },
        });
      }
      const data =
        path === "/api/runtime"
          ? { demoMode: false }
          : path === "/api/sync-jobs"
            ? [job]
            : path.endsWith("/settings")
              ? {
                  configured: true,
                  credentialsComplete: true,
                  sessionAvailable: job.lastStatus === "success",
                }
              : path === "/api/sync-schedule"
                ? {
                    intervalMinutes: 1440,
                    preferredTime: "06:00",
                    preferredWeekday: 1,
                    preferredWeekdays: [1],
                  }
                : path === "/api/notifications/config"
                  ? { enabled: false }
                  : path === "/api/bank"
                    ? { accounts: [], transactions: [] }
                    : [];
      return route.fulfill({ json: data });
    });
    await page.goto("/#/data-sources");
    await page
      .getByRole("button", { name: `管理${source.title}`, exact: true })
      .click();
    const details = page.getByRole("region", { name: "連接器詳情" });
    const retry = details.getByRole("button", {
      name: "重試同步",
      exact: true,
    });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(
      details.getByText(
        source.id === "tdcc" ? "狀態：正在查詢銀行資料" : "狀態：同步中",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
    job.running = false;
    job.lastStatus = "success";
    job.lastRunAt = "2026-09-28T01:05:00Z";
    job.lastSuccessAt = job.lastRunAt;
    await expect(
      details.getByText("狀態：正常", { exact: true }),
    ).toBeVisible();
    expect(syncCalls).toBe(1);
  });
}

test("國泰選擇簡訊驗證，驗證碼錯誤可重輸並完成首次同步", async ({ page }) => {
  const expiresAt = new Date(Date.now() + 240_000).toISOString();
  const settings = {
    configured: true,
    credentialsComplete: true,
    sessionAvailable: false,
    verificationPending: false,
    verificationChannel: null as "email" | "sms" | null,
    verificationExpiresAt: null as string | null,
  };
  const job = {
    id: "cathaybk:all",
    connectorId: "cathaybk",
    scope: "all",
    configured: true,
    enabled: true,
    running: false,
    scheduleMode: "inherit",
    intervalMinutes: 60,
    preferredTime: "06:00",
    preferredWeekdays: [1],
    lastStatus: null as string | null,
    lastError: null as string | null,
    lastErrorCode: null as string | null,
    lastRunAt: null as string | null,
    lastSuccessAt: null as string | null,
    manualRun: null as Record<string, unknown> | null,
  };
  const requests: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/connectors/cathaybk/sync") {
      const body = request.postDataJSON() ?? {};
      requests.push(body);
      if (!body.otpChannel) {
        // 一般同步在背景執行；結束時要求選擇驗證碼寄送方式。
        settings.verificationExpiresAt = expiresAt;
        job.lastStatus = "needs_user_action";
        job.lastError = "請選擇驗證方式。";
        job.lastErrorCode = "CATHAY_OTP_CHANNEL_REQUIRED";
        job.lastRunAt = new Date().toISOString();
        job.manualRun = {
          id: "manual-run",
          status: "needs_user_action",
          errorCode: job.lastErrorCode,
          lastError: job.lastError,
          createdAt: job.lastRunAt,
          completedAt: job.lastRunAt,
        };
        return route.fulfill({
          status: 202,
          json: {
            success: true,
            connectorId: "cathaybk",
            scope: "all",
            status: "queued",
            runId: "manual-run",
          },
        });
      }
      if (!body.otp) {
        settings.verificationPending = true;
        settings.verificationChannel = body.otpChannel;
        return route.fulfill({
          status: 400,
          json: {
            success: false,
            error: {
              code: "CATHAY_SMS_OTP_REQUIRED",
              message: "請輸入簡訊驗證碼。",
            },
          },
        });
      }
      if (body.otp !== "310307")
        return route.fulfill({
          status: 400,
          json: {
            success: false,
            error: {
              code: "CATHAY_OTP_INVALID",
              message: "國泰世華驗證碼錯誤或已逾時，請重新輸入或取得驗證碼。",
            },
          },
        });
      Object.assign(settings, {
        sessionAvailable: true,
        verificationPending: false,
        verificationChannel: null,
        verificationExpiresAt: null,
      });
      job.lastStatus = "success";
      job.lastErrorCode = null;
      job.lastSuccessAt = new Date().toISOString();
      job.lastRunAt = job.lastSuccessAt;
      return route.fulfill({
        json: { success: true, records: 1, cursorUpdated: true },
      });
    }
    const data =
      path === "/api/runtime"
        ? { demoMode: false }
        : path === "/api/sync-jobs"
          ? [job]
          : path.endsWith("/settings")
            ? settings
            : path === "/api/sync-schedule"
              ? {
                  intervalMinutes: 60,
                  preferredTime: "06:00",
                  preferredWeekday: 1,
                  preferredWeekdays: [1],
                }
              : path === "/api/notifications/config"
                ? { enabled: false }
                : path === "/api/bank"
                  ? { accounts: [], transactions: [] }
                  : [];
    return route.fulfill({ json: data });
  });
  await page.goto("/#/data-sources");
  await page
    .getByRole("button", { name: "管理國泰世華銀行", exact: true })
    .click();
  const details = page.getByRole("region", { name: "連接器詳情" });
  const syncButton = details.getByRole("button", { name: "同步", exact: true });
  await syncButton.click();
  await expect(
    details.getByText("需要額外驗證", { exact: true }),
  ).toBeVisible();
  await expect(syncButton).toBeDisabled();
  await details.getByRole("button", { name: "使用簡訊", exact: true }).click();
  await expect(
    details.getByText("簡訊驗證碼已寄出", { exact: true }),
  ).toBeVisible();
  const otp = details.getByRole("textbox", { name: "驗證碼後 6 位數字" });
  const verify = details.getByRole("button", {
    name: "驗證並完成首次同步",
    exact: true,
  });
  await otp.fill("000000");
  await verify.click();
  await expect(
    details.getByText("國泰世華驗證碼錯誤或已逾時，請重新輸入或取得驗證碼。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(otp).toHaveValue("");
  await otp.fill("310307");
  await verify.click();
  await expect(details.getByText("簡訊驗證碼已寄出")).toHaveCount(0);
  await expect(details.getByText(/國泰世華驗證碼錯誤/)).toHaveCount(0);
  await expect(syncButton).toBeEnabled();
  expect(requests).toEqual([
    {},
    { otpChannel: "sms" },
    { otp: "000000", otpChannel: "sms" },
    { otp: "310307", otpChannel: "sms" },
  ]);
});

test("兆豐簡訊 OTP 錯誤可原地重輸，驗證後完成同步", async ({ page }) => {
  const job = {
    id: "megabank:all",
    connectorId: "megabank",
    scope: "all",
    configured: true,
    enabled: true,
    running: false,
    scheduleMode: "inherit",
    intervalMinutes: 60,
    preferredTime: "06:00",
    preferredWeekdays: [1],
    lastStatus: null as string | null,
    lastError: null as string | null,
    lastErrorCode: null as string | null,
    lastRunAt: null as string | null,
    lastSuccessAt: null as string | null,
    manualRun: null as Record<string, unknown> | null,
  };
  const requests: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/connectors/megabank/sync") {
      const body = request.postDataJSON() ?? {};
      requests.push(body);
      if (!body.otp) {
        // 一般同步在背景執行；異地登入時要求簡訊 OTP。
        job.lastStatus = "needs_user_action";
        job.lastError = "兆豐銀行已寄出簡訊驗證碼，請於時限內輸入。";
        job.lastErrorCode = "MEGABANK_SMS_OTP_REQUIRED";
        job.lastRunAt = new Date().toISOString();
        job.manualRun = {
          id: "manual-run",
          status: "needs_user_action",
          errorCode: job.lastErrorCode,
          lastError: job.lastError,
          createdAt: job.lastRunAt,
          completedAt: job.lastRunAt,
        };
        return route.fulfill({
          status: 202,
          json: {
            success: true,
            connectorId: "megabank",
            scope: "all",
            status: "queued",
            runId: "manual-run",
          },
        });
      }
      if (body.otp !== "123456")
        return route.fulfill({
          status: 400,
          json: {
            success: false,
            error: {
              code: "MEGABANK_OTP_INVALID",
              message: "兆豐簡訊驗證碼錯誤，請重新輸入。",
            },
          },
        });
      job.lastStatus = "success";
      job.lastErrorCode = null;
      job.lastSuccessAt = new Date().toISOString();
      job.lastRunAt = job.lastSuccessAt;
      return route.fulfill({
        json: { success: true, records: 1, cursorUpdated: true },
      });
    }
    const data =
      path === "/api/runtime"
        ? { demoMode: false }
        : path === "/api/sync-jobs"
          ? [job]
          : path.endsWith("/settings")
            ? {
                configured: true,
                credentialsComplete: true,
                sessionAvailable: false,
              }
            : path === "/api/sync-schedule"
              ? {
                  intervalMinutes: 60,
                  preferredTime: "06:00",
                  preferredWeekday: 1,
                  preferredWeekdays: [1],
                }
              : path === "/api/notifications/config"
                ? { enabled: false }
                : path === "/api/bank"
                  ? { accounts: [], transactions: [] }
                  : [];
    return route.fulfill({ json: data });
  });
  await page.goto("/#/data-sources");
  await page.getByRole("button", { name: "管理兆豐銀行", exact: true }).click();
  const details = page.getByRole("region", { name: "連接器詳情" });
  const syncButton = details.getByRole("button", {
    name: "自動驗證並同步",
    exact: true,
  });
  await syncButton.click();
  await expect(
    details.getByText("簡訊驗證碼已寄出", { exact: true }),
  ).toBeVisible();
  await expect(syncButton).toBeDisabled();
  const otp = details.getByRole("textbox", { name: "簡訊驗證碼" });
  const verify = details.getByRole("button", {
    name: "驗證並同步",
    exact: true,
  });
  await otp.fill("000000");
  await verify.click();
  await expect(
    details.getByText("兆豐簡訊驗證碼錯誤，請重新輸入。").first(),
  ).toBeVisible();
  await expect(otp).toHaveValue("");
  await otp.fill("123456");
  await verify.click();
  await expect(details.getByText("簡訊驗證碼已寄出")).toHaveCount(0);
  await expect(syncButton).toBeEnabled();
  expect(requests).toEqual([{}, { otp: "000000" }, { otp: "123456" }]);
});

test("集保依序完成 Email 與簡訊驗證並完成首次同步", async ({ page }) => {
  const settings = {
    configured: true,
    credentialsComplete: true,
    sessionAvailable: false,
  };
  const job = {
    id: "tdcc:all",
    connectorId: "tdcc",
    scope: "all",
    configured: true,
    enabled: true,
    running: false,
    scheduleMode: "inherit",
    intervalMinutes: 60,
    preferredTime: "06:00",
    preferredWeekdays: [1],
    lastStatus: null as string | null,
    lastError: null as string | null,
    lastErrorCode: null as string | null,
    lastRunAt: null as string | null,
    lastSuccessAt: null as string | null,
  };
  const requests: unknown[] = [];
  const queued = {
    status: 202,
    json: {
      success: true,
      connectorId: "tdcc",
      scope: "all",
      status: "queued",
      runId: "tdcc-run",
    },
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/connectors/tdcc/sync") {
      const body = request.postDataJSON() ?? {};
      requests.push(body);
      job.lastRunAt = new Date().toISOString();
      if (!body.otp) {
        // 登入在背景執行；集保要求裝置驗證時寄出 Email 驗證碼。
        job.lastStatus = "needs_user_action";
        job.lastError = "TDCC 驗證碼已寄至電子信箱，請輸入驗證碼以完成連線。";
        job.lastErrorCode = "TDCC_EMAIL_OTP_REQUIRED";
        return route.fulfill(queued);
      }
      if (body.otpChannel === "email")
        return route.fulfill({
          status: 400,
          json: {
            success: false,
            error: {
              code: "TDCC_SMS_OTP_REQUIRED",
              message: "TDCC 驗證碼已寄至手機簡訊，請輸入驗證碼以完成連線。",
            },
          },
        });
      settings.sessionAvailable = true;
      job.lastStatus = "success";
      job.lastErrorCode = null;
      job.lastSuccessAt = job.lastRunAt;
      return route.fulfill(queued);
    }
    const data =
      path === "/api/runtime"
        ? { demoMode: false }
        : path === "/api/sync-jobs"
          ? [job]
          : path.endsWith("/settings")
            ? settings
            : path === "/api/sync-schedule"
              ? {
                  intervalMinutes: 60,
                  preferredTime: "06:00",
                  preferredWeekday: 1,
                  preferredWeekdays: [1],
                }
              : path === "/api/notifications/config"
                ? { enabled: false }
                : path === "/api/bank"
                  ? { accounts: [], transactions: [] }
                  : [];
    return route.fulfill({ json: data });
  });
  await page.goto("/#/data-sources");
  await page
    .getByRole("button", { name: "管理集保 e 存摺", exact: true })
    .click();
  const details = page.getByRole("region", { name: "連接器詳情" });
  await details
    .getByRole("button", { name: "連線並取得驗證碼", exact: true })
    .click();
  await expect(
    details.getByText("Email 驗證碼已寄出", { exact: true }),
  ).toBeVisible();
  const otp = details.getByRole("textbox", { name: "一次性驗證碼" });
  const verify = details.getByRole("button", {
    name: "驗證並完成首次同步",
    exact: true,
  });
  await otp.fill("111111");
  await verify.click();
  await expect(
    details.getByText("簡訊驗證碼已寄出", { exact: true }),
  ).toBeVisible();
  await expect(otp).toHaveValue("");
  await otp.fill("654321");
  await verify.click();
  await expect(details.getByText("簡訊驗證碼已寄出")).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "更新並重新連線", exact: true }),
  ).toBeVisible();
  expect(requests).toEqual([
    {},
    { otp: "111111", otpChannel: "email" },
    { otp: "654321", otpChannel: "sms" },
  ]);
});
