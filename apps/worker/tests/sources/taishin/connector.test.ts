import { describe, expect, it, vi } from "vitest";
import type { Page } from "@cloudflare/puppeteer";
import {
  fetchTaishinBankData,
  TaishinVerificationRequiredError,
  TaishinSyncStageError,
} from "../../../src/sources/taishin/connector";
import { TaishinDepositProtocolError } from "../../../src/sources/taishin/deposit-protocol";
import { safeErrorMessage } from "../../../src/features/sync/errors";
import {
  bankNow,
  depositRequest,
  emptyUnbilled,
  realtime,
  FX_ACCOUNT,
  fxOverview,
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
  it("外幣格式錯誤提供安全日誌與畫面摘要，並在取得信用卡前中止同步", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const group = fxOverview.data.FCS_ACCOUNT[0]!;
      const malformed = responsePage((input) =>
        input.path.endsWith("/getRB08000100Data")
          ? {
              error: null,
              data: {
                FCS_ACCOUNT: {
                  [FX_ACCOUNT]: {
                    ...group,
                    ACCOUNT_NAME: "synthetic-sensitive-name",
                    FCS_ACCOUNT_DETAIL: [
                      {
                        ...group.FCS_ACCOUNT_DETAIL[0],
                        CURRENCY_CODE: null,
                        BALANCE: "87654.32",
                        cookie: "synthetic-sensitive-cookie",
                      },
                    ],
                  },
                },
              },
            }
          : undefined,
      );
      const stages: string[] = [];
      const error = await fetchTaishinBankData(
        malformed.page,
        (stage) => stages.push(stage),
        bankNow,
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(TaishinDepositProtocolError);
      expect(stages.at(-1)).toBe("fetch_deposit_accounts");
      expect(
        malformed.evaluate.mock.calls.some(([, input]) =>
          input.path.includes("/web4/"),
        ),
      ).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const log = String(warn.mock.calls[0]![0]);
      expect(JSON.parse(log)).toEqual({
        event: "taishin_deposit_schema_validation_failed",
        connectorId: "taishin",
        endpoint: "getRB08000100Data",
        issues: [
          {
            path: "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].CURRENCY_CODE",
            code: "invalid_type",
            expected: "string",
            received: "null",
          },
        ],
        truncated: false,
      });
      const message = safeErrorMessage(
        new TaishinSyncStageError("fetch_deposit_accounts", error),
      );
      expect(message).toContain("取得存款帳戶");
      expect(message).toContain(
        "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].CURRENCY_CODE",
      );
      expect(message).toContain("預期 string，收到 null");
      for (const secret of [
        FX_ACCOUNT,
        "synthetic-sensitive-name",
        "87654.32",
        "synthetic-sensitive-cookie",
      ])
        expect(log + message).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

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
