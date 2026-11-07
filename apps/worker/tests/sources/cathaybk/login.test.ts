import { TimeoutError } from "@cloudflare/puppeteer";
import { describe, expect, it, vi } from "vitest";
import { dismissCathaySystemMessageIfPresent } from "../../../src/sources/cathaybk/connector";

type DismissPage = Parameters<typeof dismissCathaySystemMessageIfPresent>[0];

function noticePage(
  labels: string[],
  visibility: "shown" | "absent" | "fading" = "shown",
) {
  const buttons = labels.map((label) => ({
    click: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(label),
  }));
  let current = 0;
  const page = {
    // 公告動畫結束前不能點擊：動畫未結束時 waitForFunction 會逾時。
    waitForFunction: vi.fn(async () => {
      if (visibility === "fading") throw new TimeoutError("公告動畫尚未結束");
      return { jsonValue: async () => visibility };
    }),
    $: vi.fn(async () => buttons[current++] ?? null),
    waitForSelector: vi.fn(async () => {
      if (current !== buttons.length) throw new Error("公告尚未讀完");
    }),
    evaluate: vi.fn().mockResolvedValue(undefined),
  };
  return { page, buttons };
}

describe("國泰登入公告", () => {
  it.each([[], ["我知道了"], ["下一則", "下一則", "我知道了"]])(
    "讀完公告後才繼續登入：%j",
    async (...labels: string[]) => {
      const { page, buttons } = noticePage(
        labels,
        labels.length ? "shown" : "absent",
      );
      await expect(
        dismissCathaySystemMessageIfPresent(page as unknown as DismissPage),
      ).resolves.toBe(buttons.length > 0);
      for (const button of buttons) expect(button.click).toHaveBeenCalledOnce();
      expect(page.waitForSelector).toHaveBeenCalledTimes(
        buttons.length ? 1 : 0,
      );
      // 關掉後記下旗標，同一頁的下一次檢查不再等公告出現。
      expect(page.evaluate).toHaveBeenCalledTimes(buttons.length ? 1 : 0);
    },
  );

  it("公告動畫結束前不點擊", async () => {
    const { page, buttons } = noticePage(["下一則", "我知道了"], "fading");
    await expect(
      dismissCathaySystemMessageIfPresent(page as unknown as DismissPage),
    ).resolves.toBe(false);
    expect(page.$).not.toHaveBeenCalled();
    for (const button of buttons) expect(button.click).not.toHaveBeenCalled();
  });

  it("不點擊未知公告動作，也不讓公告無限循環", async () => {
    for (const label of ["立即啟用", "下一則"]) {
      const button = {
        click: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(label),
      };
      const page = {
        waitForFunction: vi
          .fn()
          .mockResolvedValue({ jsonValue: async () => "shown" }),
        $: vi.fn().mockResolvedValue(button),
        waitForSelector: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(undefined),
      };
      await expect(
        dismissCathaySystemMessageIfPresent(page as unknown as DismissPage),
      ).rejects.toThrow(
        label === "立即啟用"
          ? "Cathay system message action changed."
          : "Cathay system message list exceeded 20 notices.",
      );
      expect(button.click).toHaveBeenCalledTimes(label === "立即啟用" ? 0 : 20);
      expect(page.waitForSelector).not.toHaveBeenCalled();
      expect(page.evaluate).not.toHaveBeenCalled();
    }
  });
});
