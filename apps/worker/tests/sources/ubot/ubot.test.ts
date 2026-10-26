import { describe, expect, it } from "vitest";
import forge from "node-forge";
import {
  deriveUbotDeviceUuid,
  encryptUbotPassword,
  encryptUbotRequest,
  formatUbotSid,
  hasUbotCreditCard,
  normalizeUbotDate,
  parseUbotCreditCardData,
  parseUbotDepositData,
  parseUbotLoanData,
  ubotDepositSourceId,
} from "../../../src/sources/ubot/protocol";
import {
  createUbotConnector,
  UbotVerificationRequiredError,
} from "../../../src/sources/ubot/mobile-api";

const testRsaKeyPair = forge.pki.rsa.generateKeyPair({
  bits: 1024,
  e: 0x10001,
});
const testPkcs1PublicKeyBase64 = forge.pki
  .publicKeyToRSAPublicKeyPem(testRsaKeyPair.publicKey)
  .replace(
    /-----BEGIN RSA PUBLIC KEY-----|-----END RSA PUBLIC KEY-----|\s+/g,
    "",
  );
const testSpkiPublicKeyBase64 = forge.pki
  .publicKeyToPem(testRsaKeyPair.publicKey)
  .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, "");
const testAesKeyBytes = "0123456789abcdef";
const testAesKeyBase64 = forge.util.encode64(testAesKeyBytes);

describe("ubot protocol & crypto", () => {
  it("normalizes full-width characters and formats sid & deviceUuid", () => {
    expect(formatUbotSid("ａ１２３４５６７８９")).toBe("A123456789A");
    expect(formatUbotSid("A123456789A")).toBe("A123456789A");
    const uuid = deriveUbotDeviceUuid("a123456789");
    expect(uuid).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveUbotDeviceUuid("A123456789A")).toBe(uuid);
  });

  it("encrypts password with PKCS#1 RSA and reqec payload with AES-128-OFB + PKCS#7 padding", () => {
    const miMa = encryptUbotPassword("Pass1234", testPkcs1PublicKeyBase64);
    const decryptedPass = forge.util.decodeUtf8(
      testRsaKeyPair.privateKey.decrypt(
        forge.util.decode64(miMa),
        "RSAES-PKCS1-V1_5",
      ),
    );
    expect(decryptedPass).toBe("Pass1234");

    const sendData = {
      sid: "A123456789A",
      nickName: "user01",
      miMa: "cipher",
      deviceModel: "google-husky",
    };
    const { p1, p2 } = encryptUbotRequest(
      sendData,
      testSpkiPublicKeyBase64,
      testAesKeyBase64,
      "1234567890123456",
    );

    const recoveredIv = forge.util.decodeUtf8(
      testRsaKeyPair.privateKey.decrypt(
        forge.util.decode64(p2),
        "RSAES-PKCS1-V1_5",
      ),
    );
    expect(recoveredIv).toBe("1234567890123456");

    const decipher = forge.cipher.createDecipher("AES-OFB", testAesKeyBytes);
    decipher.start({ iv: recoveredIv });
    decipher.update(forge.util.createBuffer(forge.util.decode64(p1), "raw"));
    decipher.finish();
    const rawOut = decipher.output.getBytes();
    const padLen = rawOut.charCodeAt(rawOut.length - 1);
    expect(padLen).toBeGreaterThanOrEqual(1);
    expect(padLen).toBeLessThanOrEqual(16);
    const unpadded = forge.util.decodeUtf8(rawOut.slice(0, -padLen));
    expect(JSON.parse(unpadded)).toEqual(sendData);
  });

  it("normalizes Western and ROC 7-digit dates", () => {
    expect(normalizeUbotDate("2026-10-16")).toBe("2026-10-16");
    expect(normalizeUbotDate("20261016")).toBe("2026-10-16");
    expect(normalizeUbotDate("01150102")).toBe("2026-01-02");
    expect(normalizeUbotDate("1150102")).toBe("2026-01-02");
    expect(normalizeUbotDate("99999999")).toBeUndefined();
  });
});

