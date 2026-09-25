import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  sessions: vi.fn(),
}));
vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  BrowserCapacityError,
  classifyBrowserCapacityError,
  launchBrowserOrCapacityError,
} from "../../src/connectors/browser";
import { createCathaybkConnector } from "../../src/connectors/cathaybk";
import { createEsunConnector } from "../../src/connectors/esun";

const dailyQuota = new Error(
  "Unable to create new browser: code: 429: message: Browser time limit exceeded for today",
);
const rateLimited = new Error(
  "Unable to create new browser: code: 429: message: Rate limit exceeded",
);

describe("classifyBrowserCapacityError", () => {
  it.each([
    [dailyQuota, "今日使用額度已用完", 60],
    [rateLimited, "暫時達到使用上限", 20],
    [new Error("code: 429"), "暫時達到使用上限", 20],
    ["Rate limit exceeded", "暫時達到使用上限", 20],
  ])("classifies %s", (error, message, retryAfterSeconds) => {
    const classified = classifyBrowserCapacityError(error);
    expect(classified).toBeInstanceOf(BrowserCapacityError);
    expect(classified?.message).toContain(message);
    expect(classified?.retryAfterSeconds).toBe(retryAfterSeconds);
  });

  it.each([
    new Error("Navigation timeout of 30000 ms exceeded"),
    new Error("E.SUN request failed with HTTP 429"),
    undefined,
  ])("leaves unrelated errors alone: %s", (error) => {
    expect(classifyBrowserCapacityError(error)).toBeUndefined();
  });
});

describe("launchBrowserOrCapacityError", () => {
  beforeEach(() => {
    puppeteerMock.launch.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("converts Browser Run capacity failures", async () => {
    puppeteerMock.launch.mockRejectedValueOnce(dailyQuota);
    await expect(
      launchBrowserOrCapacityError({} as Fetcher),
    ).rejects.toBeInstanceOf(BrowserCapacityError);
  });

  it("rethrows other launch failures unchanged", async () => {
    const failure = new Error("socket hang up");
    puppeteerMock.launch.mockRejectedValueOnce(failure);
    await expect(launchBrowserOrCapacityError({} as Fetcher)).rejects.toBe(
      failure,
    );
  });

  it("reports E.SUN launch capacity failures", async () => {
    puppeteerMock.launch.mockRejectedValueOnce(rateLimited);
    await expect(
      createEsunConnector({} as Fetcher).sync({
        userId: "A123456789",
        account: "test-user",
        password: "test-password",
      }),
    ).rejects.toMatchObject({
      name: "BrowserCapacityError",
      message: "Cloudflare 瀏覽器暫時達到使用上限，請稍後再試。",
    });
  });

  it("reports Cathay launch capacity failures", async () => {
    puppeteerMock.launch.mockRejectedValueOnce(dailyQuota);
    await expect(
      createCathaybkConnector({} as Fetcher).sync({
        userId: "A123456789",
        account: "test-user",
        password: "test-password",
      }),
    ).rejects.toMatchObject({
      name: "BrowserCapacityError",
      retryAfterSeconds: 60,
    });
  });
});
