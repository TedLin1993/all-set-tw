import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectPaymentReminders,
  type BankAccountResponse as BankAccountRow,
  type CreditCardBillResponse as CreditCardBillRow,
  type PaymentReminder,
} from "@taiwan-fin-hub/shared";
import {
  scheduledSummaryNotification,
  type SyncNotificationEvent,
} from "../../../src/features/notifications/payload";
import {
  collectMaturityReminders,
  type MaturingTimeDepositRow,
} from "../../../src/features/notifications/deposit-maturity";
import {
  safelyLoadMaturityReminders,
  safelyLoadPaymentReminders,
} from "../../../src/features/notifications/service";
import { persistStagedSyncWrite } from "../../../src/features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  creditCardBillRecord,
} from "../../../src/features/sync/record-mapper";
import { createTestD1 } from "../../helpers/d1";

// 台北時間 2026-10-21 01:00；UTC 仍是 10-20。
const now = new Date("2026-10-20T17:00:00Z");
const freshAsOf = "2026-10-20T15:00:00Z";

function card(
  input: Partial<BankAccountRow> & Pick<BankAccountRow, "id">,
): BankAccountRow {
  return {
    connectorId: "cathaybk",
    sourceId: input.id,
    institutionName: "國泰世華",
    accountType: "credit",
    currency: "TWD",
    balance: -12_800,
    asOfAt: freshAsOf,
    ...input,
  };
}

function bill(
  input: Partial<CreditCardBillRow> & Pick<CreditCardBillRow, "accountId">,
): CreditCardBillRow {
  return {
    id: `${input.accountId}-${input.billingPeriod ?? "2026-09"}`,
    connectorId: "cathaybk",
    sourceId: "bill",
    billingPeriod: "2026-09",
    statementAmount: 12_800,
    paidAmount: 0,
    isPaid: 0,
    paymentDueDate: "2026-10-23",
    currency: "TWD",
    ...input,
  };
}

