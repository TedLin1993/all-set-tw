import assert from "node:assert/strict";
import forge from "node-forge";
import { parseSkbankConfig, parseSkbankData } from "../../src/skbank";
import {
  buildSkbankApiDiagnostic,
  buildSkbankLoginRequest,
  createSkbankConnector,
  SkbankVerificationRequiredError,
} from "../../src/skbank-mobile-api";
import {
  hasSkbankCreditCard,
  parseSkbankCreditCardData,
} from "../../src/skbank-credit-card";

const nationalId = "A123456789";
const alias = "synthetic-skbank-alias";
const password = "synthetic-skbank-password";
const deviceId = "11111111-2222-4333-8444-555555555555";
const accountNumber = "7000000000001234";
const timeDepositNumber = "7000000000005678";
const now = new Date("2026-08-23T00:00:00.000Z");

assert.deepEqual(parseSkbankConfig({ nationalId, alias, password, deviceId }), {
  nationalId,
  alias,
  password,
  deviceId,
});

const diagnostic = buildSkbankApiDiagnostic(
  "/api/v1/Account/FetchTransactionDetails",
  "TX-1234",
  "帳號 7000 0000 0000 1234，token=abcdefghijklmnopqrstuvwx，請見 https://example.test/path?account=1234",
);
assert.deepEqual(
  {
    event: diagnostic.event,
    endpoint: diagnostic.endpoint,
    returnCode: diagnostic.returnCode,
  },
  {
    event: "skbank_api_rejected",
    endpoint: "Account.FetchTransactionDetails",
    returnCode: "TX-1234",
  },
);
assert.match(diagnostic.returnMessage ?? "", /••••1234/);
assert.match(diagnostic.returnMessage ?? "", /token=\[redacted\]/);
assert.match(diagnostic.returnMessage ?? "", /\[URL\]/);
assert.doesNotMatch(
  JSON.stringify(diagnostic),
  /7000 0000 0000 1234|abcdefghijklmnopqrstuvwx|example\.test/,
);
assert.equal(
  buildSkbankApiDiagnostic("/not-allowed", "bad code!", "").endpoint,
  "Unknown",
);
assert.equal(
  buildSkbankApiDiagnostic("/not-allowed", "bad code!", "").returnCode,
  "UNKNOWN",
);

const accountPayload = {
  Data: {
    AccountList: [
      {
        AccountNumber: accountNumber,
        Nickname: "日常帳戶 7000 0000 0000 1234",
        ProductCode: "SAV-001",
        ProductFullName: "新光活期儲蓄",
        AccountProperty: "Savings",
        Details: [
          {
            CurrencyCode: "USD",
            DisplayGroup: ["DemandDeposit"],
            AccountBalance: "999",
            AvailableBalance: "999",
          },
          {
            CurrencyCode: "TWD",
            DisplayGroup: ["DemandDeposit"],
            AccountNumberDisplay: "****1234",
            AccountBalance: "12,345",
            AvailableBalance: "10,000",
          },
        ],
      },
      {
        AccountNumber: timeDepositNumber,
        ProductCode: "TD-001",
        ProductFullName: "新光臺幣定期存款",
        AccountProperty: "Time Deposit",
        Details: [
          {
            CurrencyCode: "TWD",
            DisplayGroup: ["TimeDeposit"],
            AccountNumberDisplay: "****5678",
            TimeDepositBalance: "88,888",
            AvailableBalance: "88,888",
          },
        ],
      },
      // A duplicate response entry must not create a second account/snapshot.
      {
        AccountNumber: accountNumber,
        Nickname: "日常帳戶 7000 0000 0000 1234",
        ProductFullName: "新光活期儲蓄",
        Details: [
          {
            CurrencyCode: "TWD",
            DisplayGroup: ["DemandDeposit"],
            AccountNumberDisplay: "****1234",
            AccountBalance: "12,345",
            AvailableBalance: "10,000",
          },
        ],
      },
    ],
  },
};

