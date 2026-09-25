import { describe, expect, it, vi } from "vitest";
import {
  collectEsunSnapshot,
  type EsunPortalApi,
} from "../../src/connectors/esun-portal";

const TW_PREQUERY = "home/preQueryTWTransactionDetail";
const FR_PREQUERY = "home/preQueryFRTransactionDetail";

function fakeApi(options: { isCardholder: unknown; foreignPrequery: unknown }) {
  const postIesc = vi.fn(async (path: string) => {
    if (path === "common/isCardholder") return options.isCardholder;
    throw new Error(`unexpected IESC request: ${path}`);
  });
  const postPortal = vi.fn(async (path: string) => {
    if (path.endsWith("home/init")) return { resultCode: "0000" };
    if (path.endsWith(TW_PREQUERY)) {
      return {
        resultCode: "0000",
        resultBody: {
          demandDeptAcc: "0001234567890",
          twCurrInfo: { realBalance: "1,000" },
          queryDeptTxDtlResult: { detailListData: [] },
        },
      };
    }
    if (path.endsWith(FR_PREQUERY)) return options.foreignPrequery;
    return { resultCode: "0000", resultBody: {} };
  });
  const readRealtime = vi.fn(async () => {
    throw new Error("realtime must not be read without a credit card");
  });
  const api: EsunPortalApi = { postIesc, postPortal, readRealtime };
  return { api, postIesc, postPortal, readRealtime };
}

const noForeignAccount = {
  resultCode: "S001",
  resultDescription: "親愛的顧客您好，查無外幣帳號，或您尚未開立外幣帳戶。",
  resultBody: null,
};

describe("E.SUN customers without every product", () => {
  it("syncs deposits without card requests when the customer holds no credit card", async () => {
    const { api, readRealtime, postIesc } = fakeApi({
      isCardholder: { body: { rtnCode: "S", debit: true, credit: false } },
      foreignPrequery: noForeignAccount,
    });

    const snapshot = await collectEsunSnapshot(api);

    expect(snapshot.hasCreditCard).toBe(false);
    expect(readRealtime).not.toHaveBeenCalled();
    expect(postIesc).toHaveBeenCalledExactlyOnceWith("common/isCardholder", {});
    expect(snapshot.creditHistory).toEqual([]);
    expect(snapshot.twDeposits).toMatchObject([
      { accountNo: "0001234567890", currency: "TWD", balance: 1000 },
    ]);
    expect(snapshot.frDeposits).toEqual([]);
  });

  it.each([
    ["an unknown answer", { body: { rtnCode: "E" } }],
    ["a cardholder", { body: { rtnCode: "S", credit: true } }],
  ])("keeps the credit card flow for %s", async (_label, isCardholder) => {
    const { api, readRealtime } = fakeApi({
      isCardholder,
      foreignPrequery: noForeignAccount,
    });

    await expect(collectEsunSnapshot(api)).rejects.toThrow(
      "realtime must not be read without a credit card",
    );
    expect(readRealtime).toHaveBeenCalledOnce();
  });

  it("keeps the credit card flow when the cardholder check fails", async () => {
    const { api, postIesc, readRealtime } = fakeApi({
      isCardholder: null,
      foreignPrequery: noForeignAccount,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    postIesc.mockRejectedValueOnce(new SyntaxError("Unexpected token <"));

    await expect(collectEsunSnapshot(api)).rejects.toThrow(
      "realtime must not be read without a credit card",
    );
    expect(readRealtime).toHaveBeenCalledOnce();
  });

  it.each([
    ["another foreign deposit error", { resultCode: "E999", resultBody: null }],
    [
      "an S001 notice about something else",
      { resultCode: "S001", resultDescription: "系統維護中", resultBody: null },
    ],
  ])("still fails %s", async (_label, foreignPrequery) => {
    const { api } = fakeApi({
      isCardholder: { body: { rtnCode: "S", credit: false } },
      foreignPrequery,
    });

    await expect(collectEsunSnapshot(api)).rejects.toThrow(
      /E\.SUN portal deposit-prequery failed \((E999|S001)\)\./,
    );
  });

  it("still fails when the TWD deposit query returns S001", async () => {
    const { api, postPortal } = fakeApi({
      isCardholder: { body: { rtnCode: "S", credit: false } },
      foreignPrequery: noForeignAccount,
    });
    postPortal.mockImplementation(async (path: string) =>
      path.endsWith(TW_PREQUERY)
        ? noForeignAccount
        : { resultCode: "0000", resultBody: {} },
    );

    await expect(collectEsunSnapshot(api)).rejects.toThrow(
      "E.SUN portal deposit-prequery failed (S001).",
    );
  });
});