describe("collectPaymentReminders", () => {
  it("已繳、溢繳與已繳足的帳單不提醒，待繳金額扣除已繳部分", () => {
    const { reminders } = collectPaymentReminders(
      [
        card({ id: "paid" }),
        card({ id: "overpaid", balance: 300 }),
        card({ id: "paid-amount" }),
        card({ id: "partial" }),
      ],
      [
        bill({ accountId: "paid", isPaid: 1 }),
        bill({ accountId: "overpaid" }),
        bill({ accountId: "paid-amount", paidAmount: 12_800 }),
        bill({ accountId: "partial", paidAmount: 2_800 }),
      ],
      now,
    );

    expect(reminders).toEqual([
      expect.objectContaining({
        accountId: "partial",
        amount: 10_000,
        daysUntilDue: 2,
        state: "due",
      }),
    ]);
  });

  it("繳款狀態未知或資料過舊時只提示請確認，不當成已繳", () => {
    const { reminders } = collectPaymentReminders(
      [
        card({ id: "unknown" }),
        card({ id: "stale", asOfAt: "2026-10-17T00:00:00Z" }),
      ],
      [
        bill({ accountId: "unknown", isPaid: null }),
        bill({ accountId: "stale" }),
      ],
      now,
    );

    expect(reminders.map((item) => [item.accountId, item.state])).toEqual([
      ["unknown", "confirm"],
      ["stale", "confirm"],
    ]);
  });

  it("以台北日期計算 5 天內到期，並只採用同一期限的帳單狀態", () => {
    const { reminders } = collectPaymentReminders(
      [
        card({ id: "day-5", paymentDueDate: "2026-10-26" }),
        card({ id: "day-6", paymentDueDate: "2026-10-27" }),
        card({ id: "new-cycle", paymentDueDate: "2026-10-24" }),
      ],
      [
        bill({ accountId: "day-5", paymentDueDate: "2026-10-26" }),
        bill({ accountId: "day-6", paymentDueDate: "2026-10-27" }),
        // 上一期已繳，本期帳單尚未同步：不能沿用上一期的已繳狀態。
        bill({
          accountId: "new-cycle",
          billingPeriod: "2026-08",
          isPaid: 1,
          paymentDueDate: "2026-09-24",
        }),
      ],
      now,
    );

    expect(
      reminders.map((item) => [item.accountId, item.daysUntilDue, item.state]),
    ).toEqual([
      ["day-5", 5, "due"],
      ["new-cycle", 3, "confirm"],
    ]);
  });

  it("貸款扣款未完成時即使沒有期限也優先提醒", () => {
    const { reminders } = collectPaymentReminders(
      [
        card({ id: "card" }),
        {
          id: "loan",
          connectorId: "cathaybk",
          sourceId: "loan",
          institutionName: "國泰世華",
          accountType: "loan",
          loanCategory: "housing",
          currency: "TWD",
          balance: -3_000_000,
          loanPaymentAmount: 25_000,
          loanPaymentStatus: "collection_incomplete",
          asOfAt: freshAsOf,
        },
      ],
      [bill({ accountId: "card" })],
      now,
    );

    expect(reminders[0]).toEqual(
      expect.objectContaining({
        accountId: "loan",
        name: "國泰世華房貸",
        amount: 25_000,
        state: "collection_failed",
      }),
    );
  });

  describe("扣款帳戶", () => {
    const deposit = (input: Partial<BankAccountRow> = {}): BankAccountRow => ({
      id: "deposit",
      connectorId: "taishin",
      sourceId: "deposit",
      institutionName: "台新銀行",
      accountName: "末五碼 12345",
      accountType: "savings",
      currency: "TWD",
      balance: 50_000,
      availableBalance: 40_000,
      asOfAt: freshAsOf,
      ...input,
    });
    const paidFromDeposit = {
      paymentAccountId: "deposit",
      paymentAccountSource: "manual" as const,
    };
    const loan = (input: Partial<BankAccountRow> = {}): BankAccountRow => ({
      id: "loan",
      connectorId: "cathaybk",
      sourceId: "loan",
      institutionName: "國泰世華",
      accountType: "loan",
      loanCategory: "housing",
      currency: "TWD",
      balance: -3_000_000,
      loanPaymentAmount: 25_000,
      paymentDueDate: "2026-10-24",
      loanPaymentStatus: "scheduled",
      asOfAt: freshAsOf,
      ...paidFromDeposit,
      ...input,
    });
    const run = (payer: BankAccountRow, loanInput = {}) =>
      collectPaymentReminders(
        [card({ id: "card", ...paidFromDeposit }), loan(loanInput), payer],
        [bill({ accountId: "card" })],
        now,
      );

    it("同一扣款帳戶的款項加總後以可用餘額判斷：夠扣隱藏，不夠扣標示差額", () => {
      // 信用卡 12,800 + 房貸 25,000 = 37,800。
      const enough = run(deposit({ availableBalance: 40_000 }));
      expect(enough.reminders).toEqual([]);
      expect(enough.covered.map((item) => item.accountId)).toEqual([
        "card",
        "loan",
      ]);

      // 帳戶餘額 50,000 足夠，但可用餘額 37,000 不足，應以可用餘額判斷。
      const short = run(deposit({ availableBalance: 37_000 }));
      expect(short.covered).toEqual([]);
      expect(
        short.reminders.map(
          ({ accountId, state, shortfall, paymentAccount }) => ({
            accountId,
            state,
            shortfall,
            paymentAccount: paymentAccount?.name,
          }),
        ),
      ).toEqual([
        {
          accountId: "card",
          state: "insufficient_funds",
          shortfall: 800,
          paymentAccount: "台新銀行 末五碼 12345",
        },
        {
          accountId: "loan",
          state: "insufficient_funds",
          shortfall: 800,
          paymentAccount: "台新銀行 末五碼 12345",
        },
      ]);
    });

    it("扣款帳戶資料過舊、金額未知或幣別不同時不判斷，維持原提醒", () => {
      for (const result of [
        run(deposit({ asOfAt: "2026-10-17T00:00:00Z" })),
        run(deposit({ currency: "USD" })),
        run(deposit(), { loanPaymentAmount: undefined }),
      ]) {
        expect(result.covered).toEqual([]);
        expect(
          result.reminders.map((item) => [item.accountId, item.state]),
        ).toEqual([
          ["card", "due"],
          ["loan", "confirm"],
        ]);
      }
    });

    it("外幣帳單由台幣帳戶扣款時，依匯率加換匯緩衝換算後判斷；沒有匯率時不判斷", () => {
      const runJpy = (
        availableBalance: number,
        rates: Record<string, number> = { JPY: 0.21 },
      ) =>
        collectPaymentReminders(
          [
            card({
              id: "jpy",
              currency: "JPY",
              balance: -30_000,
              ...paidFromDeposit,
            }),
            deposit({ availableBalance }),
          ],
          [
            bill({
              accountId: "jpy",
              currency: "JPY",
              statementAmount: 30_000,
            }),
          ],
          now,
          rates,
        );

      // JP¥30,000 × 0.21 × 1.02 = NT$6,426。
      expect(runJpy(7_000).covered.map((item) => item.accountId)).toEqual([
        "jpy",
      ]);
      expect(runJpy(6_000).reminders).toEqual([
        expect.objectContaining({
          accountId: "jpy",
          currency: "JPY",
          state: "insufficient_funds",
          shortfall: 426,
          paymentAccount: expect.objectContaining({ currency: "TWD" }),
        }),
      ]);
      const noRate = runJpy(7_000, {});
      expect(noRate.covered).toEqual([]);
      expect(noRate.reminders.map((item) => item.state)).toEqual(["due"]);
    });
  });
});