const foreignAccountPayload = {
  Data: {
    TotalAvailableBalanceForTwd: "15,432.10",
    AccountList: [
      {
        AccountNumber: accountNumber,
        Nickname: "外幣日常帳戶",
        ProductCode: "F500002",
        ProductFullName: "新光外幣活期存款",
        AccountProperty: "Savings",
        BranchCode: "001",
        BranchName: "總行",
        HasNtpFunction: true,
        HasTransferFunction: true,
        IsAuthorizedAccount: false,
        Details: [
          {
            AccountBalance: "123.45",
            AccountBalanceForTwd: "3,950.40",
            AccountNumberDisplay: "****1234",
            AvailableBalance: "100.00",
            AvailableBalanceForTwd: "3,200.00",
            CurrencyCode: "USD",
            TimeDepositBalance: "0",
            TimeDepositBalanceForTwd: "0",
            DisplayGroup: ["DemandDeposit"],
          },
        ],
      },
      {
        AccountNumber: timeDepositNumber,
        ProductCode: "F500001",
        ProductFullName: "新光日圓定期存款",
        Details: [
          {
            AccountBalance: "0",
            AccountBalanceForTwd: "0",
            AccountNumberDisplay: "****5678",
            AvailableBalance: "0",
            AvailableBalanceForTwd: "0",
            CurrencyCode: "JPY",
            TimeDepositBalance: "50,000",
            TimeDepositBalanceForTwd: "10,500",
            DisplayGroup: ["TimeDeposit"],
          },
        ],
      },
    ],
  },
};

const assetsOverviewPayload = { Data: { HasValidCreditCard: true } };
const creditCardSummaryPayload = {
  Data: {
    CurrentStatementBalance: "3,200",
    MinimumPaymentDue: "500",
    PaymentDueDate: "2026/08/13",
    AvailableCredit: "130,000",
    ClosingDate: "14",
    StatementMonth: "7",
    CurrentCredit: "250,000",
  },
};
const creditCardsPayload = {
  Data: {
    CreditCardList: [
      {
        CardNumber: "4123456789012345",
        CardName: "寰宇現金回饋卡 4123 4567 8901 2345",
      },
    ],
  },
};
const billingHistoryPayload = {
  Data: {
    Bills: [
      { Year: "2026", Month: "8", StatementBalance: "4,648" },
      { Year: "2026", Month: "7", StatementBalance: "3,200" },
      { Year: "2026", Month: "6", StatementBalance: "2,100" },
      { Year: "2026", Month: "5", StatementBalance: "1,000" },
    ],
  },
};
const remainingDuePayload = { Data: { RemainingDue: "1,200" } };

assert.equal(hasSkbankCreditCard(assetsOverviewPayload), true);
assert.deepEqual(
  parseSkbankCreditCardData({
    assetsOverview: { Data: { HasValidCreditCard: false } },
  }),
  { bankAccounts: [], bankBalanceSnapshots: [], creditCardBills: [] },
);
const parsedCreditCard = parseSkbankCreditCardData(
  {
    assetsOverview: assetsOverviewPayload,
    summary: creditCardSummaryPayload,
    cards: creditCardsPayload,
    billingHistory: billingHistoryPayload,
    remainingDue: remainingDuePayload,
  },
  now,
);
assert.equal(parsedCreditCard.bankAccounts[0]?.creditLimit, 250000);
assert.equal(parsedCreditCard.bankBalanceSnapshots[0]?.balance, -1200);
assert.equal(parsedCreditCard.bankBalanceSnapshots[0]?.statementBalance, 3200);
assert.equal(parsedCreditCard.creditCardBills.length, 3);
assert.equal(parsedCreditCard.creditCardBills[0]?.billingPeriod, "2026-08");
assert.equal(parsedCreditCard.creditCardBills[0]?.minimumPayment, undefined);
assert.equal(parsedCreditCard.creditCardBills[1]?.minimumPayment, 500);
assert.equal(parsedCreditCard.creditCardBills[1]?.paidAmount, 2000);
assert.equal(parsedCreditCard.creditCardBills[1]?.isPaid, false);
assert.doesNotMatch(JSON.stringify(parsedCreditCard), /4123456789012345/);
assert.doesNotMatch(JSON.stringify(parsedCreditCard), /4123 4567 8901 2345/);
assert.match(JSON.stringify(parsedCreditCard), /2345/);

