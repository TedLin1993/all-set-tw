import { afterEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  completeCathayTrustedDeviceSetup,
  dismissCathayPasswordNoticeIfPresent,
  submitCathayOtp,
} from "../../../src/sources/cathaybk/connector";

const credentials = {
  userId: "A123456789",
  account: "test-user",
  password: "test-password",
};

afterEach(() => vi.unstubAllGlobals());

describe("Cathay additional verification", () => {
  it("accepts the Quicklinks home page after OTP as verified", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "https://www.cathaybk.com.tw/MyBank/Quicklinks/Home",
        pathname: "/MyBank/Quicklinks/Home",
      },
    });
    vi.stubGlobal("document", {
      body: { innerText: "您的網銀密碼已超過半年未更新。 立即變更 暫不變更" },
      querySelector: () => null,
    });
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue([]),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ hasInput: true, hasSubmit: true })
        .mockImplementationOnce(async (callback: () => boolean) => callback())
        .mockResolvedValueOnce(false)
        .mockResolvedValue({
          hasNext: false,
          hasNameInput: false,
          hasConfirm: false,
          success: true,
        }),
      type: vi.fn().mockResolvedValue(undefined),
      url: vi
        .fn()
        .mockReturnValue("https://www.cathaybk.com.tw/MyBank/Quicklinks/Home"),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
    };

    try {
      await expect(submitCathayOtp(page, "123456")).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Cathay trusted device state", () => {
  it("skips the password change notice before looking for trusted-device setup", async () => {
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(true),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
    };

    await expect(dismissCathayPasswordNoticeIfPresent(page)).resolves.toBe(
      true,
    );
    expect(page.click).toHaveBeenCalledWith(
      '[data-cathay-password-notice-skip="true"]',
    );
  });

  it("leaves the page alone when no password change notice is shown", async () => {
    const page = {
      click: vi.fn(),
      evaluate: vi.fn().mockResolvedValue(false),
      waitForFunction: vi.fn(),
    };

    await expect(dismissCathayPasswordNoticeIfPresent(page)).resolves.toBe(
      false,
    );
    expect(page.click).not.toHaveBeenCalled();
  });

  it("detects an HttpOnly device cookie that document.cookie cannot see", async () => {
    const page = {
      click: vi.fn(),
      cookies: vi.fn().mockResolvedValue([
        {
          name: "CUB.eBank.DeviceId",
          value: "device-1",
          domain: ".cathaybk.com.tw",
          httpOnly: true,
        },
      ]),
      evaluate: vi.fn().mockResolvedValueOnce(false).mockResolvedValue({
        hasNext: false,
        hasNameInput: false,
        hasConfirm: false,
        success: false,
      }),
      type: vi.fn(),
      waitForFunction: vi.fn().mockRejectedValue(new Error("timeout")),
    };

    await expect(completeCathayTrustedDeviceSetup(page)).resolves.toBe(true);
    expect(page.click).not.toHaveBeenCalled();
  });
});