describe("scheduledSummaryNotification", () => {
  const preferences = {
    success: false,
    failed: true,
    needsUserAction: true,
    paymentDue: true,
  };
  const succeeded: SyncNotificationEvent[] = [
    { connectorId: "cathaybk", status: "success" },
  ];
  const reminder = (
    input: Partial<PaymentReminder> & Pick<PaymentReminder, "accountId">,
  ): PaymentReminder => ({
    connectorId: "cathaybk",
    kind: "card",
    name: "國泰世華信用卡",
    amount: 12_800,
    currency: "TWD",
    daysUntilDue: 3,
    state: "due",
    ...input,
  });

  it("繳款提醒附在同一則同步摘要，只寫機構與天數、不含金額", () => {
    const payload = scheduledSummaryNotification(
      { ...preferences, success: true },
      succeeded,
      [
        reminder({ accountId: "a", daysUntilDue: 1 }),
        reminder({ accountId: "b", name: "台北富邦信用卡", amount: 5_300 }),
      ],
    );

    expect(payload).toEqual({
      title: "同步完成，2 筆繳款即將到期",
      body: "國泰世華信用卡明天到期、台北富邦信用卡 3 天後到期。",
      url: "/#/overview",
      tag: "sync-default-schedule-success",
    });

    const failed = scheduledSummaryNotification(
      preferences,
      [...succeeded, { connectorId: "fubon", status: "failed" }],
      [reminder({ accountId: "a", state: "collection_failed" })],
    );
    expect(failed?.body).toBe(
      "預設排程同步完成：成功 1、失敗 1。另有 1 筆繳款需要留意：國泰世華信用卡扣款未完成。",
    );
    for (const text of [payload!.body, failed!.body])
      expect(text).not.toMatch(/NT\$|12,800|5,300|12800|5300/);
  });

  it("成功通知關閉時，只有緊急的繳款才讓同步摘要照常送出", () => {
    expect(
      scheduledSummaryNotification(preferences, succeeded, [
        reminder({ accountId: "a", daysUntilDue: 2 }),
      ]),
    ).toBeNull();

    for (const urgent of [
      reminder({ accountId: "a", daysUntilDue: 1 }),
      reminder({ accountId: "a", daysUntilDue: 0, state: "confirm" }),
      reminder({ accountId: "a", daysUntilDue: -1, state: "overdue" }),
      reminder({
        accountId: "a",
        kind: "loan",
        daysUntilDue: undefined,
        state: "collection_failed",
      }),
    ])
      expect(
        scheduledSummaryNotification(preferences, succeeded, [urgent]),
      ).not.toBeNull();
  });

  it("關閉繳款提醒時維持原本的同步推播", () => {
    const off = { ...preferences, paymentDue: false };
    const urgent = [reminder({ accountId: "a", daysUntilDue: 0 })];

    expect(scheduledSummaryNotification(off, succeeded, urgent)).toBeNull();
    expect(
      scheduledSummaryNotification(
        off,
        [{ connectorId: "fubon", status: "failed" }],
        urgent,
      )?.body,
    ).toBe("預設排程同步完成：失敗 1。");
  });

  it("同步狀態通知關閉時，緊急繳款只送繳款內容，不帶出該同步狀態", () => {
    const urgent = [reminder({ accountId: "a", daysUntilDue: 1 })];
    for (const [status, key] of [
      ["failed", "failed"],
      ["needs_user_action", "needsUserAction"],
    ] as const) {
      const payload = scheduledSummaryNotification(
        { ...preferences, [key]: false },
        [{ connectorId: "fubon", status }],
        urgent,
      );
      expect(payload).toEqual({
        title: "1 筆繳款即將到期",
        body: "國泰世華信用卡明天到期。",
        url: "/#/overview",
        tag: "sync-default-schedule-payment-due",
      });
    }
  });

  it("扣款帳戶餘額不足時照樣推播，只寫機構名稱、不含帳號末碼與差額", () => {
    const payload = scheduledSummaryNotification(preferences, succeeded, [
      reminder({
        accountId: "a",
        state: "insufficient_funds",
        paymentAccount: {
          id: "deposit",
          name: "台新銀行 末五碼 12345",
          institution: "台新銀行",
          currency: "TWD",
        },
        shortfall: 800,
      }),
    ]);
    expect(payload).toEqual({
      title: "同步完成，1 筆繳款需要留意",
      body: "台新銀行帳戶餘額可能不足以扣繳國泰世華信用卡。",
      url: "/#/overview",
      tag: "sync-default-schedule-success",
    });
    expect(payload!.body).not.toMatch(/12345|800|NT\$/);
  });

  it("狀態未確定時，推播提示請確認，不寫成確定未繳", () => {
    const payload = scheduledSummaryNotification(preferences, succeeded, [
      reminder({
        accountId: "a",
        name: "台北富邦信用卡",
        daysUntilDue: 1,
        state: "confirm",
      }),
      reminder({
        accountId: "b",
        kind: "loan",
        name: "國泰世華房貸",
        daysUntilDue: 0,
        state: "confirm",
      }),
    ]);
    expect(payload?.body).toBe(
      "台北富邦信用卡明天到期（請確認是否已繳）、國泰世華房貸今天扣款（請確認餘額）。",
    );
  });

  it("定存今天到期時，成功通知關閉也照常送出，只寫機構與筆數", () => {
    const maturities = [
      { institution: "王道銀行", count: 2 },
      { institution: "將來銀行", count: 1 },
    ];
    expect(
      scheduledSummaryNotification(preferences, succeeded, [], maturities),
    ).toEqual({
      title: "同步完成，3 筆定存今天到期",
      body: "王道銀行 2 筆定存今天到期、將來銀行定存今天到期。",
      url: "/#/overview",
      tag: "sync-default-schedule-success",
    });

    const combined = scheduledSummaryNotification(
      preferences,
      [{ connectorId: "fubon", status: "failed" }],
      [reminder({ accountId: "a", daysUntilDue: 1 })],
      maturities.slice(0, 1),
    );
    expect(combined?.body).toBe(
      "預設排程同步完成：失敗 1。另有 1 筆繳款即將到期、2 筆定存今天到期：國泰世華信用卡明天到期。王道銀行 2 筆定存今天到期。",
    );

    expect(
      scheduledSummaryNotification(
        { ...preferences, paymentDue: false },
        succeeded,
        [],
        maturities,
      ),
    ).toBeNull();
  });

  it("批次成員都被略過時，只有緊急提醒送出，且不寫成同步完成", () => {
    const all = { ...preferences, success: true };
    const maturities = [{ institution: "王道銀行", count: 1 }];
    expect(scheduledSummaryNotification(all, [], [], maturities)).toEqual({
      title: "1 筆定存今天到期",
      body: "王道銀行定存今天到期。",
      url: "/#/overview",
      tag: "sync-default-schedule-payment-due",
    });
    expect(
      scheduledSummaryNotification(
        all,
        [],
        [reminder({ accountId: "a", daysUntilDue: 3 })],
      ),
    ).toBeNull();
    expect(scheduledSummaryNotification(all, [], [])).toBeNull();
  });
});