const noDebtCreditCard = parseSkbankCreditCardData(
  {
    assetsOverview: assetsOverviewPayload,
    summary: creditCardSummaryPayload,
    cards: creditCardsPayload,
    billingHistory: billingHistoryPayload,
    remainingDue: { Data: { RemainingDue: "本期帳單無欠款" } },
  },
  now,
);
assert.equal(noDebtCreditCard.bankBalanceSnapshots[0]?.balance, 0);
assert.equal(noDebtCreditCard.bankBalanceSnapshots[0]?.noPaymentNeeded, true);
assert.equal(noDebtCreditCard.creditCardBills[0]?.isPaid, undefined);
assert.equal(noDebtCreditCard.creditCardBills[1]?.paidAmount, 3200);
assert.equal(noDebtCreditCard.creditCardBills[1]?.isPaid, true);
assert.equal(noDebtCreditCard.creditCardBills[2]?.paidAmount, 2100);
assert.equal(noDebtCreditCard.creditCardBills[2]?.isPaid, true);
assert.equal(
  (noDebtCreditCard.creditCardBills[2]?.raw as Record<string, unknown>)
    ?.statusSource,
  "inferred_from_current_zero_remaining_due",
);

const originalCreditCardWarn = console.warn;
const creditCardWarnings: unknown[] = [];
console.warn = (...values: unknown[]) => {
  creditCardWarnings.push(...values);
};
try {
  assert.throws(() =>
    hasSkbankCreditCard({
      Data: { HasValidCreditCard: "sensitive-card-status-4123456789012345" },
    }),
  );
  assert.throws(() =>
    parseSkbankCreditCardData({
      assetsOverview: assetsOverviewPayload,
      summary: creditCardSummaryPayload,
      cards: {
        Data: {
          CreditCardList:
            "sensitive-card-4123456789012345 https://example.test responseBody=secret",
        },
      },
      billingHistory: billingHistoryPayload,
      remainingDue: remainingDuePayload,
    }),
  );
  assert.throws(() =>
    parseSkbankCreditCardData({
      assetsOverview: assetsOverviewPayload,
      summary: {
        Data: {
          ...creditCardSummaryPayload.Data,
          CurrentCredit: "sensitive-credit-value",
        },
      },
      cards: creditCardsPayload,
      billingHistory: billingHistoryPayload,
      remainingDue: remainingDuePayload,
    }),
  );
  for (const value of ["查無資料", "NT$ 1,200", "--"]) {
    assert.throws(() =>
      parseSkbankCreditCardData({
        assetsOverview: assetsOverviewPayload,
        summary: creditCardSummaryPayload,
        cards: creditCardsPayload,
        billingHistory: billingHistoryPayload,
        remainingDue: { Data: { RemainingDue: value } },
      }),
    );
  }
} finally {
  console.warn = originalCreditCardWarn;
}
assert.equal(creditCardWarnings.length, 6);
assert.deepEqual(creditCardWarnings[0], {
  event: "skbank_credit_card_schema_mismatch",
  section: "assetsOverview",
  field: "HasValidCreditCard",
  valueType: "string_other",
});
assert.deepEqual(creditCardWarnings[1], {
  event: "skbank_credit_card_schema_mismatch",
  section: "cards",
  field: "CreditCardList",
  valueType: "string_other",
});
assert.deepEqual(creditCardWarnings[2], {
  event: "skbank_credit_card_schema_mismatch",
  section: "summary",
  field: "CurrentCredit",
  valueType: "string_other",
});
assert.deepEqual(
  creditCardWarnings.slice(3).map((warning) => warning as object),
  [
    ["查無資料", "string_no_data"],
    ["NT$ 1,200", "string_currency_amount"],
    ["--", "string_placeholder"],
  ].map(([, valueType]) => ({
    event: "skbank_credit_card_schema_mismatch",
    section: "remainingDue",
    field: "RemainingDue",
    valueType,
  })),
);
for (const warning of creditCardWarnings) {
  assert.deepEqual(Object.keys(warning as object).sort(), [
    "event",
    "field",
    "section",
    "valueType",
  ]);
}
assert.doesNotMatch(
  JSON.stringify(creditCardWarnings),
  /4123456789012345|sensitive-card|sensitive-credit-value|250,000|130,000|https?:\/\/|response.?body/i,
);

