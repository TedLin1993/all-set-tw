import { expect, test, type Page, type Request } from "@playwright/test";
import type {
  ConnectorSettingsResponse,
  SinotradeConnectionResponse,
  SinotradeVerificationChallenge,
} from "@taiwan-fin-hub/shared";

type ApiResponse = { json: unknown; status?: number };
type Handler = (
  path: string,
  request: Request,
) => ApiResponse | Promise<ApiResponse>;

function createSettings(
  overrides: Partial<ConnectorSettingsResponse> = {},
): ConnectorSettingsResponse {
  return {
    connectorId: "sinotrade",
    configured: true,
    credentialsComplete: true,
    sessionAvailable: false,
    verificationPending: false,
    verificationChannel: null,
    verificationExpiresAt: null,
    sinotradePlatforms: { newweb: false, savings: false },
    publicConfig: null,
    updatedAt: "2027-01-01T00:00:00Z",
    ...overrides,
  };
}

function challengeResponse(
  platform: "newweb" | "savings",
  challenge: SinotradeVerificationChallenge,
  expiresAt = new Date(Date.now() + 240_000).toISOString(),
): SinotradeConnectionResponse {
  return { status: "verification_required", platform, challenge, expiresAt };
}

const otpChallenge: SinotradeVerificationChallenge = {
  step: "otp",
  fields: [
    {
      key: "otp",
      label: "一次性驗證碼",
      action: "verify_otp",
      maxLength: 6,
    },
  ],
  actions: ["verify_otp"],
  message: "驗證碼已寄出，請輸入收到的驗證碼。",
};
const otpChannelChallenge: SinotradeVerificationChallenge = {
  step: "otp",
  fields: [
    {
      key: "otpChannel",
      label: "驗證碼收取方式",
      action: "request_otp",
      type: "choice",
      options: [
        { value: "0", label: "手機" },
        { value: "1", label: "Email信箱" },
      ],
    },
  ],
  actions: ["request_otp"],
  message: "請選擇驗證碼收取方式，再按「寄送驗證碼」。",
};
const otpTargetChallenge: SinotradeVerificationChallenge = {
  step: "otp",
  fields: [
    {
      key: "otpChannel",
      label: "驗證碼收取方式",
      action: "request_otp",
      type: "choice",
      options: [
        { value: "0", label: "手機" },
        { value: "1", label: "Email信箱" },
      ],
      value: "1",
    },
    {
      key: "otpTarget",
      label: "接收驗證碼的手機或信箱",
      action: "request_otp",
      type: "choice",
      options: [
        { value: "0", label: "已登記手機" },
        { value: "1", label: "已登記 Email信箱" },
      ],
      value: "0",
    },
  ],
  actions: ["request_otp"],
  message: "請確認驗證碼接收地址，再按「寄送驗證碼」。",
};
const termsChallenge: SinotradeVerificationChallenge = {
  step: "terms",
  fields: [
    {
      key: "agreement",
      label: "我已閱讀並同意憑證作業條款",
      action: "accept_terms",
      type: "checkbox",
    },
  ],
  actions: ["accept_terms"],
  message: "請先閱讀下方條款，確認後勾選同意再繼續。",
  document: {
    title: "憑證作業條款",
    text: "一、本公司使用電子憑證提供網路下單。\n二、用戶應妥善保管憑證。",
  },
};
const readyChallenge: SinotradeVerificationChallenge = {
  step: "ready",
  fields: [],
  actions: [],
  message: "目前平台的登入驗證已完成。",
};