describe("collectMaturityReminders", () => {
  const deposit = (
    input: Partial<MaturingTimeDepositRow> & Pick<MaturingTimeDepositRow, "id">,
  ): MaturingTimeDepositRow => ({
    institutionName: "王道銀行",
    maturityDate: "2026-10-21",
    inactiveAt: null,
    ...input,
  });

  it("只提醒台北日期今天到期；到期當天才失效仍提醒，提前解約不提醒", () => {
    const reminders = collectMaturityReminders(
      [
        deposit({ id: "today-a" }),
        deposit({ id: "today-b" }),
        // 台北 10-21 00:30 同步時已解約入帳。
        deposit({
          id: "settled-today",
          institutionName: "將來銀行",
          inactiveAt: "2026-10-20T16:30:00Z",
        }),
        deposit({
          id: "closed-early",
          institutionName: "聯邦銀行",
          inactiveAt: "2026-10-19T03:00:00Z",
        }),
        deposit({ id: "tomorrow", maturityDate: "2026-10-22" }),
        deposit({ id: "yesterday", maturityDate: "2026-10-20" }),
      ],
      now,
    );

    expect(reminders).toEqual([
      { institution: "將來銀行", count: 1 },
      { institution: "王道銀行", count: 2 },
    ]);
  });
});