const parsed = parseSkbankData(accountPayload, now);
assert.equal(parsed.bankAccounts.length, 2);
assert.equal(parsed.bankBalanceSnapshots.length, 2);
assert.deepEqual(
  parsed.bankAccounts.map(({ accountType }) => accountType),
  ["savings", "time_deposit"],
);
assert.equal(parsed.bankBalanceSnapshots[0]?.balance, 12345);
assert.equal(parsed.bankBalanceSnapshots[0]?.availableBalance, 10000);
assert.equal(parsed.bankBalanceSnapshots[1]?.balance, 88888);
assert.equal(parsed.bankAccounts[0]?.accountName, "日常帳戶 ••••1234");
assert.equal(parsed.bankAccounts[1]?.accountName, "新光臺幣定期存款");
assert.match(parsed.bankAccounts[0]?.sourceId ?? "", /^bank:skbank:1234:/);
assert.match(parsed.bankAccounts[1]?.sourceId ?? "", /^bank:skbank:5678:/);
assert.equal(parsed.bankBalanceSnapshots[0]?.asOfAt, now.toISOString());

const repeatedParsed = parseSkbankData(accountPayload, now);
assert.deepEqual(
  repeatedParsed.bankAccounts.map(({ sourceId }) => sourceId),
  parsed.bankAccounts.map(({ sourceId }) => sourceId),
);
const serializedParsed = JSON.stringify(parsed);
assert.doesNotMatch(serializedParsed, /7000000000001234|7000000000005678/);
assert.doesNotMatch(serializedParsed, /7000 0000 0000 1234/);
assert.match(serializedParsed, /1234/);
assert.match(serializedParsed, /5678/);

const foreignParsed = parseSkbankData(
  accountPayload,
  foreignAccountPayload,
  [
    {
      accountNumber,
      currency: "USD",
      payload: {
        Data: {
          Details: [
            {
              Amount: "-12.34",
              Balance: "111.11",
              ExchangeRate: "32.1",
              Memo: "美元提款",
              Summary: "現金",
              TransactionDate: "2022/07/18 10:28:20",
            },
          ],
          Paging: { Page: 1, PageSize: 100, TotalCount: 1 },
        },
      },
    },
  ],
  now,
);
assert.equal(foreignParsed.bankAccounts.length, 4);
assert.equal(foreignParsed.bankAccounts[2]?.currency, "USD");
assert.equal(foreignParsed.bankAccounts[3]?.accountType, "time_deposit");
assert.match(foreignParsed.bankAccounts[2]?.sourceId ?? "", /:USD$/);
assert.equal(foreignParsed.bankTransactions[0]?.amount, -12.34);
assert.equal(foreignParsed.bankTransactions[0]?.postedDate, "2022-07-18");
assert.doesNotMatch(
  JSON.stringify(foreignParsed),
  /7000000000001234|7000000000005678|InwardAccountNumber/,
);

const duplicateTransactionParsed = parseSkbankData(
  accountPayload,
  undefined,
  [
    {
      accountNumber,
      currency: "TWD",
      payload: {
        Data: {
          Details: [
            {
              Amount: "-50",
              Balance: "12,000",
              Memo: "同值交易",
              TransactionDate: "2022/07/18 10:28:20",
            },
            {
              Amount: "-50",
              Balance: "12,000",
              Memo: "同值交易",
              TransactionDate: "2022/07/18 10:28:20",
            },
          ],
        },
      },
    },
  ],
  now,
);
assert.equal(duplicateTransactionParsed.bankTransactions.length, 2);
assert.notEqual(
  duplicateTransactionParsed.bankTransactions[0]?.sourceId,
  duplicateTransactionParsed.bankTransactions[1]?.sourceId,
);

const keyPair = forge.pki.rsa.generateKeyPair({ bits: 512, e: 0x10001 });
const publicKey = {
  modulus: keyPair.publicKey.n.toString(16),
  exponent: keyPair.publicKey.e.toString(16),
};
const loginRequest = buildSkbankLoginRequest(
  { nationalId, alias, password },
  publicKey,
);
const loginEnvelope = JSON.parse(loginRequest.body) as {
  Payload: Record<string, unknown>;
  Signature: string;
};
const loginPayload = loginEnvelope.Payload;
assert.deepEqual(JSON.parse(loginRequest.payloadText), {
  Payload: loginPayload,
});
assert.equal(loginEnvelope.Signature, loginRequest.signature);
assert.equal(loginPayload.NationalIdNumber, nationalId);
assert.equal(loginPayload.Channel, "InternetBankingMember");
assert.equal(loginPayload.Method, "General");
assert.match(String(loginPayload.Alias), /^[0-9a-f]+$/);
assert.match(String(loginPayload.Password), /^[0-9a-f]+$/);
assert.notEqual(loginPayload.Alias, alias);
assert.notEqual(loginPayload.Password, password);
assert.doesNotMatch(
  JSON.stringify(loginPayload),
  /synthetic-skbank-alias|synthetic-skbank-password/,
);