async function setupApi(
  page: Page,
  settings: ConnectorSettingsResponse,
  handler: Handler,
) {
  const savedConfigs: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/connectors/sinotrade/settings") {
      if (request.method() === "PUT") {
        savedConfigs.push(request.postDataJSON());
        settings.configured = true;
        settings.credentialsComplete = true;
        settings.sessionAvailable = false;
        settings.verificationPending = false;
        settings.sinotradePlatforms = { newweb: false, savings: false };
        settings.updatedAt = "2027-01-01T00:01:00Z";
      }
      return route.fulfill({ json: settings });
    }
    if (path.startsWith("/api/connectors/sinotrade/"))
      return route.fulfill(await handler(path, request));
    if (path === "/api/sync-jobs")
      return route.fulfill({
        json: [
          {
            id: "sinotrade:all",
            connectorId: "sinotrade",
            scope: "all",
            configured: true,
            enabled: false,
            running: false,
            phase: null,
            lastStatus: null,
            lastError: null,
            lastErrorCode: null,
            lastRunAt: null,
            lastSuccessAt: null,
            manualRun: null,
            scheduleMode: "inherit",
            intervalMinutes: 1440,
            preferredTime: "06:00",
            preferredWeekdays: [1],
          },
        ],
      });
    const body =
      path === "/api/runtime"
        ? { demoMode: false }
        : path === "/api/sync-schedule"
          ? {
              intervalMinutes: 1440,
              preferredTime: "06:00",
              preferredWeekdays: [1],
              timezone: "Asia/Taipei",
              updatedAt: "2027-01-01T00:00:00Z",
            }
          : path === "/api/notifications/config"
            ? { enabled: false }
            : path === "/api/summary"
              ? {
                  totalAssetsTwd: 0,
                  totalLiabilitiesTwd: 0,
                  netWorthTwd: 0,
                  monthlyIncomeTwd: 0,
                  monthlyExpenseTwd: 0,
                  accounts: 0,
                  investments: 0,
                  transactions: 0,
                }
              : [];
    return route.fulfill({ json: body });
  });
  return savedConfigs;
}

async function openSinotrade(page: Page) {
  await page.goto("/#/data-sources");
  await page
    .getByRole("button", { name: "管理永豐金證券", exact: true })
    .click();
  return page.getByRole("region", { name: "連接器詳情" });
}

