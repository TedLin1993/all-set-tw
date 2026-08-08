import {
  createObankConnector,
  ObankMultipleLoginError,
  ObankVerificationRequiredError,
  parseObankData,
  prepareObankCaptcha,
} from "@taiwan-fin-hub/connectors";
import forge from "node-forge";
import { describe, expect, it, vi } from "vitest";

describe("O-Bank App API connector", () => {
  it("parses demand deposits, time deposits and transactions without retaining full account numbers", () => {
    const result = parseObankData(
      {
        demandDeposits: demandDepositResponse(),
        timeDeposits: timeDepositResponse(),
        transactionResponses: [transactionResponse()],
      },
      new Date("2026-08-08T12:00:00.000Z"),
    );

    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankAccounts.map((account) => account.accountType)).toEqual([
      "savings",
      "time_deposit",
    ]);
    expect(
      result.bankBalanceSnapshots.map((snapshot) => snapshot.balance),
    ).toEqual([12_345, 50_000]);
    expect(result.bankTransactions).toMatchObject([
      {
        postedDate: "2026-08-07",
        amount: -80,
        currency: "TWD",
        description: "測試扣款",
      },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("12345678901234");
    expect(serialized).not.toContain("98765432109876");
    expect(result.bankAccounts[0]?.sourceId).toMatch(
      /^bank:obank:savings:1234:[0-9a-f]{16}:TWD$/,
    );
  });

  it("requires complete credentials without including submitted secrets in errors", () => {
    return expect(
      prepareObankCaptcha({
        userId: "",
        account: "sensitive-account",
        password: "sensitive-password",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: ObankVerificationRequiredError.name,
        message: expect.not.stringContaining("sensitive-password"),
      }),
    );
  });

  it("runs the public bootstrap, RSA login, read-only queries and logout", async () => {
    const keyPair = forge.pki.rsa.generateKeyPair({ bits: 512, e: 0x10001 });
    const publicPem = forge.pki.publicKeyToPem(keyPair.publicKey);
    const calls: Array<{ url: string; body: string; headers: Headers }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init = {}) => {
      const url = String(input);
      const body = typeof init.body === "string" ? init.body : "";
      const headers = new Headers(init.headers);
      calls.push({ url, body, headers });

      if (url.endsWith("/ChannelAdapter/getChannel")) {
        return jsonResponse({ channel: "IB" });
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({ access_token: "public-test-token" });
      }
      if (url.endsWith("/invalidateSession")) {
        return jsonResponse({ statusCode: "0000" });
      }

      const procedure = url.split("/").at(-1);
      const payload = body ? (JSON.parse(body) as unknown[]) : [];
      if (procedure === "emptyLogin") {
        return jsonResponse({ authStatus: "required", auth: "true" });
      }
      if (procedure === "submitCredentials") {
        const metadata = payload[0] as { rqData?: { force?: string } };
        return metadata.rqData?.force === "1"
          ? jsonResponse({
              authStatus: "complete",
              token: "secure-token",
            })
          : jsonResponse({
              authStatus: "required",
              rsData: { resultType: "3" },
              token: "duplicate-login-token",
            });
      }

      const resource = String(payload[0] ?? "");
      if (resource === "common/CMN01003/010") {
        return jsonResponse({
          isSuccessful: true,
          rsData: { params: { e2e: publicPem } },
        });
      }
      if (resource === "common/CMN01001/010") {
        return jsonResponse({
          isSuccessful: true,
          rsData: { img: "data:image/png;base64,AQID" },
        });
      }
      if (
        resource === "fco/FCO02001/012" ||
        resource === "common/CMN01004/010"
      ) {
        return jsonResponse({ isSuccessful: true, rsData: {} });
      }
      if (resource === "common/EndToEnd/020") {
        return jsonResponse({
          isSuccessful: true,
          rsData: { timeFactor: "1700000000000" },
        });
      }
      if (resource === "fao/FAO01012/010") {
        const metadata = payload[1] as { rqData?: { queryType?: string } };
        return jsonResponse(
          metadata.rqData?.queryType === "customDisplay"
            ? transactionResponse()
            : demandDepositResponse(),
        );
      }
      if (resource === "fao/FAO01022/020") {
        return jsonResponse(timeDepositResponse());
      }
      throw new Error(`Unexpected O-Bank test request: ${url} ${body}`);
    });

    const connector = createObankConnector(fetcher, async () => "A1b2");
    const result = await connector.sync(
      {
        userId: "A123456789",
        account: "test-account",
        password: "test-password",
      },
      undefined,
      { forceLogin: true },
    );

    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankTransactions).toHaveLength(1);
    expect(calls.some((call) => call.url.endsWith("/invalidateSession"))).toBe(
      true,
    );
    const adapterCalls = calls.filter((call) =>
      call.url.includes("AuthenticationAdapter"),
    );
    expect(
      adapterCalls.every((call) =>
        /^[0-9a-f]{32}$/.test(call.headers.get("checksum") ?? ""),
      ),
    ).toBe(true);
    expect(
      adapterCalls.every((call) =>
        call.headers.get("authorization")?.startsWith("Bearer "),
      ),
    ).toBe(true);
    expect(calls.map((call) => call.body).join("\n")).not.toContain(
      "test-password",
    );
    expect(calls.map((call) => call.body).join("\n")).not.toContain(
      "test-account",
    );
    await expect(
      connector.sync({
        userId: "A123456789",
        account: "test-account",
        password: "test-password",
      }),
    ).rejects.toBeInstanceOf(ObankMultipleLoginError);
    const loginForces = calls
      .filter((call) => call.url.endsWith("/submitCredentials"))
      .map((call) => {
        const payload = JSON.parse(call.body) as [
          { rqData?: { force?: string } },
        ];
        return payload[0]?.rqData?.force;
      });
    expect(loginForces).toEqual(["0", "1", "0"]);
  });
});

function demandDepositResponse() {
  return {
    isSuccessful: true,
    rsData: {
      userAccounts: [
        {
          accountNo: "12345678901234",
          accountItems: [
            {
              accountItemNo: "demand-item-1",
              acctNo: "12345678901234",
              curr: "TWD",
              displayActBalNoCurr: "12,345",
              displayWorkBalNoCurr: "12,000",
              aliasName: "薪轉帳戶",
            },
          ],
        },
      ],
    },
  };
}

function timeDepositResponse() {
  return {
    isSuccessful: true,
    rsData: {
      repeats: [
        {
          tdDetail: {
            tdAccountNumber: "98765432109876",
            accountItemNo: "time-item-1",
            currency: "TWD",
            workingBalance: "50,000",
            displayProductType: "一年期定存",
          },
        },
      ],
    },
  };
}

function transactionResponse() {
  return {
    isSuccessful: true,
    rsData: {
      subAccountItemNo: "demand-item-1",
      curry: "TWD",
      despositTxnDetails: [
        {
          txnDate: "115/08/07",
          displayTxnAmount: "80",
          displayMemo: "測試扣款",
          debitCredit: "D",
          txnSeqNo: "tx-1",
        },
      ],
    },
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