describe("推播讀取繳款提醒（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("匯率讀取失敗時照常產生提醒，不因匯率而讓推播少掉繳款提醒", async () => {
    const db = harness.binding;
    const accountId = "credit:cathaybk:TWD";
    const card = bankAccountRecord(
      "cathaybk",
      {
        sourceId: accountId,
        institutionName: "國泰世華",
        accountType: "credit",
        currency: "TWD",
      },
      freshAsOf,
    );
    await persistStagedSyncWrite(db, {
      records: [
        card,
        bankBalanceSnapshotRecord(
          "cathaybk",
          {
            accountId,
            sourceId: "snapshot",
            balance: -12_800,
            currency: "TWD",
            asOfAt: freshAsOf,
          },
          freshAsOf,
        ),
        creditCardBillRecord(
          "cathaybk",
          {
            accountId,
            sourceId: "bill",
            billingPeriod: "2026-09",
            statementAmount: 12_800,
            paidAmount: 0,
            isPaid: false,
            paymentDueDate: "2026-10-23",
            currency: "TWD",
          },
          freshAsOf,
        ),
      ],
    });
    await db.prepare("DROP TABLE exchange_rates").run();

    const reminders = await safelyLoadPaymentReminders(db, now);
    expect(reminders.map((item) => [item.accountId, item.state])).toEqual([
      [card.recordKey, "due"],
    ]);
  });

  it("定存提醒包含到期當天才失效的帳戶，排除其他帳戶類型", async () => {
    const db = harness.binding;
    await persistStagedSyncWrite(db, {
      records: [
        bankAccountRecord(
          "obank",
          {
            sourceId: "td-today",
            institutionName: "王道銀行",
            accountType: "time_deposit",
            currency: "TWD",
            maturityDate: "2026-10-21",
            inactiveAt: "2026-10-20T16:30:00Z",
          },
          freshAsOf,
        ),
        bankAccountRecord(
          "obank",
          {
            sourceId: "td-tomorrow",
            institutionName: "王道銀行",
            accountType: "time_deposit",
            currency: "TWD",
            maturityDate: "2026-10-22",
          },
          freshAsOf,
        ),
        bankAccountRecord(
          "obank",
          {
            sourceId: "loan",
            institutionName: "王道銀行",
            accountType: "loan",
            currency: "TWD",
            maturityDate: "2026-10-21",
          },
          freshAsOf,
        ),
      ],
    });

    expect(await safelyLoadMaturityReminders(db, now)).toEqual([
      { institution: "王道銀行", count: 1 },
    ]);
  });
});