const secret = forge.md.sha256
  .create()
  .update(nationalId, "utf8")
  .digest()
  .toHex();
const hmac = forge.hmac.create();
hmac.start("sha256", secret);
hmac.update(loginRequest.payloadText);
assert.equal(
  loginRequest.signature,
  forge.util.encode64(hmac.digest().getBytes()),
);

type RecordedRequest = {
  path: string;
  method: string;
  headers: Headers;
  body: string;
};
const setupPaths = [
  "/api/v1/Common/GetAppConfig",
  "/api/v2/Authentication/Login",
  "/api/v1/Foundation/GetUserInformation",
  "/api/v1/Common/GetMegaMenuStatus",
  "/api/v1/Account/GetAccountSummary",
  "/api/v1/Account/GetForeignCurrencyAccountSummary",
  "/api/v1/Account/GetAssetsOverview",
];

function createFakeFetch(emptyTransactionPaths = new Set<string>()) {
  const requests: RecordedRequest[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const requestInit = init ?? {};
    const headers = new Headers(requestInit.headers);
    const request: RecordedRequest = {
      path: url.pathname,
      method: requestInit.method ?? "GET",
      headers,
      body: String(requestInit.body ?? ""),
    };
    requests.push(request);
    const index = requests.length - 1;
    assert.equal(url.origin, "https://mbanking.skbank.com.tw");
    assert.equal(request.headers.get("Device-Id"), deviceId);
    assert.equal(
      request.headers.get("Authorization"),
      index < 2 ? "bearer" : "bearer synthetic-access-token",
    );

    if (index < setupPaths.length) {
      assert.equal(request.path, setupPaths[index]);
    }
    if (request.path === setupPaths[0]) {
      assert.equal(request.method, "GET");
      return jsonResponse({
        ReturnCode: "0000",
        Data: {
          PublicKey: {
            Module: publicKey.modulus,
            Exponent: publicKey.exponent,
          },
        },
      });
    }
    if (request.path === setupPaths[1]) {
      assert.equal(request.method, "POST");
      assert.doesNotMatch(
        request.body,
        /synthetic-skbank-alias|synthetic-skbank-password/,
      );
      const body = JSON.parse(request.body) as {
        Payload: Record<string, unknown>;
        Signature: string;
      };
      assert.equal(body.Payload.NationalIdNumber, nationalId);
      assert.match(String(body.Payload.Alias), /^[0-9a-f]+$/);
      assert.match(String(body.Payload.Password), /^[0-9a-f]+$/);
      assert.ok(body.Signature.length > 0);
      return jsonResponse({
        ReturnCode: "0000",
        Data: { AccessToken: "synthetic-access-token" },
      });
    }
    if (request.path === setupPaths[2] || request.path === setupPaths[3]) {
      assert.equal(request.method, "GET");
      return jsonResponse({ ReturnCode: "0000", Data: {} });
    }
    if (request.path === setupPaths[4]) {
      assert.equal(request.method, "GET");
      return jsonResponse({ ReturnCode: "0000", Data: accountPayload.Data });
    }
    if (request.path === setupPaths[5]) {
      assert.equal(request.method, "GET");
      return jsonResponse({
        ReturnCode: "0000",
        Data: foreignAccountPayload.Data,
      });
    }
    if (request.path === setupPaths[6]) {
      assert.equal(request.method, "GET");
      return jsonResponse({
        ReturnCode: "0000",
        Data: assetsOverviewPayload.Data,
      });
    }
    if (
      request.path === "/api/v1/Account/FetchTransactionDetails" ||
      request.path === "/api/v1/Account/FetchForeignCurrencyTransactionDetails"
    ) {
      assert.equal(request.method, "GET");
      assert.match(url.searchParams.get("AccountNumber") ?? "", /^7000/);
      assert.match(
        url.searchParams.get("BeginDate") ?? "",
        /^\d{4}\/\d{2}\/\d{2}$/,
      );
      assert.match(
        url.searchParams.get("EndDate") ?? "",
        /^\d{4}\/\d{2}\/\d{2}$/,
      );
      assert.equal(url.searchParams.get("IsOrderByAsc"), "true");
      assert.equal(url.searchParams.get("PageSize"), "100");
      const page = Number(url.searchParams.get("Page"));
      assert.ok(page >= 1);
      const account = url.searchParams.get("AccountNumber");
      const currency = url.searchParams.get("CurrencyCode") ?? "TWD";
      if (request.path.endsWith("ForeignCurrencyTransactionDetails")) {
        assert.match(currency, /^(USD|JPY)$/);
      } else {
        assert.equal(url.searchParams.has("CurrencyCode"), false);
        assert.equal(currency, "TWD");
      }
      if (emptyTransactionPaths.has(request.path)) {
        return jsonResponse({
          ReturnCode: "EMPTY_RESULT",
          ReturnMessage: "查無資料",
          Data: {},
        });
      }
      const isPaged =
        (account === accountNumber && currency === "TWD") || currency === "USD";
      const details =
        page === 1
          ? [
              {
                Amount: currency === "TWD" ? "-50" : "-12.34",
                Balance: currency === "TWD" ? "12,000" : "111.11",
                ExchangeRate: currency === "TWD" ? undefined : "32.1",
                Memo: currency === "TWD" ? "臺幣提款" : "美元提款",
                Remark:
                  currency === "TWD" ? "ATM 轉入 812345678901" : undefined,
                InwardAccountNumber:
                  currency === "TWD" ? "812345678901" : undefined,
                Summary: "現金",
                TransactionDate: "2022/07/18 10:28:20",
              },
            ]
          : page === 2
            ? [
                {
                  Amount: currency === "TWD" ? "10" : "1.23",
                  Balance: currency === "TWD" ? "12,010" : "112.34",
                  ExchangeRate: currency === "TWD" ? undefined : "32.2",
                  Memo: currency === "TWD" ? "利息" : "美元利息",
                  Remark: currency === "TWD" ? "入帳" : undefined,
                  Summary: "存款",
                  TransactionDate: "2022/07/19 09:00:00",
                },
              ]
            : [];
      return jsonResponse({
        ReturnCode: "0000",
        Data: {
          Details: details,
          Paging: { Page: page, PageSize: 100, TotalCount: 2 },
          Summary: { Deposit: "1", Withdrawal: "0" },
        },
      });
    }
    if (request.path === "/api/v1/CreditCard/GetSummary") {
      return jsonResponse({
        ReturnCode: "0000",
        Data: creditCardSummaryPayload.Data,
      });
    }
    if (request.path === "/api/v1/CreditCard/GetMyCreditCardsInformation") {
      return jsonResponse({
        ReturnCode: "0000",
        Data: creditCardsPayload.Data,
      });
    }
    if (request.path === "/api/v1/CreditCard/GetBillingHistory") {
      return jsonResponse({
        ReturnCode: "0000",
        Data: billingHistoryPayload.Data,
      });
    }
    if (request.path === "/api/v1/CreditCard/GetRemainingDue") {
      return jsonResponse({
        ReturnCode: "0000",
        Data: remainingDuePayload.Data,
      });
    }
    assert.equal(request.path, "/api/v1/Authentication/Logout");
    assert.equal(request.method, "POST");
    return jsonResponse({ ReturnCode: "0000", Data: {} });
  };
  return { requests, fetcher };
}

