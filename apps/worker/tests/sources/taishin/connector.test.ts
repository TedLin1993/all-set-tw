import { describe, expect, it, vi } from "vitest";
import type { Page } from "@cloudflare/puppeteer";
import {
  fetchTaishinBankData,
  TaishinVerificationRequiredError,
} from "../../../src/sources/taishin/connector";
import {
  bankNow,
  depositRequest,
  emptyUnbilled,
  realtime,
} from "./fixtures/bank-data";

type Request = { path: string; body: Record<string, unknown> | string };
function responsePage(override: (request: Request) => unknown) {
  const evaluate = vi.fn(async (_callback: unknown, input: Request) => {
    let payload = override(input);
    if (payload === undefined) {
      if (input.path.endsWith("/queryRealTime")) payload = realtime;
      else if (input.path.endsWith("/qryUnposted")) payload = emptyUnbilled;
      else if (input.path.includes("/web4/"))
        payload = { error: null, value: {} };
      else payload = await depositRequest(input.path, input.body);
    }
    return {
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify(payload),
      timedOut: false,
    };
  });
  return { page: { evaluate } as unknown as Page, evaluate };
}

describe("台新必要金融查詢", () => {
  it("使用完整即時消費端點，無卡回應只略過信用卡並保留存款", async () => {
    const successful = responsePage(() => undefined);
    const data = await fetchTaishinBankData(successful.page, () => {}, bankNow);
    expect(data.bankTransactions).toHaveLength(6);
    expect(
      data.bankTransactions.find((row) => row.status === "pending")?.amount,
    ).toBe(-252);
    expect(
      successful.evaluate.mock.calls.some(([, input]) =>
        input.path.endsWith("/qryRealTime"),
      ),
    ).toBe(false);
    const noCard = responsePage((input) =>
      input.path.endsWith("/doXTPA")
        ? { error: "您尚未持有本行信用卡" }
        : undefined,
    );
    const deposits = await fetchTaishinBankData(noCard.page, () => {}, bankNow);
    expect(deposits.bankAccounts.map((row) => row.currency)).toEqual([
      "TWD",
      "USD",
      "JPY",
    ]);
    expect(deposits.bankTransactions).toHaveLength(5);
  });

  it("即時消費忙碌重試耗盡時整次失敗，不能以空清單成功", async () => {
    const busy = responsePage((input) =>
      input.path.endsWith("/queryRealTime")
        ? { error: "系統忙碌，無法取得資料" }
        : undefined,
    );
    await expect(
      fetchTaishinBankData(busy.page, () => {}, bankNow),
    ).rejects.toThrow("系統忙碌");
    expect(
      busy.evaluate.mock.calls.filter(([, input]) =>
        input.path.endsWith("/queryRealTime"),
      ),
    ).toHaveLength(3);
  });

  it("必要未出帳缺少清單不能被可選帳單降級吞掉，途中 session 失效須重新登入", async () => {
    const malformed = responsePage((input) =>
      input.path.endsWith("/qryUnposted")
        ? { error: null, value: {} }
        : undefined,
    );
    await expect(
      fetchTaishinBankData(malformed.page, () => {}, bankNow),
    ).rejects.toThrow("未出帳消費回應缺少完整清單");
    const expired = responsePage((input) =>
      input.path.endsWith("/getRB08020100ForeignTranDetail")
        ? { RESULT: "RESUME", TARGET: "login" }
        : undefined,
    );
    await expect(
      fetchTaishinBankData(expired.page, () => {}, bankNow),
    ).rejects.toBeInstanceOf(TaishinVerificationRequiredError);
  });
});