test("單一主按鈕儲存帳密並於雙平台驗證完成後才同步", async ({ page }) => {
  const settings = createSettings({
    configured: false,
    credentialsComplete: false,
  });
  const requests: Array<{ path: string; body: unknown }> = [];
  let current = challengeResponse("newweb", {
    step: "birthday",
    fields: [
      {
        key: "birthday",
        label: "生日",
        action: "submit_birthday",
        hint: "請輸入西元年月日",
        maxLength: 8,
      },
    ],
    actions: ["submit_birthday"],
    message: "首次連線需要生日與驗證碼。",
  });
  let completions = 0;
  let syncCalls = 0;
  let verificationRequests = 0;
  let birthdaySubmissions = 0;
  let requestOtpStage = 0;
  let releaseOtpRequest: () => void = () => {};
  const otpRequestGate = new Promise<void>((resolve) => {
    releaseOtpRequest = resolve;
  });
  const savedConfigs = await setupApi(page, settings, async (path, request) => {
    expect(request.method()).toBe("POST");
    const body = request.postData() ? request.postDataJSON() : undefined;
    requests.push({ path, body });
    if (path === "/api/connectors/sinotrade/sync") {
      expect(settings.sinotradePlatforms).toEqual({
        newweb: true,
        savings: true,
      });
      expect(completions).toBe(2);
      syncCalls++;
      return { json: { success: true, records: 0 } };
    }
    if (path === "/api/connectors/sinotrade/connect") {
      expect(body).toEqual({});
      expect(settings.credentialsComplete).toBe(true);
      settings.verificationPending = true;
      return { json: current };
    }
    if (path === "/api/connectors/sinotrade/connect/verify") {
      verificationRequests++;
      switch (body.action) {
        case "request_otp":
          if (requestOtpStage === 0) {
            expect(body.values).toEqual({ otpChannel: "1" });
            requestOtpStage = 1;
            current = challengeResponse("newweb", otpTargetChallenge);
          } else {
            expect(body.values).toEqual({ otpChannel: "1", otpTarget: "0" });
            requestOtpStage = 2;
            current = challengeResponse("newweb", otpChallenge);
          }
          break;
        case "verify_otp":
          expect(body.values).toEqual({ otp: "246810" });
          current = challengeResponse("newweb", termsChallenge);
          break;
        case "accept_terms":
          expect(body.values).toEqual({ agreement: "true" });
          current = challengeResponse("newweb", readyChallenge);
          break;
        case "confirm_certificate":
          expect(body.values).toEqual({});
          current = challengeResponse("savings", {
            step: "birthday",
            fields: [
              {
                key: "birthdayYear",
                label: "出生年",
                action: "submit_birthday",
                maxLength: 4,
              },
              {
                key: "birthdayMonth",
                label: "出生月",
                action: "submit_birthday",
                maxLength: 2,
              },
              {
                key: "birthdayDay",
                label: "出生日",
                action: "submit_birthday",
                maxLength: 2,
              },
            ],
            actions: ["submit_birthday"],
          });
          break;
        case "submit_birthday":
          if (birthdaySubmissions++ === 0) {
            expect(body.values).toEqual({ birthday: "19900101" });
            await otpRequestGate;
            current = challengeResponse("newweb", otpChannelChallenge);
            break;
          }
          expect(body.values).toEqual({
            birthdayYear: "1990",
            birthdayMonth: "01",
            birthdayDay: "01",
          });
          current = challengeResponse("savings", readyChallenge);
          break;
        default:
          throw new Error("Unexpected verification action");
      }
      return { json: current };
    }
    if (path === "/api/connectors/sinotrade/connect/complete") {
      expect(syncCalls).toBe(0);
      expect(body).toEqual({});
      completions++;
      if (completions === 1) {
        settings.sinotradePlatforms = { newweb: true, savings: false };
        current = challengeResponse("savings", {
          step: "certificate",
          fields: [],
          actions: ["confirm_certificate"],
        });
        return { json: current };
      }
      settings.verificationPending = false;
      settings.sessionAvailable = true;
      settings.sinotradePlatforms = { newweb: true, savings: true };
      return { json: { status: "connected", success: true } };
    }
    if (path === "/api/connectors/sinotrade/connect/status")
      return { json: current };
    throw new Error("Unexpected request: " + path);
  });

  const details = await openSinotrade(page);
  const verification = details.getByRole("region", {
    name: "永豐證券連線驗證",
  });
  const currentStep = details
    .getByRole("list", { name: "永豐證券連線進度" })
    .locator('[aria-current="step"]');
  const save = details.getByRole("button", { name: "儲存憑證", exact: true });
  const primary = details.getByRole("button", { name: /^(同步|連線並同步)$/ });
  const userId = details.locator('input[name="tfh-sinotrade-userId"]');
  const password = details.locator('input[name="tfh-sinotrade-password"]');
  await expect(primary).toHaveCount(1);
  await expect(currentStep).toContainText("儲存登入憑證");
  await expect(
    details.getByRole("button", { name: "連線永豐證券", exact: true }),
  ).toHaveCount(0);
  await primary.click();
  await expect(
    details.getByText(/請輸入身分證字號與證券網路密碼/),
  ).toBeVisible();
  expect(savedConfigs).toEqual([]);
  expect(requests).toEqual([]);
  await userId.click();
  await userId.fill("X123456789");
  await password.click();
  await password.fill("fixture-password");
  await primary.click();
  await expect(verification.getByLabel("生日", { exact: true })).toBeVisible();
  expect(savedConfigs).toEqual([
    { config: { userId: "X123456789", password: "fixture-password" } },
  ]);
  await expect(userId).toHaveValue("");
  await expect(password).toHaveValue("");
  await expect(currentStep).toContainText("驗證新理財網");

  await expect(
    verification.getByRole("button", { name: "確認生日", exact: true }),
  ).toBeDisabled();
  await expect(
    verification.getByRole("button", { name: "確認並繼續", exact: true }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await verification.getByLabel("生日", { exact: true }).fill("19900101");
  await verification
    .getByRole("button", { name: "確認生日", exact: true })
    .click();
  await expect(save).toBeDisabled();
  await expect(primary).toBeDisabled();
  await expect(userId).toBeDisabled();
  await expect(
    verification.getByText("正在確認生日", { exact: true }),
  ).toBeVisible();
  releaseOtpRequest();
  const requestOtp = verification.getByRole("button", {
    name: "寄送驗證碼",
    exact: true,
  });
  const otpChannel = verification.getByRole("radiogroup", {
    name: "驗證碼收取方式",
  });
  const email = otpChannel.getByRole("radio", {
    name: "Email信箱",
    exact: true,
  });
  await expect(otpChannel).toBeVisible();
  await expect(requestOtp).toBeDisabled();
  expect(verificationRequests).toBe(1);
  await email.check();
  await expect(requestOtp).toBeEnabled();
  await requestOtp.click();
  const otpTarget = verification.getByRole("radiogroup", {
    name: "接收驗證碼的手機或信箱",
  });
  await expect(otpTarget).toBeVisible();
  await expect(email).toBeChecked();
  await expect(
    otpTarget.getByRole("radio", { name: "已登記手機" }),
  ).toBeChecked();
  expect(verificationRequests).toBe(2);
  await requestOtp.click();
  await expect(
    verification.getByLabel("一次性驗證碼", { exact: true }),
  ).toBeVisible();
  expect(verificationRequests).toBe(3);
  await expect(
    verification.getByText("寄送方式：Email信箱", { exact: true }),
  ).toBeVisible();
  await verification.getByLabel("一次性驗證碼", { exact: true }).fill("246810");
  await verification
    .getByRole("button", { name: "送出驗證碼", exact: true })
    .click();
  const agreement = verification.getByLabel("我已閱讀並同意憑證作業條款", {
    exact: true,
  });
  const acceptTerms = verification.getByRole("button", {
    name: "同意並繼續",
    exact: true,
  });
  await expect(agreement).toBeVisible();
  await expect(
    verification.getByRole("textbox", { name: "憑證作業條款" }),
  ).toHaveValue(/二、用戶應妥善保管憑證/);
  await expect(acceptTerms).toBeDisabled();
  expect(verificationRequests).toBe(4);
  await agreement.check();
  await expect(acceptTerms).toBeEnabled();
  await acceptTerms.click();
  // The first platform needs nothing else: finishing it and loading the next
  // platform's certificate follow on their own, up to its birthday.
  await expect(
    verification.getByLabel("出生年", { exact: true }),
  ).toBeVisible();
  expect(verificationRequests).toBe(6);
  expect(completions).toBe(1);
  await expect(verification.getByText("豐存股", { exact: true })).toBeVisible();
  await expect(
    verification.getByText("新理財網已完成驗證，接著驗證豐存股。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(currentStep).toContainText("驗證豐存股");
  await expect(
    verification.getByText(
      "台股、美股與豐存股都已完成驗證，可以同步持倉資料。",
      {
        exact: true,
      },
    ),
  ).toHaveCount(0);
  await verification.getByLabel("出生年", { exact: true }).fill("1990");
  await verification.getByLabel("出生月", { exact: true }).fill("01");
  await verification.getByLabel("出生日", { exact: true }).fill("01");
  await verification
    .getByRole("button", { name: "確認生日", exact: true })
    .click();
  await expect(
    verification.getByText(
      "台股、美股與豐存股都已完成驗證，可以同步持倉資料。",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect.poll(() => syncCalls).toBe(1);
  await expect(primary).toBeEnabled();
  await expect(primary).toHaveText("同步");
  await expect(currentStep).toContainText("首次同步");
  await expect(details.locator("iframe, img")).toHaveCount(0);
  expect(completions).toBe(2);
  expect(verificationRequests).toBe(7);
  expect(
    requests
      .filter((request) => request.path.endsWith("/verify"))
      .map((request) => request.body),
  ).toEqual([
    { action: "submit_birthday", values: { birthday: "19900101" } },
    { action: "request_otp", values: { otpChannel: "1" } },
    {
      action: "request_otp",
      values: { otpChannel: "1", otpTarget: "0" },
    },
    { action: "verify_otp", values: { otp: "246810" } },
    { action: "accept_terms", values: { agreement: "true" } },
    { action: "confirm_certificate", values: {} },
    {
      action: "submit_birthday",
      values: { birthdayYear: "1990", birthdayMonth: "01", birthdayDay: "01" },
    },
  ]);
});

test("有效連線直接同步，新憑證草稿只覆寫填入欄位並重新連線", async ({
  page,
}) => {
  const settings = createSettings({
    sessionAvailable: true,
    sinotradePlatforms: { newweb: true, savings: true },
  });
  const requests: string[] = [];
  let syncCalls = 0;
  const savedConfigs = await setupApi(page, settings, (path) => {
    requests.push(path);
    if (path === "/api/connectors/sinotrade/sync") {
      syncCalls++;
      return { json: { success: true, records: 0 } };
    }
    if (path === "/api/connectors/sinotrade/connect") {
      expect(savedConfigs).toEqual([
        { config: { password: "fixture-replacement" } },
      ]);
      settings.sessionAvailable = true;
      settings.sinotradePlatforms = { newweb: true, savings: true };
      return { json: { status: "connected", success: true } };
    }
    throw new Error("Unexpected request: " + path);
  });
  const details = await openSinotrade(page);
  await details.getByRole("button", { name: "同步", exact: true }).click();
  await expect.poll(() => syncCalls).toBe(1);
  expect(savedConfigs).toEqual([]);
  expect(requests).toEqual(["/api/connectors/sinotrade/sync"]);
  const password = details.locator('input[name="tfh-sinotrade-password"]');
  await password.click();
  await password.fill("fixture-replacement");
  await details
    .getByRole("button", { name: "連線並同步", exact: true })
    .click();
  await expect.poll(() => syncCalls).toBe(2);
  await expect(password).toHaveValue("");
  expect(requests).toEqual([
    "/api/connectors/sinotrade/sync",
    "/api/connectors/sinotrade/connect",
    "/api/connectors/sinotrade/sync",
  ]);
});

test("重整只讀取待驗證狀態，不會寄送或提交 OTP", async ({ page }) => {
  const settings = createSettings({ verificationPending: true });
  const requests: string[] = [];
  await setupApi(page, settings, (path, request) => {
    requests.push(path);
    expect(request.postDataJSON()).toEqual({});
    if (path.endsWith("/status"))
      return { json: challengeResponse("newweb", otpChallenge) };
    if (path.endsWith("/cancel")) {
      settings.verificationPending = false;
      return { json: { success: true } };
    }
    throw new Error("Unexpected request: " + path);
  });
  let details = await openSinotrade(page);
  await expect(
    details.getByLabel("一次性驗證碼", { exact: true }),
  ).toBeVisible();
  await details.getByLabel("一次性驗證碼", { exact: true }).fill("135790");
  await page.reload();
  await page
    .getByRole("button", { name: "管理永豐金證券", exact: true })
    .click();
  details = page.getByRole("region", { name: "連接器詳情" });
  const otp = details.getByLabel("一次性驗證碼", { exact: true });
  await expect(otp).toHaveValue("");
  await otp.fill("135790");
  await details
    .getByRole("button", { name: "更新驗證狀態", exact: true })
    .click();
  await expect(otp).toHaveValue("");
  expect(requests).toEqual(
    Array(3).fill("/api/connectors/sinotrade/connect/status"),
  );
  await details.getByRole("button", { name: "取消驗證", exact: true }).click();
  await expect(
    details.getByRole("button", { name: "連線並同步", exact: true }),
  ).toBeEnabled();
});

test("舊 pending 設定缺少帳密仍可更新狀態與取消", async ({ page }) => {
  const settings = createSettings({
    credentialsComplete: false,
    verificationPending: true,
  });
  const requests: string[] = [];
  await setupApi(page, settings, (path) => {
    requests.push(path);
    if (path.endsWith("/status"))
      return { json: challengeResponse("newweb", otpChallenge) };
    if (path.endsWith("/cancel")) {
      settings.verificationPending = false;
      return { json: { success: true } };
    }
    throw new Error("Unexpected request: " + path);
  });
  const details = await openSinotrade(page);
  await expect(
    details.getByRole("button", { name: "送出驗證碼", exact: true }),
  ).toBeDisabled();
  await details
    .getByRole("button", { name: "更新驗證狀態", exact: true })
    .click();
  await details.getByRole("button", { name: "取消驗證", exact: true }).click();
  await expect(
    details.getByText("已取消連線驗證，可重新連線。", { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "連線並同步", exact: true }),
  ).toBeEnabled();
  expect(requests).toEqual([
    "/api/connectors/sinotrade/connect/status",
    "/api/connectors/sinotrade/connect/status",
    "/api/connectors/sinotrade/connect/cancel",
  ]);
});

test("驗證錯誤清空 OTP，更新狀態不會重送上次驗證", async ({ page }) => {
  const settings = createSettings({ verificationPending: true });
  let verifyCalls = 0;
  let blocked = false;
  const requests: string[] = [];
  await setupApi(page, settings, (path, request) => {
    requests.push(path);
    if (path.endsWith("/status"))
      return {
        json: challengeResponse(
          "newweb",
          blocked
            ? {
                step: "blocked",
                fields: [],
                actions: [],
                message: "目前無法完成驗證，請更新狀態或取消後重試。",
              }
            : otpChallenge,
        ),
      };
    if (path.endsWith("/cancel")) {
      expect(request.postDataJSON()).toEqual({});
      settings.verificationPending = false;
      return { json: { success: true } };
    }
    if (path.endsWith("/verify")) {
      verifyCalls++;
      blocked = verifyCalls > 1;
      return {
        status: blocked ? 502 : 400,
        json: {
          error: {
            code: "SINOTRADE_CONNECTION_REQUIRED",
            message: blocked
              ? "連線暫時中斷，請更新驗證狀態。"
              : "驗證碼不正確，請重新輸入。",
          },
        },
      };
    }
    throw new Error("Unexpected request: " + path);
  });
  const details = await openSinotrade(page);
  const otp = details.getByLabel("一次性驗證碼", { exact: true });
  await otp.fill("000000");
  await details
    .getByRole("button", { name: "送出驗證碼", exact: true })
    .click();
  await expect(details.getByRole("alert")).toHaveText(
    "驗證碼不正確，請重新輸入。",
  );
  await expect(otp).toHaveValue("");
  await otp.fill("246810");
  await details
    .getByRole("button", { name: "送出驗證碼", exact: true })
    .click();
  await expect(details.getByRole("alert")).toHaveText(
    "連線暫時中斷，請更新驗證狀態。",
  );
  await expect(otp).toHaveValue("");
  await details
    .getByRole("button", { name: "更新驗證狀態", exact: true })
    .click();
  await expect(
    details.getByText("目前無法完成驗證，請更新狀態或取消後重試。", {
      exact: true,
    }),
  ).toBeVisible();
  const verification = details.getByRole("region", {
    name: "永豐證券連線驗證",
  });
  await expect(
    verification.getByText("連線未完成", { exact: true }),
  ).toBeVisible();
  await expect(verification.getByText(/內完成驗證|等待.*驗證/)).toHaveCount(0);
  await expect(verification.getByRole("textbox")).toHaveCount(0);
  await expect(
    verification.getByText(
      "目前沒有可提交的驗證欄位。可重新檢查連線狀態，或取消這次連線。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    verification.getByRole("button", { name: "取消驗證", exact: true }),
  ).toBeEnabled();
  await verification
    .getByRole("button", { name: "重新檢查連線", exact: true })
    .click();
  await expect(
    verification.getByRole("button", { name: "重新檢查連線", exact: true }),
  ).toBeEnabled();
  expect(requests).toEqual([
    "/api/connectors/sinotrade/connect/status",
    "/api/connectors/sinotrade/connect/verify",
    "/api/connectors/sinotrade/connect/verify",
    "/api/connectors/sinotrade/connect/status",
    "/api/connectors/sinotrade/connect/status",
  ]);
  await expect(otp).toHaveCount(0);
  await expect(
    details.getByRole("button", { name: "確認並繼續", exact: true }),
  ).toHaveCount(0);
  await expect(details.locator("iframe, img")).toHaveCount(0);
  expect(verifyCalls).toBe(2);
  await verification
    .getByRole("button", { name: "取消驗證", exact: true })
    .click();
  await expect(
    details.getByRole("button", { name: "連線並同步", exact: true }),
  ).toBeEnabled();
});

test("驗證逾時後自動關閉官方工作階段，之後可再次連線", async ({ page }) => {
  await page.clock.install();
  const settings = createSettings({ verificationPending: true });
  let cancelCalls = 0;
  const expiresAt = new Date(Date.now() + 30_000).toISOString();
  await setupApi(page, settings, (path) => {
    if (path.endsWith("/status"))
      return { json: challengeResponse("savings", otpChallenge, expiresAt) };
    if (path.endsWith("/cancel")) {
      cancelCalls++;
      settings.verificationPending = false;
      return { json: { success: true } };
    }
    if (path === "/api/connectors/sinotrade/connect") {
      settings.verificationPending = true;
      return {
        json: challengeResponse("newweb", {
          step: "birthday",
          fields: [
            { key: "birthday", label: "生日", action: "submit_birthday" },
          ],
          actions: ["submit_birthday"],
        }),
      };
    }
    throw new Error("Unexpected request: " + path);
  });
  const details = await openSinotrade(page);
  await expect(
    details.getByRole("button", { name: "送出驗證碼", exact: true }),
  ).toBeVisible();
  expect(cancelCalls).toBe(0);
  // 頁面仍開著時，倒數結束就關閉 Browser，不等它閒置逾時。
  await page.clock.fastForward(31_000);
  await expect(
    details.getByText("已清除逾時的驗證，請按「連線並同步」重新開始。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "送出驗證碼", exact: true }),
  ).toHaveCount(0);
  expect(cancelCalls).toBe(1);
  await details
    .getByRole("button", { name: "連線並同步", exact: true })
    .click();
  await expect(details.getByLabel("生日", { exact: true })).toBeVisible();
  expect(cancelCalls).toBe(1);
});

test("重整只讀取已完成的平台，按下確認才完成連線", async ({ page }) => {
  const settings = createSettings({ verificationPending: true });
  const requests: string[] = [];
  await setupApi(page, settings, (path) => {
    requests.push(path);
    if (path.endsWith("/status"))
      return { json: challengeResponse("newweb", readyChallenge) };
    if (path.endsWith("/complete")) {
      settings.verificationPending = false;
      settings.sessionAvailable = true;
      settings.sinotradePlatforms = { newweb: true, savings: true };
      return { json: { status: "connected", success: true } };
    }
    throw new Error("Unexpected request: " + path);
  });
  const details = await openSinotrade(page);
  const confirm = details.getByRole("button", {
    name: "確認並繼續",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  expect(requests).toEqual(["/api/connectors/sinotrade/connect/status"]);
  await confirm.click();
  await expect(
    details.getByText("台股、美股與豐存股都已完成驗證，可以同步持倉資料。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests).toEqual([
    "/api/connectors/sinotrade/connect/status",
    "/api/connectors/sinotrade/connect/complete",
  ]);
});