const { requests, fetcher: fakeFetch } = createFakeFetch();

const connectorResult = await createSkbankConnector(fakeFetch).sync({
  nationalId,
  alias,
  password,
  deviceId,
});
assert.deepEqual(
  requests.slice(0, setupPaths.length).map(({ path }) => path),
  setupPaths,
);
assert.equal(connectorResult.bankAccounts.length, 5);
assert.equal(connectorResult.bankBalanceSnapshots.length, 5);
assert.equal(connectorResult.bankTransactions.length, 4);
assert.equal(connectorResult.creditCardBills.length, 3);
assert.equal(connectorResult.bankTransactions[0]?.amount, -50);
assert.equal(connectorResult.bankTransactions[1]?.amount, 10);
assert.equal(connectorResult.bankTransactions[2]?.currency, "USD");
assert.equal(connectorResult.bankTransactions[2]?.amount, -12.34);
assert.equal(
  requests.filter(({ path }) => path.includes("TransactionDetails")).length,
  4,
);
assert.equal(requests.at(-1)?.path, "/api/v1/Authentication/Logout");
assert.equal(JSON.parse(connectorResult.cursor ?? "{}").deviceId, deviceId);
const serializedConnectorResult = JSON.stringify(connectorResult);
assert.doesNotMatch(
  serializedConnectorResult,
  /7000000000001234|7000000000005678|812345678901|4123456789012345|synthetic-skbank-alias|synthetic-skbank-password|A123456789/,
);