describe("ubot financial data parsing", () => {
  const now = new Date("2026-10-23T12:00:00.000Z");

  it("parses TWD/FX deposits, time deposits, and transactions without leaking full account numbers", () => {
    const parsed = parseUbotDepositData(
      {
        twdSummary: {
          Account: "068509086798",
          AccountBal: 50000,
          AvailableBal: 49500,
          FreeTranTimes: "10",
          FreeGetTimes: "10",
          state: "0",
        },
        twdTransactions: [
          {
            TraDate: "2026-10-16",
            TraDateTime: "2026-10-16 01:13:06",
            TraType: "1",
            Expenditure: 1320,
            Income: 0,
            Balance: 48680,
            TraSum: "行動跨轉",
            Summary: "(008163200462888)",
            PS: "房租分攤",
            ToBankCode: "008",
            is1400: "N",
          },
          {
            TraDate: "2026-10-15",
            TraDateTime: "2026-10-15 19:27:47",
            TraType: "2",
            Expenditure: 0,
            Income: 2500,
            Balance: 50000,
            TraSum: "轉帳存入",
            Summary: "(822000012345678)",
            PS: "",
            ToBankCode: "822",
            is1400: "N",
          },
        ],
        twdTimeDeposit: {
          ToAccount: "068770012345",
          CtList: [
            {
              CtIdNo: "000001",
              CtAmt: 100000,
              CtType: "定期儲蓄存款",
              CtRate: "1.65",
              Period: "12個月",
              CtStartDate: "2026/01/15",
              CtEndDate: "2027/01/15",
            },
          ],
        },
        fxSummary: {
          Account: "068008009876",
          FTList: [
            {
              CurrencyNum: "01",
              CurrencyChinese: "美金",
              CurrencyEnglish: "USD",
              Balance: 1200.5,
              NTBalance: 38416,
            },
          ],
        },
        fxTransactions: [
          {
            accountNumber: "068008009876",
            currency: "USD",
            payload: {
              FTDetailList: [
                {
                  TxnDate: "2026/10/10",
                  CurrencyEName: "USD",
                  Expenditure: 0,
                  Income: 200.5,
                  Balance: 1200.5,
                  TraSum: "外幣買入",
                  Memo: "換匯",
                },
              ],
            },
          },
        ],
        fxTimeDeposit: {
          ToAccount: "068008009876",
          FCTList: [
            {
              VchrNo: "00002",
              Currency: "USD",
              Amt: 3000,
              NTAmt: 96000,
              IntRate: "4.50",
              Period: "6個月",
              IntDate: "01150601",
              ExpDate: "01151201",
            },
          ],
        },
      },
      now,
    );

    expect(parsed.bankAccounts).toHaveLength(4);
    expect(parsed.bankBalanceSnapshots).toHaveLength(4);
    expect(parsed.bankTransactions).toHaveLength(3);

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("068509086798");
    expect(serialized).not.toContain("008163200462888");
    expect(serialized).not.toContain("068008009876");

    const twdTx = parsed.bankTransactions[0]!;
    expect(twdTx.amount).toBe(-1320);
    expect(twdTx.postedDate).toBe("2026-10-16");
    expect(twdTx.authorizedAt).toBe("2026-10-16T01:13:06+08:00");
    expect(twdTx.description).toContain("行動跨轉 · 房租分攤");
    expect(twdTx.description).toContain("••••2888");

    const fxTd = parsed.bankAccounts.find((a) =>
      a.accountName?.includes("USD 00002"),
    );
    expect(fxTd).toMatchObject({
      accountType: "time_deposit",
      currency: "USD",
      openedDate: "2026-06-01",
      maturityDate: "2026-12-01",
    });
  });

  it("parses credit cards, skips summary rows in unbilled list, and computes liability balance", () => {
    expect(hasUbotCreditCard({ ErCode_1: "NSCRD", ErCode_2: "0021" })).toBe(
      false,
    );

    const parsed = parseUbotCreditCardData(
      {
        cardList: {
          ErCode_1: "0000",
          CardTypeList: [
            {
              CardNo: "4000-12XX-XXXX-8899",
              CardName: "聯邦吉鶴卡",
              CardSchema: "JCB",
              VirtualCard: "N",
              Activate: "Y",
            },
          ],
        },
        summary: {
          BillList: [
            {
              DueDate: "20261105",
              CurrBal: 15000,
              DueAmt: 1500,
              CTDPayAmt: 5000,
              CrLmt: 200000,
              AvalCrLmt: 186000,
              UnsettleAmt: 4000,
              // 帳務總覽的 PaymentAcctno 是卡號，不可當成扣款帳號。
              PaymentAcctno: "4000123456788899",
              HasBill: "Y",
              CycleDay: "15",
            },
          ],
        },
        unbilled: {
          UnbillList: [
            {
              CardNo: "8899",
              Seq: "1",
              EffectiveDate: "20261018",
              PostingDate: "20261020",
              TxCode: "40",
              TxAmt: 4000,
              TxDesc: "日本航空",
            },
            {
              CardNo: "",
              EffectiveDate: "99999999",
              TxCode: "05",
              TxAmt: 500,
              TxDesc: "查證中款項",
            },
          ],
        },
        statements: [
          {
            period: "202610",
            payload: {
              HeaderInfo: [
                {
                  StmtDate: "20261015",
                  DueDate: "20261105",
                  CurrBal: 15000,
                  DueAmt: 1500,
                  CTDPayAmt: 5000,
                },
              ],
              BillList: [
                {
                  CardNo: "8899",
                  EffectiveDate: "20261001",
                  PostingDate: "20261003",
                  TxAmt: 15000,
                  TxDesc: "百貨公司",
                },
              ],
            },
          },
        ],
        realtimeAuth: {
          CardBillList: [
            {
              CardNo: "400012XXXXXX8899",
              CardName: "聯邦吉鶴卡",
              DateTime: "2026/10/22 18:30:00",
              StoreName: "全家便利商店",
              Amt: 120,
            },
          ],
        },
        autopay: {
          Account: "068509086798",
          BillList: [
            {
              AppDate: "2026/03/03",
              Account: "068509086798",
              Status: "0",
              Type: "20",
            },
          ],
        },
      },
      now,
    );

    expect(parsed.bankAccounts).toHaveLength(1);
    expect(parsed.bankAccounts[0]).toMatchObject({
      sourceId: "credit:ubot:TWD",
      accountName: "聯邦吉鶴卡",
      creditLimit: 200000,
      autopayAccount: {
        bankCode: "803",
        last4: "6798",
        depositSourceId: ubotDepositSourceId("068509086798", "TWD"),
      },
    });

    // statementRemaining = 15000 - 5000 = 10000; unbilledTotal = 4000 -> liability = -14000
    expect(parsed.bankBalanceSnapshots[0]?.balance).toBe(-14000);
    expect(parsed.creditCardBills).toHaveLength(1);
    expect(parsed.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-10",
      statementAmount: 15000,
      minimumPayment: 1500,
      paidAmount: 5000,
      isPaid: false,
      paymentDueDate: "2026-11-05",
      statementClosingDate: "2026-10-15",
    });

    // 1 billed + 1 unbilled (summary row skipped) + 1 pending realtime auth = 3
    expect(parsed.bankTransactions).toHaveLength(3);
    expect(
      parsed.bankTransactions.find((tx) => tx.status === "pending"),
    ).toMatchObject({
      amount: -120,
      description: "全家便利商店",
      postedDate: "2026-10-22",
      authorizedAt: "2026-10-22T18:30:00+08:00",
    });
  });

  it("builds the latest bill from the account summary when statement detail has no header", () => {
    const parsed = parseUbotCreditCardData(
      {
        cardList: {
          ErCode_1: "0000",
          CardTypeList: [{ CardNo: "4000-12XX-XXXX-8899", CardName: "範例卡" }],
        },
        summary: {
          BillList: [
            {
              CurrBal: 83,
              CTDPayAmt: 0,
              UnsettleAmt: 0,
              DueDate: "20261027",
              HasBill: "Y",
            },
          ],
        },
        unbilled: { UnbillList: [] },
        statements: [
          { period: "202608", payload: { BillList: [] } },
          { period: "202610", payload: { BillList: [] } },
          { period: "202609", payload: { BillList: [] } },
        ],
      },
      now,
    );

    expect(parsed.creditCardBills).toEqual([
      expect.objectContaining({
        sourceId: "credit:ubot:TWD:bill:2026-10",
        billingPeriod: "2026-10",
        statementAmount: 83,
        paidAmount: 0,
        isPaid: false,
        paymentDueDate: "2026-10-27",
      }),
    ]);
  });

  it("keeps the same sourceId when an unbilled purchase moves onto a statement", () => {
    const purchase = {
      CardNo: "8899",
      EffectiveDate: "20261018",
      PostingDate: "20261020",
      TxAmt: 4000,
      TxDesc: "範例航空",
    };
    const base = {
      cardList: {
        ErCode_1: "0000",
        CardTypeList: [{ CardNo: "4000-12XX-XXXX-8899", CardName: "範例卡" }],
      },
      summary: { BillList: [{ CrLmt: 200000, HasBill: "Y" }] },
    };
    const postedSourceIds = (
      data: ReturnType<typeof parseUbotCreditCardData>,
    ) =>
      data.bankTransactions
        .filter((tx) => tx.status === "posted")
        .map((tx) => tx.sourceId);

    const beforeClosing = parseUbotCreditCardData(
      { ...base, unbilled: { UnbillList: [{ ...purchase, TxCode: "40" }] } },
      now,
    );
    const afterClosing = parseUbotCreditCardData(
      {
        ...base,
        unbilled: { UnbillList: [] },
        statements: [
          {
            period: "202610",
            payload: {
              HeaderInfo: [{ StmtDate: "20261115", DueDate: "20261205" }],
              BillList: [purchase],
            },
          },
        ],
      },
      now,
    );

    expect(postedSourceIds(beforeClosing)).toHaveLength(1);
    expect(postedSourceIds(afterClosing)).toEqual(
      postedSourceIds(beforeClosing),
    );
  });

  it("keeps two identical purchases split across a statement and the unbilled list", () => {
    const purchase = {
      CardNo: "8899",
      EffectiveDate: "20261015",
      PostingDate: "20261015",
      TxAmt: 300,
      TxDesc: "範例超商",
    };
    const parsed = parseUbotCreditCardData(
      {
        cardList: {
          ErCode_1: "0000",
          CardTypeList: [{ CardNo: "4000-12XX-XXXX-8899", CardName: "範例卡" }],
        },
        summary: { BillList: [{ CrLmt: 200000, HasBill: "Y" }] },
        unbilled: { UnbillList: [{ ...purchase, TxCode: "40" }] },
        statements: [
          {
            period: "202610",
            payload: {
              HeaderInfo: [{ StmtDate: "20261015", DueDate: "20261105" }],
              BillList: [purchase],
            },
          },
        ],
      },
      now,
    );

    const sourceIds = parsed.bankTransactions
      .filter((tx) => tx.status === "posted")
      .map((tx) => tx.sourceId);
    expect(sourceIds).toHaveLength(2);
    expect(new Set(sourceIds).size).toBe(2);
  });

  it("parses personal loans with negative balance and autopay reference", () => {
    const parsed = parseUbotLoanData(
      {
        LoanList: [
          {
            CreditNo: "068300012345",
            AmtPay: 450000,
            IntPay: 850,
            DamPay: 0,
            ODpay: 0,
            BranchCH: "敦化分行",
            PayAccount: "068509086798",
            LoanDate: "2025/05/10",
            LoanExpDate: "2032/05/10",
            PayDay2: "10",
            Rate9: "2.18",
          },
        ],
      },
      now,
    );

    expect(parsed.bankAccounts).toHaveLength(1);
    expect(parsed.bankAccounts[0]).toMatchObject({
      accountType: "loan",
      loanCategory: "personal",
      loanInterestRate: 2.18,
      openedDate: "2025-05-10",
      maturityDate: "2032-05-10",
      autopayAccount: {
        bankCode: "803",
        last4: "6798",
      },
    });
    expect(parsed.bankBalanceSnapshots[0]?.balance).toBe(-450000);
  });
});

