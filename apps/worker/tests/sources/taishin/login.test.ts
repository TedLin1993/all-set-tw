import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puppeteer = vi.hoisted(() => ({ launch: vi.fn(), limits: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteer }));
import { prepareTaishinCaptcha } from "../../../src/sources/taishin/connector";

const credentials = {
  userId: "A123456789",
  account: "synthetic-user",
  password: "synthetic-password",
};

function input(placeholder: string, type: string, maxLength = 16) {
  return {
    id: "",
    name: "",
    placeholder,
    type,
    maxLength,
    disabled: false,
    inputMode: type === "text" ? "numeric" : "",
    pattern: "",
    parentElement: { innerText: "" },
    closest: () => null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      width: 120,
      height: 30,
      top: 100,
      right: 200,
    }),
    focus: vi.fn(),
    value: "",
    dataset: {} as Record<string, string>,
    dispatchEvent: vi.fn(),
  };
}

function image(hint: string, src = "/image.png") {
  return {
    id: hint,
    className: "",
    alt: "",
    src,
    getAttribute: () => src,
    complete: true,
    naturalWidth: 120,
    getBoundingClientRect: () => ({
      width: 120,
      height: 30,
      top: 100,
      left: 200,
    }),
    dataset: {} as Record<string, string>,
    screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  };
}

function loginPage(
  inputs: ReturnType<typeof input>[],
  images: ReturnType<typeof image>[],
) {
  vi.stubGlobal("document", {
    body: { innerText: "" },
    querySelectorAll: (selector: string) =>
      selector === "input" ? inputs : images,
    querySelector: () => inputs[3],
  });
  vi.stubGlobal("window", { HTMLInputElement: { prototype: {} } });
  vi.stubGlobal("InputEvent", class extends Event {});
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (callback, arg) => callback(arg)),
    waitForFunction: vi.fn(async (callback, _options, arg) => {
      if (!callback(arg)) throw new Error("驗證碼尚未就緒");
    }),
    $: vi.fn(
      async (selector: string) =>
        images.find((item) =>
          selector === 'img[data-taishin-captcha="image"]'
            ? item.dataset.taishinCaptcha === "image"
            : selector ===
              `img[data-taishin-captcha-candidate="${item.dataset.taishinCaptchaCandidate}"]`,
        ) ?? null,
    ),
  };
  const browser = {
    pages: vi.fn().mockResolvedValue([page]),
    sessionId: () => "synthetic-session",
    disconnect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  puppeteer.launch.mockResolvedValue(browser);
  return { page, browser };
}

beforeEach(() => {
  vi.clearAllMocks();
  puppeteer.limits.mockResolvedValue({ allowedBrowserAcquisitions: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe("台新登入欄位與驗證碼", () => {
  it.each([
    ["ID number", "User ID", "Password", "Verification Code"],
    ["身分證字號", "使用者代號", "使用者密碼", "驗證碼"],
    ["custid", "username", "Password", "Verification Code"],
  ])(
    "遮罩的登入欄位仍依中英文標籤正確填寫：%s",
    async (...labels: string[]) => {
      const inputs = labels.map((label, index) =>
        input(label, index === 3 ? "text" : "password", index === 3 ? 6 : 16),
      );
      const logo = image("bank-logo");
      const captcha = image("captcha-image");
      const { browser } = loginPage(inputs, [logo, captcha]);
      const result = await prepareTaishinCaptcha({} as Fetcher, credentials);
      expect(inputs.map((item) => item.dataset.taishinField)).toEqual([
        "user-id",
        "account",
        "password",
        "captcha",
      ]);
      expect(inputs.slice(0, 3).map((item) => item.value)).toEqual([
        credentials.userId,
        credentials.account,
        credentials.password,
      ]);
      expect(logo.screenshot).not.toHaveBeenCalled();
      expect(captcha.screenshot).toHaveBeenCalledOnce();
      expect(result.captchaImage).toBe("data:image/jpeg;base64,AQID");
      expect(browser.disconnect).toHaveBeenCalledOnce();
    },
  );

  it("只有銀行標誌時，不因網址參數或 data URL 內容誤認為驗證碼", async () => {
    const inputs = [
      input("身分證", "text"),
      input("使用者代號", "text"),
      input("使用者密碼", "password"),
      input("驗證碼", "text", 6),
    ];
    const images = [
      image("bank-logo", "/logo.png?captcha=1"),
      image("", "data:image/png;base64,captcha"),
    ];
    const { browser } = loginPage(inputs, images);
    await expect(
      prepareTaishinCaptcha({} as Fetcher, credentials),
    ).rejects.toThrow("台新登入頁沒有在期限內取得圖形驗證碼");
    for (const item of images) expect(item.screenshot).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.disconnect).not.toHaveBeenCalled();
  });
});