const legacyCursorFetch = createFakeFetch();
const legacyCursorResult = await createSkbankConnector(
  legacyCursorFetch.fetcher,
).sync(
  { nationalId, alias, password },
  JSON.stringify({ syncedAt: now.toISOString(), deviceId }),
);
assert.equal(JSON.parse(legacyCursorResult.cursor ?? "{}").deviceId, deviceId);

const emptyTransactionPaths = new Set([
  "/api/v1/Account/FetchTransactionDetails",
  "/api/v1/Account/FetchForeignCurrencyTransactionDetails",
]);
const emptyFetch = createFakeFetch(emptyTransactionPaths);
const originalWarnForEmpty = console.warn;
const emptyWarnings: string[] = [];
console.warn = (...values: unknown[]) => {
  emptyWarnings.push(values.map(String).join(" "));
};
const emptyConnectorResult = await (async () => {
  try {
    return await createSkbankConnector(emptyFetch.fetcher).sync({
      nationalId,
      alias,
      password,
      deviceId,
    });
  } finally {
    console.warn = originalWarnForEmpty;
  }
})();
assert.equal(emptyConnectorResult.bankTransactions.length, 0);
assert.deepEqual(
  emptyFetch.requests
    .filter(({ path }) => path.includes("TransactionDetails"))
    .map(({ path }) => path),
  [...emptyTransactionPaths],
);
assert.deepEqual(emptyWarnings, []);

const failedLoginRequests: RecordedRequest[] = [];
const failedLoginFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = new URL(String(input));
  const requestInit = init ?? {};
  failedLoginRequests.push({
    path: url.pathname,
    method: requestInit.method ?? "GET",
    headers: new Headers(requestInit.headers),
    body: String(requestInit.body ?? ""),
  });
  if (url.pathname === setupPaths[0]) {
    return jsonResponse({
      ReturnCode: "0000",
      Data: {
        PublicKey: { Module: publicKey.modulus, Exponent: publicKey.exponent },
      },
    });
  }
  assert.equal(url.pathname, setupPaths[1]);
  assert.doesNotMatch(
    String(requestInit.body ?? ""),
    /synthetic-skbank-alias|synthetic-skbank-password/,
  );
  return jsonResponse({
    ReturnCode: "MB201",
    ReturnMessage: `查無資料，帳號 ${nationalId}，token=abcdefghijklmnopqrstuvwx`,
    Data: {},
  });
};

const originalWarn = console.warn;
const diagnosticWarnings: string[] = [];
console.warn = (...values: unknown[]) => {
  diagnosticWarnings.push(values.map(String).join(" "));
};
try {
  await assert.rejects(
    () =>
      createSkbankConnector(failedLoginFetch).sync({
        nationalId,
        alias,
        password,
        deviceId,
      }),
    (error: unknown) => {
      if (!(error instanceof SkbankVerificationRequiredError)) return false;
      return (
        /登入失敗/.test(error.message) &&
        !error.message.includes(nationalId) &&
        !error.message.includes(alias) &&
        !error.message.includes(password)
      );
    },
  );
} finally {
  console.warn = originalWarn;
}
assert.equal(diagnosticWarnings.length, 1);
assert.deepEqual(JSON.parse(diagnosticWarnings[0] ?? "{}"), {
  event: "skbank_api_rejected",
  endpoint: "Authentication.Login",
  returnCode: "MB201",
  returnMessage: "查無資料，帳號 [redacted]，token=[redacted]",
});
assert.doesNotMatch(diagnosticWarnings[0] ?? "", /A123456789|abcdefghijkl/);
assert.deepEqual(
  failedLoginRequests.map(({ path }) => path),
  setupPaths.slice(0, 2),
);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

console.log("SKBank connector self-check passed.");