describe("ubot connector session lifecycle", () => {
  it("completes read-only sync with NS161 ssid header, splits MFOB date ranges, and logs out", async () => {
    const calledEndpoints: string[] = [];
    let txCallCount = 0;

    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const api = url.pathname.replace("/NNBank/svc/", "");
      calledEndpoints.push(api);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      const jsonResponse = (
        payload: Record<string, unknown>,
        headers: Record<string, string> = {},
      ) => {
        const resCode =
          typeof payload.ResCode === "object" && payload.ResCode !== null
            ? payload.ResCode
            : {
                RtnCode: payload.RtnCode ?? "0000",
                RtnDesc: payload.RtnMsg ?? "交易成功",
              };
        return new Response(
          JSON.stringify({
            ResCode: resCode,
            ResBody: payload.ResBody ?? {},
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", ...headers },
          },
        );
      };

      switch (api) {
        case "NNBCM000007":
          return jsonResponse({
            RtnCode: "0000",
            ResBody: { PublicKey: testPkcs1PublicKeyBase64 },
          });
        case "NNBCM000011":
          return jsonResponse({
            RtnCode: "0000",
            ResBody: {
              k1: testSpkiPublicKeyBase64,
              k2: testAesKeyBase64,
            },
          });
        case "NNBI010101":
          return jsonResponse(
            {
              RtnCode: "NS161",
              RtnMsg: "未綁定裝置",
              ResBody: { FlagList: { MissingUserFlag: "0", KycFlag: "N" } },
            },
            { ssid: "test-ssid-token" },
          );
        case "NNBN020101":
          expect((init?.headers as Record<string, string>)?.Authorization).toBe(
            "test-ssid-token",
          );
          return jsonResponse({
            RtnCode: "0000",
            ResBody: {
              Account: "068509086798",
              AccountBal: 12345,
              AvailableBal: 12345,
            },
          });
        case "NNBN010201":
          txCallCount += 1;
          if (txCallCount === 1) {
            return jsonResponse({
              RtnCode: "0000",
              ResBody: { WarnCode: "MFOB", Details: [] },
            });
          }
          return jsonResponse({
            RtnCode: "0000",
            ResBody: {
              WarnCode: "0000",
              Details: [
                {
                  TraDate: "2026-10-16",
                  TraDateTime: "2026-10-16 12:00:00",
                  TraType: "2",
                  Expenditure: 0,
                  Income: 100,
                  Balance: 12345,
                  TraSum: `分段${txCallCount}存入`,
                  Summary: "",
                  PS: String(body.beginDate),
                },
              ],
            },
          });
        case "NNBN030101":
          return jsonResponse({ RtnCode: "0000", ResBody: { CtList: [] } });
        case "NNBF010201":
        case "NNBF020301":
          return jsonResponse({ RtnCode: "NS102", ResBody: {} });
        case "NNBC010105":
          return jsonResponse({
            RtnCode: "0000",
            ResBody: { ErCode_1: "NSCRD", ErCode_2: "0021" },
          });
        case "NNBL010401":
          return jsonResponse({ RtnCode: "NSLOND", ResBody: {} });
        case "NNBI010103":
          return jsonResponse({ RtnCode: "0000", ResBody: {} });
        default:
          throw new Error(`Unexpected endpoint: ${api}`);
      }
    };

    const result = await createUbotConnector(fetcher).sync({
      userId: "A123456789",
      account: "user01",
      password: "Password1",
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankTransactions).toHaveLength(2);
    expect(calledEndpoints).toContain("NNBI010103");
    // 絕不呼叫任何裝置綁定端點
    expect(calledEndpoints).not.toContain("NNBS000004");
    expect(calledEndpoints).not.toContain("NNBI020101");
    expect(calledEndpoints).not.toContain("NNBI020102");
  });

  it.each([
    ["NNBC010105", "error"],
    ["NNBC010105", "inner-error"],
    ["NNBC010105", "unknown-no-card"],
    ["NNBC010102", "error"],
    ["NNBC080201", "error"],
    ["NNBC010104", "error"],
    ["NNBC010104", "network"],
    ["NNBC010104", "B060"],
    ["NNBC010102", "missing-list"],
    ["NNBC080201", "missing-list"],
    ["NNBC010104", "missing-list"],
  ])(
    "rejects incomplete card sync after a complete sync: %s / %s",
    async (failedApi, failure) => {
      const purchase = {
        CardNo: "8899",
        EffectiveDate: "20261015",
        PostingDate: "20261015",
        TxAmt: 300,
        TxDesc: "範例超商",
      };
      const responses: Record<string, Record<string, unknown>> = {
        NNBCM000007: { PublicKey: testPkcs1PublicKeyBase64 },
        NNBCM000011: { k1: testSpkiPublicKeyBase64, k2: testAesKeyBase64 },
        NNBI010101: { FlagList: {} },
        NNBI010103: {},
        NNBN020101: { Account: "068509086798", AccountBal: 12345 },
        NNBN010201: { Details: [] },
        NNBN030101: { CtList: [] },
        NNBF010201: { FTList: [] },
        NNBF020301: {},
        NNBL010401: { LoanList: [] },
        NNBC010105: {
          ErCode_1: "0000",
          CardTypeList: [{ CardNo: "4000-12XX-XXXX-8899", CardName: "範例卡" }],
        },
        NNBC010101: { BillList: [{ CrLmt: 200000, HasBill: "Y" }] },
        NNBC010102: { UnbillList: [{ ...purchase, TxCode: "40" }] },
        NNBC080201: { HeaderInfo: [{ Date: "202610" }] },
        NNBC010104: { BillList: [purchase] },
        NNBC080101: { CardBillList: [] },
        NNBC030101: {},
      };
      let fail = false;
      let logoutCount = 0;
      const connector = createUbotConnector(async (input) => {
        const api = new URL(String(input)).pathname.replace("/NNBank/svc/", "");
        if (api === "NNBI010103") logoutCount++;
        if (!(api in responses)) throw new Error(`Unexpected endpoint: ${api}`);
        const rejected = fail && api === failedApi;
        if (rejected && failure === "network")
          throw new Error("Network unavailable");
        const innerError =
          failure === "inner-error" || failure === "unknown-no-card";
        return new Response(
          JSON.stringify({
            ResCode: {
              RtnCode:
                rejected && failure !== "missing-list" && !innerError
                  ? failure === "B060"
                    ? "B060"
                    : "9999"
                  : "0000",
            },
            ResBody: rejected
              ? innerError
                ? {
                    ErCode_1: failure === "inner-error" ? "9999" : "NSCRD",
                    ErCode_2: "UNKNOWN",
                  }
                : {}
              : responses[api],
          }),
          { headers: api === "NNBI010101" ? { ssid: "test-ssid" } : {} },
        );
      });
      const config = {
        userId: "A123456789",
        account: "user01",
        password: "Password1",
      };
      const first = await connector.sync(config);
      const firstIds = first.bankTransactions!.map((tx) => tx.sourceId);
      expect(firstIds).toHaveLength(2);
      expect(new Set(firstIds).size).toBe(2);

      fail = true;
      // No SyncResult reaches syncUbot's persistence or cursor update on failure.
      await expect(connector.sync(config, first.cursor)).rejects.toThrow();
      expect(logoutCount).toBe(2);

      fail = false;
      const recovered = await connector.sync(config, first.cursor);
      expect(recovered.bankTransactions!.map((tx) => tx.sourceId)).toEqual(
        firstIds,
      );

      // Successful empty lists are valid, unlike a failed or missing response.
      responses.NNBC010102 = { UnbillList: [] };
      responses.NNBC080201 = { HeaderInfo: [] };
      expect((await connector.sync(config)).bankTransactions).toEqual([]);
    },
  );

  it.each([
    ["NS169", "使用者代號或密碼錯誤", 200],
    ["NM85", "系統忙碌中", 400],
    ["NM85", "系統忙碌中", 403],
  ])(
    "stops immediately with UbotVerificationRequiredError on rejected login (%s, HTTP %i)",
    async (rtnCode, rtnMsg, loginStatus) => {
      const fetcher = async (input: RequestInfo | URL) => {
        const api = new URL(String(input)).pathname.replace("/NNBank/svc/", "");
        const jsonResponse = (payload: Record<string, unknown>, status = 200) =>
          new Response(
            JSON.stringify({
              ResCode: {
                RtnCode: payload.RtnCode ?? "0000",
                RtnDesc: payload.RtnMsg ?? "交易成功",
              },
              ResBody: payload.ResBody ?? {},
            }),
            { status },
          );
        if (api === "NNBCM000007") {
          return jsonResponse({
            RtnCode: "0000",
            ResBody: { PublicKey: testPkcs1PublicKeyBase64 },
          });
        }
        if (api === "NNBCM000011") {
          return jsonResponse({
            RtnCode: "0000",
            ResBody: {
              k1: testSpkiPublicKeyBase64,
              k2: testAesKeyBase64,
            },
          });
        }
        return jsonResponse({ RtnCode: rtnCode, RtnMsg: rtnMsg }, loginStatus);
      };

      const sync = createUbotConnector(fetcher).sync({
        userId: "A123456789",
        account: "user01",
        password: "WrongPass1",
      });
      await expect(sync).rejects.toBeInstanceOf(UbotVerificationRequiredError);
      await expect(sync).rejects.toThrow(rtnCode);
    },
  );
});
