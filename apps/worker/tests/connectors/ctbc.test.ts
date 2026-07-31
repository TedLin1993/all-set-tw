import {
  createCtbcConnector,
  CtbcVerificationRequiredError,
  encryptCtbcPin,
  requireCtbcCredentials,
  type CtbcFetch,
} from "@taiwan-fin-hub/connectors";
import { describe, expect, it, vi } from "vitest";
import { createCtbcFetch } from "../../src/connectors/ctbc";

const RESOURCE_URL =
  "https://eb.ctbcbank.com/IMP/api/adapters/EBMW_Adapter/resource/ebmwResource";

describe("CTBC mobile API connector", () => {
  it("requires every credential without retaining submitted values in errors", () => {
    expect(() =>
      requireCtbcCredentials({
        userId: "",
        account: "sensitive-account",
        password: "sensitive-password",
      }),
    ).toThrow(CtbcVerificationRequiredError);

    try {
      requireCtbcCredentials({
        userId: "",
        account: "sensitive-account",
        password: "sensitive-password",
      });
    } catch (error) {
      expect(String(error)).not.toContain("sensitive-account");
      expect(String(error)).not.toContain("sensitive-password");
    }
  });

  it("generates the App 5.2.25 AES and RSA login format", () => {
    const encrypted = encryptCtbcPin("test-password", (length) =>
      new Uint8Array(length).fill(7),
    );
    const [aes, rsa] = encrypted.split("|");

    expect(aes).toMatch(/^[0-9a-f]+$/);
    expect(aes?.length).toBeGreaterThan(32);
    expect(rsa).toMatch(/^[0-9a-f]{512}$/);
    expect(encrypted).not.toContain("test-password");
  });

  it("runs OAuth, handshake, login, read-only queries and logout without plaintext credentials", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
    const responses = [
      jsonResponse({ access_token: "oauth-token" }),
      jsonResponse({ statusCode: "0000" }),
      jsonResponse(
        { success: true, rsData: { seed: "session-seed" }, token: "token-1" },
        { "x-auth-token": "auth-1" },
      ),
      jsonResponse({
        code: "0000",
        rsData: { dupLoginCheckTimestamp: "duplicate-login-timestamp" },
        token: "token-2",
      }),
      jsonResponse({ code: "0000", rsData: {}, token: "token-3" }),
      jsonResponse({
        code: "0000",
        rsData: {
          twdAcctSummaryResponse: {
            demDepBalSummaryResponse: {
              infoList: [
                {
                  accountId: "123456789012",
                  balance: "5000",
                  availableBalance: "4500",
                  accountNickName: "薪轉帳戶",
                },
              ],
            },
          },
        },
        token: "token-3",
      }),
      jsonResponse({
        code: "0000",
        rsData: {
          accountId: "query-account-id",
          accountSelections: [{ accountId: "query-account-id" }],
        },
        token: "token-4",
      }),
      jsonResponse({
        code: "0000",
        rsData: {
          detailList: [
            {
              trnDtFull: "20260730",
              dbAmt: "80",
              crAmt: "0",
              memo1: "測試扣款",
              defaultSeq: "1",
            },
          ],
        },
        token: "token-5",
      }),
      jsonResponse({ sys: "ESB", code: "9201", rsData: {}, token: "token-6" }),
      jsonResponse({
        code: "0000",
        rsData: { detailList: [] },
        token: "token-6",
      }),
      jsonResponse({
        code: "0000",
        rsData: {
          curDataList: [{ curCode: "TWD", curName: "新臺幣" }],
          cardDataList: [
            {
              cardNoSuffixFour: "5566",
              cardName: "中信信用卡",
              positiveOrAttached: "正卡",
            },
          ],
          billData: {
            TWD: {
              202607: {
                summary: {
                  billDt: "20260720",
                  pmtExpDt: "20260805",
                  billAmt: "1200",
                  currPmtAmt: "1200",
                  minPmtAmt: "100",
                },
                bills: [
                  {
                    purchaseDt: "20260710",
                    postingDt: "20260711",
                    merchantChiName: "帳單商店",
                    ntAmt: "120",
                    cardNo: "************5566",
                  },
                ],
              },
            },
          },
        },
        token: "token-6",
      }),
      jsonResponse({ code: "0000", rsData: {}, token: "token-7" }),
      jsonResponse({
        code: "0000",
        rsData: { curOptions: [{ curCode: "TWD", curName: "新臺幣" }] },
        token: "token-8",
      }),
      jsonResponse({
        code: "0000",
        rsData: {
          allItems: [
            {
              purchaseDt: "20260728",
              postingDt: "20260729",
              merchantChiName: "未出帳商店",
              ntAmt: "200",
              cardNoSuffixFour: "5566",
              authCode: "unbilled-auth",
            },
          ],
          displayPaging: false,
        },
        token: "token-9",
      }),
      jsonResponse({
        code: "0000",
        rsData: {
          allItems: [
            {
              txnDate: "20260730",
              txnAmt: "300",
              merchName: "即時商店",
              cardNoSuffixFour: "5566",
              authCode: "pending-auth",
            },
          ],
          displayPaging: false,
        },
        token: "token-10",
      }),
      jsonResponse({ code: "0000", rsData: {} }),
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init = {}) => {
      const bodyText = typeof init.body === "string" ? init.body : "";
      calls.push({
        url: String(input),
        init,
        body: bodyText ? JSON.parse(bodyText) : undefined,
      });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as CtbcFetch;

    const result = await createCtbcConnector(fetcher).sync({
      userId: "A123456789",
      account: "bank-user",
      password: "bank-password",
    });

    expect(responses).toHaveLength(0);
    expect(calls.map((call) => resourceOf(call.body))).toEqual([
      undefined,
      undefined,
      undefined,
      "/twrbm-general/ot001/010",
      "/twrbm-general/ot001/010",
      "/twrbm-deposit/qu001/010",
      "/twrbm-deposit/qu002/010",
      "/twrbm-deposit/qu002/011",
      "/twrbm-deposit/qu002/011",
      "/twrbm-deposit/qu002/011",
      "/twrbm-card/qu002/010",
      "/twrbm-card/qu046/010",
      "/twrbm-card/qu006/010",
      "/twrbm-card/qu006/011",
      "/twrbm-card/qu041/010",
      "/twrbm-general/ot002/010",
    ]);
    expect(calls[2]?.url).toBe(RESOURCE_URL);
    expect(headerValue(calls[2]?.init.headers, "X-Request-Type")).toBe(
      "handshakewb",
    );
    expect(headerValue(calls[3]?.init.headers, "X-Requested-With")).toBeNull();
    expect(headerValue(calls[3]?.init.headers, "checksum")).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(calls)).not.toContain("bank-password");
    expect(JSON.stringify(calls)).not.toContain("bank-user");
    expect(
      (calls[7]?.body as { rqData?: { accountId?: string } }).rqData?.accountId,
    ).toBe("query-account-id");
    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankTransactions).toHaveLength(4);
    expect(result.creditCardBills).toHaveLength(1);
    expect(result.bankTransactions?.map((item) => item.status)).toEqual(
      expect.arrayContaining(["posted", "pending"]),
    );
    expect(result.cursor).toContain("syncedAt");
  });

  it("turns login challenge responses into a user-action error", async () => {
    const responses = [
      jsonResponse({ access_token: "oauth-token" }),
      jsonResponse({ statusCode: "0000" }),
      jsonResponse({ success: true, rsData: { seed: "seed" }, token: "token" }),
      jsonResponse({ code: "9015", desc: "sensitive-upstream-text" }),
    ];
    const fetcher = vi.fn(async () => responses.shift()!) as CtbcFetch;

    await expect(
      createCtbcConnector(fetcher).sync({
        userId: "A123456789",
        account: "bank-user",
        password: "bank-password",
      }),
    ).rejects.toMatchObject({
      name: "CtbcVerificationRequiredError",
      message: expect.not.stringContaining("sensitive-upstream-text"),
    });
  });
});

describe("CTBC local development relay", () => {
  it("is disabled outside local development", () => {
    expect(
      createCtbcFetch({
        LOCAL_DEV_MODE: false,
        CTBC_API_RELAY_URL: "http://127.0.0.1:9000/ctbc",
        CTBC_API_RELAY_TOKEN: "relay-token",
      }),
    ).toBeUndefined();
  });

  it("forwards only the target request envelope through the tokenized relay", async () => {
    const relayMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ code: "0000", rsData: {} }, { "x-auth-token": "next" }),
    );
    const fetcher = createCtbcFetch(
      {
        LOCAL_DEV_MODE: "true",
        CTBC_API_RELAY_URL: "http://127.0.0.1:9000/ctbc",
        CTBC_API_RELAY_TOKEN: "relay-token",
      },
      relayMock as typeof globalThis.fetch,
    );

    const response = await fetcher!("https://eb.ctbcbank.com/IMP/main/init", {
      method: "POST",
      headers: { Authorization: "Bearer oauth", checksum: "abc" },
      body: '{"request":true}',
    });

    expect(response.status).toBe(200);
    expect(relayMock).toHaveBeenCalledOnce();
    const [relayUrl, relayInit] = relayMock.mock.calls[0]!;
    expect(relayUrl).toBe("http://127.0.0.1:9000/ctbc");
    expect(new Headers(relayInit?.headers).get("x-ctbc-relay-token")).toBe(
      "relay-token",
    );
    expect(JSON.parse(String(relayInit?.body))).toEqual({
      url: "https://eb.ctbcbank.com/IMP/main/init",
      method: "POST",
      headers: { authorization: "Bearer oauth", checksum: "abc" },
      body: '{"request":true}',
    });
  });
});

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function resourceOf(body: unknown) {
  return body && typeof body === "object" && "resource" in body
    ? (body as { resource: unknown }).resource
    : undefined;
}

function headerValue(headers: HeadersInit | undefined, name: string) {
  return new Headers(headers).get(name);
}
