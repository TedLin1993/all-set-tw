import type { SourceSyncError, SourceSyncErrorSource } from "../sync-error";
import type {
  AutopayAccountHint,
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "../financial-types";
import { creditCardLiabilityBalance } from "../credit-card-liability";
import { TAIWAN_BANK_NAMES } from "../taiwan-banks";
import forge from "node-forge";
import { z } from "zod";

/** 聯邦銀行 New New Bank 行動 API 設定。所有欄位皆由 Worker 加密保存。 */
export const ubotConfigSchema = z.object({
  userId: z.string().min(1).max(32).optional(),
  account: z.string().min(1).max(128).optional(),
  password: z.string().min(1).max(128).optional(),
  deviceUuid: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
});

export type UbotConfig = z.infer<typeof ubotConfigSchema>;

export function parseUbotConfig(config: unknown): UbotConfig {
  return ubotConfigSchema.parse(config);
}

export class UbotProtocolError extends Error implements SourceSyncErrorSource {
  constructor(message = "聯邦 New New Bank 回應格式已變更，暫時無法同步。") {
    super(message);
    this.name = "UbotProtocolError";
  }

  toSyncError(): SourceSyncError {
    return { status: 502, code: "UBOT_CONNECTION_FAILED" };
  }
}

export type UbotFxTransactionPayload = {
  accountNumber: string;
  currency: string;
  payload: unknown;
};

export type UbotDepositPayloads = {
  twdSummary: unknown;
  twdTransactions?: unknown[];
  twdTimeDeposit?: unknown;
  fxSummary?: unknown;
  fxTransactions?: UbotFxTransactionPayload[];
  fxTimeDeposit?: unknown;
};

export type UbotStatementPayload = {
  period: string;
  payload: unknown;
};

export type UbotCreditCardPayloads = {
  cardList: unknown;
  summary?: unknown;
  unbilled?: unknown;
  statementHeaders?: unknown;
  statements?: UbotStatementPayload[];
  realtimeAuth?: unknown;
  autopay?: unknown;
};

export type UbotParsedData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

type JsonRecord = Record<string, unknown>;

const UBOT_INSTITUTION_NAME = "聯邦銀行";
const UBOT_BANK_CODE = "803";
const CREDIT_ACCOUNT_SOURCE_ID = "credit:ubot:TWD";
const NO_PRIMARY_CARD_CODES = new Set(["0021", "0023", "F101", "F102", "F103"]);

/** 將全形英數與標點轉為半形並去除首尾空白。 */
export function normalizeHalfWidth(value: string): string {
  return value
    .replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/\u3000/g, " ")
    .trim();
}

/**
 * 聯邦 New New Bank 登入 `sid` 規格：半形大寫身分證字號，尾端若無 `A` 則補 `"A"`
 * （例如 `"A123456789"` → `"A123456789A"`）。
 */
export function formatUbotSid(userId: string): string {
  const normalized = normalizeHalfWidth(userId).toUpperCase();
  if (!normalized) return "";
  return normalized.endsWith("A") ? normalized : `${normalized}A`;
}

/**
 * 聯邦 New New Bank `NNBI010101` 要求 `deviceUuid` 為 64 碼 hex 字串。
 * 以固定鹽值與正規化 `sid` 衍生穩定雜湊，避免每次產生隨機字串。
 */
export function deriveUbotDeviceUuid(userId: string): string {
  return forge.md.sha256
    .create()
    .update(`tfh-ubot-${formatUbotSid(userId)}`, "utf8")
    .digest()
    .toHex();
}

/**
 * 使用 `NNBCM000007` 回傳的 RSA-2048 PublicKey (PKCS#1 Base64) 加密使用者密碼。
 */
export function encryptUbotPassword(
  password: string,
  publicKeyBase64: string,
): string {
  const normalizedPassword = normalizeHalfWidth(password);
  const cleanKey = publicKeyBase64.replace(/\s+/g, "");
  if (!cleanKey) {
    throw new UbotProtocolError(
      "聯邦 New New Bank 登入公鑰格式已變更，暫時無法同步。",
    );
  }
  let publicKey: forge.pki.rsa.PublicKey;
  try {
    publicKey = forge.pki.publicKeyFromPem(
      `-----BEGIN RSA PUBLIC KEY-----\n${cleanKey}\n-----END RSA PUBLIC KEY-----`,
    );
  } catch {
    try {
      publicKey = forge.pki.publicKeyFromPem(
        `-----BEGIN PUBLIC KEY-----\n${cleanKey}\n-----END PUBLIC KEY-----`,
      );
    } catch {
      throw new UbotProtocolError(
        "聯邦 New New Bank 登入公鑰格式已變更，暫時無法同步。",
      );
    }
  }
  return forge.util.encode64(
    publicKey.encrypt(
      forge.util.encodeUtf8(normalizedPassword),
      "RSAES-PKCS1-V1_5",
    ),
  );
}

/**
 * 實作 New New Bank SPA `reqec` 請求加密：
 * - `p1`：將 `JSON.stringify(sendData)` 的 UTF-8 bytes 補上 PKCS#7 padding 後，
 *   以 `k2`（Base64 解碼後的 16-byte AES key）與 16 碼數字 `iv` 執行 `AES-128-OFB` 加密並轉為 Base64。
 * - `p2`：以 `k1`（X.509 SPKI RSA-1024 公鑰）將 `iv` 執行 `RSAES-PKCS1-V1_5` 加密並轉為 Base64。
 */
export function encryptUbotRequest(
  sendData: Record<string, unknown>,
  k1Base64: string,
  k2Base64: string,
  iv = randomDigitString(16),
): { p1: string; p2: string } {
  if (!/^\d{16}$/.test(iv)) {
    throw new Error("UBOT request IV must be 16 digits.");
  }
  const cleanK1 = k1Base64.replace(/\s+/g, "");
  const cleanK2 = k2Base64.replace(/\s+/g, "");
  if (!cleanK1 || !cleanK2) {
    throw new UbotProtocolError(
      "聯邦 New New Bank 請求加密金鑰格式已變更，暫時無法同步。",
    );
  }

  let k1PublicKey: forge.pki.rsa.PublicKey;
  try {
    k1PublicKey = forge.pki.publicKeyFromPem(
      `-----BEGIN PUBLIC KEY-----\n${cleanK1}\n-----END PUBLIC KEY-----`,
    );
  } catch {
    throw new UbotProtocolError(
      "聯邦 New New Bank 請求加密金鑰格式已變更，暫時無法同步。",
    );
  }

  const aesKeyBytes = forge.util.decode64(cleanK2);
  if (
    aesKeyBytes.length !== 16 &&
    aesKeyBytes.length !== 24 &&
    aesKeyBytes.length !== 32
  ) {
    throw new UbotProtocolError(
      "聯邦 New New Bank 請求加密金鑰長度已變更，暫時無法同步。",
    );
  }

  // CryptoJS.AES.encrypt(..., { mode: OFB, padding: Pkcs7 }) 會在進入 OFB 前先補 16-byte PKCS#7 padding。
  const utf8Payload = forge.util.encodeUtf8(JSON.stringify(sendData));
  const padLen = 16 - (utf8Payload.length % 16);
  const paddedPayload =
    utf8Payload + String.fromCharCode(padLen).repeat(padLen);

  const cipher = forge.cipher.createCipher("AES-OFB", aesKeyBytes);
  cipher.start({ iv });
  cipher.update(forge.util.createBuffer(paddedPayload, "raw"));
  cipher.finish();

  const p1 = forge.util.encode64(cipher.output.getBytes());
  const p2 = forge.util.encode64(
    k1PublicKey.encrypt(forge.util.encodeUtf8(iv), "RSAES-PKCS1-V1_5"),
  );
  return { p1, p2 };
}

/** 產生聯邦活存帳戶穩定 `sourceId`，不含完整帳號。 */
export function ubotDepositSourceId(
  accountNumber: string,
  currency = "TWD",
): string {
  const digits = normalizeHalfWidth(accountNumber).replace(/\D/g, "");
  const last4 = digits.slice(-4) || "unknown";
  const normalizedCurrency = currency.trim().toUpperCase() || "TWD";
  return `bank:ubot:${last4}:${stableHash(`ubot:${digits}`)}:${normalizedCurrency}`;
}

/** 產生聯邦定存存單穩定 `sourceId`，不含完整帳號。 */
export function ubotTimeDepositSourceId(
  accountNumber: string,
  slipNumber: string,
  currency = "TWD",
): string {
  const digits = normalizeHalfWidth(accountNumber).replace(/\D/g, "");
  const last4 = digits.slice(-4) || "unknown";
  const normalizedSlip = normalizeHalfWidth(slipNumber);
  const normalizedCurrency = currency.trim().toUpperCase() || "TWD";
  return `bank:ubot:${last4}:${stableHash(`ubot:td:${digits}:${normalizedSlip}`)}:${normalizedCurrency}`;
}

/** 剖析臺外幣活存、定存與交易明細。 */
export function parseUbotDepositData(
  payloads: UbotDepositPayloads,
  now = new Date(),
): Omit<UbotParsedData, "creditCardBills"> {
  const asOfAt = now.toISOString();
  const bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">> = [];
  const bankBalanceSnapshots: Array<
    Omit<BankBalanceSnapshot, "id" | "connectorId">
  > = [];
  const bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">> =
    [];

  const twdSummary = resBodyRecord(payloads.twdSummary);
  const twdAccountNumber = normalizeHalfWidth(
    stringValue(twdSummary.Account),
  ).replace(/\D/g, "");
  const twdBalance = numberValue(twdSummary.AccountBal);
  if (!twdAccountNumber || twdBalance == null) {
    throw new UbotProtocolError();
  }
  const twdAvailableBalance =
    numberValue(twdSummary.AvailableBal) ?? twdBalance;
  const twdLast4 = twdAccountNumber.slice(-4);
  const twdSourceId = ubotDepositSourceId(twdAccountNumber, "TWD");

  bankAccounts.push({
    sourceId: twdSourceId,
    institutionName: UBOT_INSTITUTION_NAME,
    accountName: twdLast4
      ? `New New Bank 數位帳戶 · 末四碼 ${twdLast4}`
      : "New New Bank 數位帳戶",
    accountType: "savings",
    currency: "TWD",
    raw: {
      accountLast4: twdLast4,
      freeTransferTimes: numberValue(twdSummary.FreeTranTimes),
      freeWithdrawalTimes: numberValue(twdSummary.FreeGetTimes),
      state: optionalString(twdSummary.state),
    },
  });

  bankBalanceSnapshots.push({
    accountId: twdSourceId,
    sourceId: `${twdSourceId}:${asOfAt}`,
    balance: twdBalance,
    availableBalance: twdAvailableBalance,
    currency: "TWD",
    asOfAt,
    raw: {
      accountLast4: twdLast4,
      availableBalance: twdAvailableBalance,
    },
  });

  if (Array.isArray(payloads.twdTransactions)) {
    bankTransactions.push(
      ...parseTwdTransactions(
        payloads.twdTransactions,
        twdSourceId,
        twdAccountNumber,
      ),
    );
  }

  // 臺幣定存 (NNBN030101)
  if (payloads.twdTimeDeposit !== undefined) {
    const tdBody = resBodyRecord(payloads.twdTimeDeposit);
    const toAccount =
      normalizeHalfWidth(stringValue(tdBody.ToAccount)).replace(/\D/g, "") ||
      twdAccountNumber;
    const ctList = Array.isArray(tdBody.CtList) ? tdBody.CtList : [];
    for (const item of ctList) {
      if (!isRecord(item)) continue;
      const slipNo = optionalString(item.CtIdNo);
      const amount = numberValue(item.CtAmt);
      if (!slipNo || amount == null || amount <= 0) continue;
      const tdSourceId = ubotTimeDepositSourceId(toAccount, slipNo, "TWD");
      const last4 = toAccount.slice(-4);
      const ctType = optionalString(item.CtType) ?? "臺幣定期存款";
      const openedDate = normalizeUbotDate(item.CtStartDate);
      const maturityDate = normalizeUbotDate(item.CtEndDate);
      const ratePct = numberValue(item.CtRate);
      const period = optionalString(item.Period);
      const rateType = optionalString(item.Rtype);

      bankAccounts.push({
        sourceId: tdSourceId,
        institutionName: UBOT_INSTITUTION_NAME,
        accountName: `${ctType} (${slipNo})`,
        accountType: "time_deposit",
        currency: "TWD",
        ...(openedDate ? { openedDate } : {}),
        ...(maturityDate ? { maturityDate } : {}),
        raw: {
          accountLast4: last4,
          slipNo,
          depositType: ctType,
          period,
          rateType,
          annualRatePct: ratePct,
        },
      });

      bankBalanceSnapshots.push({
        accountId: tdSourceId,
        sourceId: `${tdSourceId}:${asOfAt}`,
        balance: amount,
        availableBalance: amount,
        currency: "TWD",
        asOfAt,
        raw: {
          accountLast4: last4,
          slipNo,
          annualRatePct: ratePct,
        },
      });
    }
  }

  // 外幣活存 (NNBF010201 & NNBF050201)
  const fxSourceIdByAccountCurrency = new Map<string, string>();
  if (payloads.fxSummary !== undefined) {
    const fxBody = resBodyRecord(payloads.fxSummary);
    const fxAccountNumber = normalizeHalfWidth(
      stringValue(fxBody.Account),
    ).replace(/\D/g, "");
    const ftList = Array.isArray(fxBody.FTList) ? fxBody.FTList : [];
    for (const item of ftList) {
      if (!isRecord(item)) continue;
      const currency = stringValue(item.CurrencyEnglish).trim().toUpperCase();
      const balance = numberValue(item.Balance);
      if (!/^[A-Z]{3}$/.test(currency) || balance == null) continue;
      const accountNo = fxAccountNumber || twdAccountNumber;
      const last4 = accountNo.slice(-4);
      const fxSourceId = ubotDepositSourceId(accountNo, currency);
      fxSourceIdByAccountCurrency.set(`${accountNo}:${currency}`, fxSourceId);

      bankAccounts.push({
        sourceId: fxSourceId,
        institutionName: UBOT_INSTITUTION_NAME,
        accountName: last4
          ? `New New Bank 外幣帳戶 (${currency}) · 末四碼 ${last4}`
          : `New New Bank 外幣帳戶 (${currency})`,
        accountType: "savings",
        currency,
        raw: {
          accountLast4: last4,
          currency,
          currencyCode: optionalString(item.CurrencyNum),
          currencyName: optionalString(item.CurrencyChinese),
        },
      });

      bankBalanceSnapshots.push({
        accountId: fxSourceId,
        sourceId: `${fxSourceId}:${asOfAt}`,
        balance,
        availableBalance: balance,
        currency,
        asOfAt,
        raw: {
          accountLast4: last4,
          currency,
          ntdEquivalent: numberValue(item.NTBalance),
        },
      });
    }
  }

  if (Array.isArray(payloads.fxTransactions)) {
    bankTransactions.push(
      ...parseFxTransactions(
        payloads.fxTransactions,
        fxSourceIdByAccountCurrency,
      ),
    );
  }

  // 外幣定存 (NNBF020301)
  if (payloads.fxTimeDeposit !== undefined) {
    const fxTdBody = resBodyRecord(payloads.fxTimeDeposit);
    const toAccount =
      normalizeHalfWidth(stringValue(fxTdBody.ToAccount)).replace(/\D/g, "") ||
      twdAccountNumber;
    const fctList = Array.isArray(fxTdBody.FCTList) ? fxTdBody.FCTList : [];
    for (const item of fctList) {
      if (!isRecord(item)) continue;
      const slipNo = optionalString(item.VchrNo);
      const currency = stringValue(item.Currency).trim().toUpperCase();
      const amount = numberValue(item.Amt);
      if (
        !slipNo ||
        !/^[A-Z]{3}$/.test(currency) ||
        amount == null ||
        amount <= 0
      ) {
        continue;
      }
      const tdSourceId = ubotTimeDepositSourceId(toAccount, slipNo, currency);
      const last4 = toAccount.slice(-4);
      const openedDate = normalizeUbotDate(item.IntDate);
      const maturityDate = normalizeUbotDate(item.ExpDate);
      const ratePct = numberValue(item.IntRate);
      const period = optionalString(item.Period);

      bankAccounts.push({
        sourceId: tdSourceId,
        institutionName: UBOT_INSTITUTION_NAME,
        accountName: `外幣定期存款 (${currency} ${slipNo})`,
        accountType: "time_deposit",
        currency,
        ...(openedDate ? { openedDate } : {}),
        ...(maturityDate ? { maturityDate } : {}),
        raw: {
          accountLast4: last4,
          slipNo,
          currency,
          period,
          annualRatePct: ratePct,
        },
      });

      bankBalanceSnapshots.push({
        accountId: tdSourceId,
        sourceId: `${tdSourceId}:${asOfAt}`,
        balance: amount,
        availableBalance: amount,
        currency,
        asOfAt,
        raw: {
          accountLast4: last4,
          slipNo,
          currency,
          annualRatePct: ratePct,
          ntdEquivalent: numberValue(item.NTAmt),
        },
      });
    }
  }

  return {
    bankAccounts: dedupeBySourceId(bankAccounts),
    bankBalanceSnapshots: dedupeBySourceId(bankBalanceSnapshots),
    bankTransactions: dedupeBySourceId(bankTransactions),
  };
}

/** 判斷 `NNBC010105` 回應是否代表使用者持有聯邦信用卡正卡。 */
export function hasUbotCreditCard(cardListPayload: unknown): boolean {
  const body = resBodyRecord(cardListPayload);
  const erCode1 = stringValue(body.ErCode_1).trim().toUpperCase();
  const erCode2 = stringValue(body.ErCode_2).trim().toUpperCase();
  if (erCode1 === "NSCRD" && NO_PRIMARY_CARD_CODES.has(erCode2)) {
    return false;
  }
  if (erCode1 && erCode1 !== "0000") {
    throw new UbotProtocolError();
  }
  return Array.isArray(body.CardTypeList) && body.CardTypeList.length > 0;
}

/** 剖析聯邦信用卡清單、帳務總覽、未出帳消費、近期帳單與即時消費授權。 */
export function parseUbotCreditCardData(
  payloads: UbotCreditCardPayloads,
  now = new Date(),
): UbotParsedData {
  if (!hasUbotCreditCard(payloads.cardList)) {
    return {
      bankAccounts: [],
      bankBalanceSnapshots: [],
      bankTransactions: [],
      creditCardBills: [],
    };
  }

  const asOfAt = now.toISOString();
  const cardBody = resBodyRecord(payloads.cardList);
  const rawCardList = Array.isArray(cardBody.CardTypeList)
    ? cardBody.CardTypeList
    : [];

  const cards: Array<{
    cardLast4: string;
    cardName?: string;
    cardSchema?: string;
    virtualCard?: string;
    activate?: string;
  }> = [];
  const namesByLast4 = new Map<string, Set<string>>();

  for (const item of rawCardList) {
    if (!isRecord(item)) continue;
    const cardLast4 = lastDigits(stringValue(item.CardNo), 4);
    if (!cardLast4) continue;
    const cardName = sanitizeCardText(item.CardName);
    cards.push({
      cardLast4,
      ...(cardName ? { cardName } : {}),
      cardSchema: optionalString(item.CardSchema),
      virtualCard: optionalString(item.VirtualCard),
      activate: optionalString(item.Activate),
    });
    if (cardName) {
      const set = namesByLast4.get(cardLast4) ?? new Set<string>();
      set.add(cardName);
      namesByLast4.set(cardLast4, set);
    }
  }

  const uniqueCardNameByLast4 = new Map<string, string>();
  for (const [last4, names] of namesByLast4.entries()) {
    if (names.size === 1) {
      uniqueCardNameByLast4.set(last4, Array.from(names)[0]!);
    }
  }

  const allDistinctCardNames = new Set(
    cards.map((c) => c.cardName).filter((n): n is string => Boolean(n)),
  );
  const accountName =
    allDistinctCardNames.size === 1
      ? Array.from(allDistinctCardNames)[0]!
      : "聯邦銀行信用卡";

  // 帳務總覽 (NNBC010101)
  const summaryBody = resBodyRecord(payloads.summary);
  const bill0 =
    Array.isArray(summaryBody.BillList) && isRecord(summaryBody.BillList[0])
      ? summaryBody.BillList[0]
      : undefined;

  const creditLimit = bill0 ? numberValue(bill0.CrLmt) : undefined;
  const availableCredit = bill0 ? numberValue(bill0.AvalCrLmt) : undefined;
  const currBal = bill0 ? numberValue(bill0.CurrBal) : undefined;
  const summaryPaidAmt = bill0 ? numberValue(bill0.CTDPayAmt) : undefined;
  const ctdPayAmt = summaryPaidAmt ?? 0;
  const unsettleAmt = bill0 ? numberValue(bill0.UnsettleAmt) : undefined;
  const hasBill = bill0
    ? stringValue(bill0.HasBill).trim().toUpperCase()
    : undefined;
  const paymentDueDate = bill0 ? normalizeUbotDate(bill0.DueDate) : undefined;
  const autopayAccount = resolveCreditCardAutopay(payloads.autopay);

  const statementRemaining =
    hasBill === "N"
      ? 0
      : currBal !== undefined
        ? currBal <= 0
          ? currBal
          : Math.max(currBal - ctdPayAmt, 0)
        : undefined;

  // 缺少帳單剩餘或未出帳總額時不建立負債快照，避免把未知金額當成 0。
  const liabilityBalance =
    statementRemaining !== undefined && unsettleAmt !== undefined
      ? creditCardLiabilityBalance(statementRemaining, unsettleAmt)
      : undefined;

  const bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">> = [
    {
      sourceId: CREDIT_ACCOUNT_SOURCE_ID,
      institutionName: UBOT_INSTITUTION_NAME,
      accountName,
      accountType: "credit",
      currency: "TWD",
      ...(creditLimit !== undefined ? { creditLimit } : {}),
      ...(autopayAccount !== undefined ? { autopayAccount } : {}),
      raw: {
        cards,
        cycleDay: bill0 ? numberValue(bill0.CycleDay) : undefined,
      },
    },
  ];

  const bankBalanceSnapshots: Array<
    Omit<BankBalanceSnapshot, "id" | "connectorId">
  > =
    liabilityBalance === undefined
      ? []
      : [
          {
            accountId: CREDIT_ACCOUNT_SOURCE_ID,
            sourceId: `${CREDIT_ACCOUNT_SOURCE_ID}:${asOfAt}`,
            balance: liabilityBalance,
            ...(availableCredit !== undefined
              ? { availableBalance: availableCredit }
              : {}),
            ...(currBal !== undefined && hasBill === "Y"
              ? { statementBalance: Math.max(currBal, 0) }
              : {}),
            ...(paymentDueDate ? { paymentDueDate } : {}),
            ...(statementRemaining !== undefined
              ? { noPaymentNeeded: statementRemaining <= 0 }
              : {}),
            currency: "TWD",
            asOfAt,
            raw: {
              currentBalance: currBal,
              paidAmount: ctdPayAmt,
              statementRemaining,
              unbilledTotal: unsettleAmt,
              availableCredit,
              hasBill,
            },
          },
        ];

  const creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">> = [];
  const bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">> =
    [];

  // 已出帳與未出帳共用 occurrence：相同 identity 的不同消費分屬兩個清單時仍取得不同 sourceId；
  // 只出現在未出帳的消費轉入帳單後（帳單先處理）沿用原本的 occurrence 與 sourceId。
  const postedOccurrences = new Map<string, number>();

  // 已出帳帳單與明細 (NNBC010104)
  if (Array.isArray(payloads.statements)) {
    for (const statement of payloads.statements) {
      const billingPeriod = normalizeBillingPeriod(statement.period);
      if (!billingPeriod) continue;
      const stmtBody = resBodyRecord(statement.payload);
      const header =
        Array.isArray(stmtBody.HeaderInfo) && isRecord(stmtBody.HeaderInfo[0])
          ? stmtBody.HeaderInfo[0]
          : undefined;

      if (header) {
        const stmtCurrBal = numberValue(header.CurrBal);
        if (stmtCurrBal !== undefined) {
          const stmtDueAmt = numberValue(header.DueAmt);
          const stmtPaidAmt = numberValue(header.CTDPayAmt);
          const stmtDueDate = normalizeUbotDate(header.DueDate);
          const stmtClosingDate = normalizeUbotDate(header.StmtDate);
          creditCardBills.push({
            accountId: CREDIT_ACCOUNT_SOURCE_ID,
            sourceId: `${CREDIT_ACCOUNT_SOURCE_ID}:bill:${billingPeriod}`,
            billingPeriod,
            statementAmount: Math.max(stmtCurrBal, 0),
            ...(stmtDueAmt !== undefined
              ? { minimumPayment: Math.max(stmtDueAmt, 0) }
              : {}),
            ...(stmtPaidAmt !== undefined
              ? { paidAmount: Math.max(stmtPaidAmt, 0) }
              : {}),
            isPaid:
              stmtCurrBal <= 0
                ? true
                : stmtPaidAmt !== undefined
                  ? stmtPaidAmt >= stmtCurrBal
                  : undefined,
            ...(stmtDueDate ? { paymentDueDate: stmtDueDate } : {}),
            ...(stmtClosingDate
              ? { statementClosingDate: stmtClosingDate }
              : {}),
            currency: "TWD",
            raw: {
              billingPeriod,
              currentBalance: stmtCurrBal,
              dueAmount: stmtDueAmt,
              paidAmount: stmtPaidAmt,
              previousBalance: numberValue(header.PrevBal),
            },
          });
        }
      }

      const billList = Array.isArray(stmtBody.BillList)
        ? stmtBody.BillList
        : [];
      for (const tx of billList) {
        if (!isRecord(tx)) continue;
        const txAmt = numberValue(tx.TxAmt);
        const effectiveDate = normalizeUbotDate(tx.EffectiveDate);
        const postedDate = normalizeUbotDate(tx.PostingDate) ?? effectiveDate;
        if (txAmt == null || !postedDate) continue;
        const amount = txAmt === 0 ? 0 : -txAmt;
        const cardLast4 = lastDigits(stringValue(tx.CardNo), 4) || undefined;
        const cardName = cardLast4
          ? uniqueCardNameByLast4.get(cardLast4)
          : undefined;
        const description = sanitizeCardText(tx.TxDesc) ?? "聯邦銀行信用卡交易";
        // 與未出帳明細共用 identity 與前綴，結帳後同一筆消費覆寫原列而不是多一筆。
        const identity = [
          cardLast4 ?? "account",
          effectiveDate ?? postedDate,
          postedDate,
          amount,
          description,
        ].join("|");
        const occurrence = (postedOccurrences.get(identity) ?? 0) + 1;
        postedOccurrences.set(identity, occurrence);

        bankTransactions.push({
          accountId: CREDIT_ACCOUNT_SOURCE_ID,
          sourceId: `ubot:card:tx:posted:${stableHash(`${identity}|${occurrence}`)}`,
          postedDate,
          ...(effectiveDate ? { authorizedAt: effectiveDate } : {}),
          amount,
          currency: "TWD",
          description,
          status: "posted",
          ...(cardLast4 ? { cardLast4 } : {}),
          ...(cardName ? { cardName } : {}),
          raw: {
            billingPeriod,
            ...(cardLast4 ? { cardLast4 } : {}),
            ...(cardName ? { cardName } : {}),
            effectiveDate,
            postingDate: postedDate,
            foreignCurrency: optionalString(tx.Currency),
            foreignAmount: numberValue(tx.OriAmt),
          },
        });
      }
    }
  }

  // 帳單明細未附表頭金額時，以帳務總覽的本期帳單補上最新一期，讓繳款提醒取得應繳金額。
  const latestPeriod = (payloads.statements ?? [])
    .map((statement) => normalizeBillingPeriod(statement.period))
    .filter((period): period is string => Boolean(period))
    .sort()
    .at(-1);
  if (
    latestPeriod &&
    hasBill === "Y" &&
    currBal !== undefined &&
    !creditCardBills.some((bill) => bill.billingPeriod === latestPeriod)
  ) {
    creditCardBills.push({
      accountId: CREDIT_ACCOUNT_SOURCE_ID,
      sourceId: `${CREDIT_ACCOUNT_SOURCE_ID}:bill:${latestPeriod}`,
      billingPeriod: latestPeriod,
      statementAmount: Math.max(currBal, 0),
      ...(summaryPaidAmt !== undefined
        ? { paidAmount: Math.max(summaryPaidAmt, 0) }
        : {}),
      isPaid:
        currBal <= 0
          ? true
          : summaryPaidAmt !== undefined
            ? summaryPaidAmt >= currBal
            : undefined,
      ...(paymentDueDate ? { paymentDueDate } : {}),
      currency: "TWD",
      raw: {
        billingPeriod: latestPeriod,
        source: "summary",
        currentBalance: currBal,
        paidAmount: summaryPaidAmt,
      },
    });
  }

  // 未出帳已請款明細 (NNBC010102)
  const unbilledBody = resBodyRecord(payloads.unbilled);
  const unbillList = Array.isArray(unbilledBody.UnbillList)
    ? unbilledBody.UnbillList
    : [];
  for (const tx of unbillList) {
    if (!isRecord(tx)) continue;
    const txCode = stringValue(tx.TxCode).trim();
    const rawEffDate = stringValue(tx.EffectiveDate).trim();
    // 跳過「查證中款項」小計列 (TxCode 05 / 07 或 EffectiveDate 99999999)
    if (txCode === "05" || txCode === "07" || rawEffDate === "99999999") {
      continue;
    }
    const txAmt = numberValue(tx.TxAmt);
    const effectiveDate = normalizeUbotDate(tx.EffectiveDate);
    const postedDate = normalizeUbotDate(tx.PostingDate) ?? effectiveDate;
    if (txAmt == null || !postedDate) continue;
    const amount = txAmt === 0 ? 0 : -txAmt;
    const cardLast4 = lastDigits(stringValue(tx.CardNo), 4) || undefined;
    const cardName = cardLast4
      ? uniqueCardNameByLast4.get(cardLast4)
      : undefined;
    const description =
      sanitizeCardText(tx.TxDesc) ??
      sanitizeCardText(tx.TypeName) ??
      "聯邦銀行信用卡消費";
    const identity = [
      cardLast4 ?? "account",
      effectiveDate ?? postedDate,
      postedDate,
      amount,
      description,
    ].join("|");
    const occurrence = (postedOccurrences.get(identity) ?? 0) + 1;
    postedOccurrences.set(identity, occurrence);

    bankTransactions.push({
      accountId: CREDIT_ACCOUNT_SOURCE_ID,
      sourceId: `ubot:card:tx:posted:${stableHash(`${identity}|${occurrence}`)}`,
      postedDate,
      ...(effectiveDate ? { authorizedAt: effectiveDate } : {}),
      amount,
      currency: "TWD",
      description,
      status: "posted",
      ...(cardLast4 ? { cardLast4 } : {}),
      ...(cardName ? { cardName } : {}),
      raw: {
        ...(cardLast4 ? { cardLast4 } : {}),
        ...(cardName ? { cardName } : {}),
        seq: optionalString(tx.Seq),
        txCode: txCode || undefined,
        typeName: sanitizeCardText(tx.TypeName),
        effectiveDate,
        postingDate: postedDate,
        foreignCurrency: optionalString(tx.Currency),
        foreignAmount: numberValue(tx.OriAmt),
      },
    });
  }

  // 即時消費授權 (NNBC080101)
  const realtimeBody = resBodyRecord(payloads.realtimeAuth);
  const realtimeList = Array.isArray(realtimeBody.CardBillList)
    ? realtimeBody.CardBillList
    : [];
  const pendingOccurrences = new Map<string, number>();
  for (const tx of realtimeList) {
    if (!isRecord(tx)) continue;
    const amt = numberValue(tx.Amt);
    const postedDate = normalizeUbotDate(tx.DateTime);
    const timestamp = normalizeUbotTimestamp(tx.DateTime);
    if (amt == null || !postedDate) continue;
    const amount = amt === 0 ? 0 : -amt;
    const cardLast4 = lastDigits(stringValue(tx.CardNo), 4) || undefined;
    const cardName =
      sanitizeCardText(tx.CardName) ??
      (cardLast4 ? uniqueCardNameByLast4.get(cardLast4) : undefined);
    const description =
      sanitizeCardText(tx.StoreName) ?? "聯邦銀行信用卡即時消費";
    const identity = [
      cardLast4 ?? "account",
      timestamp ?? postedDate,
      amount,
      description,
    ].join("|");
    const occurrence = (pendingOccurrences.get(identity) ?? 0) + 1;
    pendingOccurrences.set(identity, occurrence);

    bankTransactions.push({
      accountId: CREDIT_ACCOUNT_SOURCE_ID,
      sourceId: `ubot:card:tx:pending:${stableHash(`${identity}|${occurrence}`)}`,
      postedDate,
      ...(timestamp ? { authorizedAt: `${timestamp}+08:00` } : {}),
      amount,
      currency: "TWD",
      description,
      status: "pending",
      ...(cardLast4 ? { cardLast4 } : {}),
      ...(cardName ? { cardName } : {}),
      raw: {
        ...(cardLast4 ? { cardLast4 } : {}),
        ...(cardName ? { cardName } : {}),
        dateTime: timestamp ?? postedDate,
      },
    });
  }

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions: dedupeBySourceId(bankTransactions),
    creditCardBills: dedupeBySourceId(creditCardBills),
  };
}

/** 剖析聯邦個人貸款總覽 (`NNBL010401`)。 */
export function parseUbotLoanData(
  loanPayload: unknown,
  now = new Date(),
): Pick<UbotParsedData, "bankAccounts" | "bankBalanceSnapshots"> {
  const body = resBodyRecord(loanPayload);
  const loanList = Array.isArray(body.LoanList) ? body.LoanList : [];
  if (loanList.length === 0) {
    return { bankAccounts: [], bankBalanceSnapshots: [] };
  }

  const asOfAt = now.toISOString();
  const bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">> = [];
  const bankBalanceSnapshots: Array<
    Omit<BankBalanceSnapshot, "id" | "connectorId">
  > = [];

  for (const item of loanList) {
    if (!isRecord(item)) continue;
    const creditNo = normalizeHalfWidth(stringValue(item.CreditNo));
    const principal = numberValue(item.AmtPay);
    if (!creditNo || principal == null) continue;

    const creditLast4 = lastDigits(creditNo, 4);
    const sourceId = `loan:ubot:${stableHash(`ubot:loan:${creditNo}`)}`;
    const ratePct = numberValue(item.Rate9);
    const paymentDay = numberValue(item.PayDay2);
    const openedDate = normalizeUbotDate(item.LoanDate);
    const maturityDate = normalizeUbotDate(item.LoanExpDate);
    const intPay = numberValue(item.IntPay) ?? 0;
    const odPay = numberValue(item.ODpay) ?? 0;
    const damPay = numberValue(item.DamPay) ?? 0;
    const nextPaymentAmount =
      intPay + odPay + damPay > 0 ? intPay + odPay + damPay : undefined;

    const payAccountDigits = normalizeHalfWidth(
      stringValue(item.PayAccount),
    ).replace(/\D/g, "");
    const autopayAccount: AutopayAccountHint | undefined =
      payAccountDigits.length >= 6
        ? {
            bankCode: UBOT_BANK_CODE,
            last4: payAccountDigits.slice(-4),
            depositSourceId: ubotDepositSourceId(payAccountDigits, "TWD"),
          }
        : undefined;

    bankAccounts.push({
      sourceId,
      institutionName: UBOT_INSTITUTION_NAME,
      accountName: creditLast4
        ? `聯邦銀行貸款 · 末四碼 ${creditLast4}`
        : "聯邦銀行貸款",
      accountType: "loan",
      loanCategory: "personal",
      currency: "TWD",
      ...(ratePct !== undefined ? { loanInterestRate: ratePct } : {}),
      ...(openedDate ? { openedDate } : {}),
      ...(maturityDate ? { maturityDate } : {}),
      ...(autopayAccount ? { autopayAccount } : {}),
      raw: {
        creditLast4: creditLast4 || undefined,
        branchName: optionalString(item.BranchCH),
        annualRatePct: ratePct,
        paymentDay:
          paymentDay != null &&
          Number.isInteger(paymentDay) &&
          paymentDay >= 1 &&
          paymentDay <= 31
            ? paymentDay
            : undefined,
        nextPaymentAmount,
        drawdownDate: openedDate,
        maturityDate,
      },
    });

    bankBalanceSnapshots.push({
      accountId: sourceId,
      sourceId: `${sourceId}:${asOfAt}`,
      balance: principal === 0 ? 0 : -Math.abs(principal),
      currency: "TWD",
      asOfAt,
      raw: {
        creditLast4: creditLast4 || undefined,
        principalBalance: principal,
        annualRatePct: ratePct,
      },
    });
  }

  return {
    bankAccounts: dedupeBySourceId(bankAccounts),
    bankBalanceSnapshots: dedupeBySourceId(bankBalanceSnapshots),
  };
}

function parseTwdTransactions(
  details: unknown[],
  accountId: string,
  accountNumber: string,
): Array<Omit<BankTransaction, "id" | "connectorId">> {
  const transactions: Array<Omit<BankTransaction, "id" | "connectorId">> = [];
  const occurrences = new Map<string, number>();

  for (const item of details) {
    if (!isRecord(item)) continue;
    const postedDate = normalizeUbotDate(item.TraDate);
    const timestamp = normalizeUbotTimestamp(item.TraDateTime);
    const traType = stringValue(item.TraType).trim();
    const expenditure = numberValue(item.Expenditure) ?? 0;
    const income = numberValue(item.Income) ?? 0;
    const amount =
      traType === "1"
        ? -Math.abs(expenditure)
        : traType === "2"
          ? Math.abs(income)
          : expenditure > 0
            ? -Math.abs(expenditure)
            : income > 0
              ? Math.abs(income)
              : undefined;
    if (!postedDate || amount === undefined) continue;

    const balance = numberValue(item.Balance);
    const traSum = sanitizeOptionalText(item.TraSum, accountNumber);
    const ps = sanitizeOptionalText(item.PS, accountNumber);
    const rawSummary = stringValue(item.Summary)
      .trim()
      .replace(/^\(|\)$/g, "");
    const counterpartyLast4 = lastDigits(rawSummary, 4);
    const toBankCode =
      stringValue(item.is1400).trim().toUpperCase() === "N"
        ? optionalString(item.ToBankCode)
        : undefined;
    const toBankName = toBankCode ? TAIWAN_BANK_NAMES[toBankCode] : undefined;
    const counterpartyLabel = counterpartyLast4
      ? `${toBankName ?? (toBankCode ? `銀行 ${toBankCode}` : "")}${toBankName || toBankCode ? " " : ""}••••${counterpartyLast4}`
      : undefined;

    const descriptionParts = [
      traSum,
      ps && ps !== traSum ? ps : undefined,
      counterpartyLabel,
    ].filter((part): part is string => Boolean(part));
    const description =
      descriptionParts.join(" · ") || "聯邦 New New Bank 交易";

    const identity = [
      accountId,
      timestamp ?? postedDate,
      amount,
      balance ?? "",
      traSum ?? "",
      ps ?? "",
      counterpartyLast4,
    ].join("|");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const sourceIdentity =
      occurrence === 1 ? identity : `${identity}|occurrence:${occurrence}`;

    transactions.push({
      accountId,
      sourceId: `ubot:deposit:tx:${stableHash(sourceIdentity)}`,
      postedDate,
      ...(timestamp ? { authorizedAt: `${timestamp}+08:00` } : {}),
      amount,
      currency: "TWD",
      description,
      status: "posted",
      raw: {
        accountLast4: accountNumber.slice(-4),
        amount,
        balance,
        summary: traSum,
        note: ps,
        counterpartyBankCode: toBankCode,
        counterpartyLast4: counterpartyLast4 || undefined,
        transactionDate: postedDate,
        transactionDateTime: timestamp,
      },
    });
  }

  return transactions;
}

function parseFxTransactions(
  payloads: UbotFxTransactionPayload[],
  accountIds: Map<string, string>,
): Array<Omit<BankTransaction, "id" | "connectorId">> {
  const transactions: Array<Omit<BankTransaction, "id" | "connectorId">> = [];
  const occurrences = new Map<string, number>();

  for (const item of payloads) {
    const accountNo = normalizeHalfWidth(item.accountNumber).replace(/\D/g, "");
    const currency = item.currency.trim().toUpperCase();
    const accountId =
      accountIds.get(`${accountNo}:${currency}`) ??
      ubotDepositSourceId(accountNo, currency);
    const body = resBodyRecord(item.payload);
    const details = Array.isArray(body.FTDetailList) ? body.FTDetailList : [];

    for (const detail of details) {
      if (!isRecord(detail)) continue;
      const postedDate = normalizeUbotDate(detail.TxnDate);
      const expenditure = numberValue(detail.Expenditure) ?? 0;
      const income = numberValue(detail.Income) ?? 0;
      const amount =
        expenditure > 0
          ? -Math.abs(expenditure)
          : income > 0
            ? Math.abs(income)
            : undefined;
      if (!postedDate || amount === undefined) continue;

      const balance = numberValue(detail.Balance);
      const traSum = sanitizeOptionalText(detail.TraSum, accountNo);
      const memo = sanitizeOptionalText(detail.Memo, accountNo);
      const description =
        [traSum, memo && memo !== traSum ? memo : undefined]
          .filter((part): part is string => Boolean(part))
          .join(" · ") || `聯邦外幣交易 (${currency})`;

      const identity = [
        accountId,
        postedDate,
        amount,
        balance ?? "",
        traSum ?? "",
        memo ?? "",
      ].join("|");
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      const sourceIdentity =
        occurrence === 1 ? identity : `${identity}|occurrence:${occurrence}`;

      transactions.push({
        accountId,
        sourceId: `ubot:foreign:tx:${stableHash(sourceIdentity)}`,
        postedDate,
        amount,
        currency,
        description,
        status: "posted",
        raw: {
          accountLast4: accountNo.slice(-4),
          currency,
          amount,
          balance,
          summary: traSum,
          memo,
          transactionDate: postedDate,
        },
      });
    }
  }

  return transactions;
}

/**
 * 自動扣繳帳號取自 `NNBC030101` 的 `BillList[].Account`。帳務總覽的
 * `PaymentAcctno` 是信用卡卡號而非扣款帳號，不可作為備援。
 */
function resolveCreditCardAutopay(
  autopayPayload: unknown,
): AutopayAccountHint | null | undefined {
  const autopayBody = resBodyRecord(autopayPayload);
  const autopayRow =
    Array.isArray(autopayBody.BillList) && isRecord(autopayBody.BillList[0])
      ? autopayBody.BillList[0]
      : undefined;

  if (!autopayRow) return undefined;
  const status = stringValue(autopayRow.Status).trim();
  const acctText = normalizeHalfWidth(stringValue(autopayRow.Account));
  if (status === "9" || acctText.toUpperCase() === "NON") return null;
  const digits = acctText.replace(/\D/g, "");
  if (status !== "0" || digits.length < 6) return undefined;
  return {
    bankCode: UBOT_BANK_CODE,
    last4: digits.slice(-4),
    depositSourceId: ubotDepositSourceId(digits, "TWD"),
  };
}

/**
 * 將聯邦 API 常見日期格式轉為 `YYYY-MM-DD`：
 * - `YYYY-MM-DD` / `YYYY/MM/DD`
 * - `YYYYMMDD`（8 碼西元年）
 * - `0YYYMMDD` / `YYYMMDD`（7 碼或 6 碼民國年，例如 `01150102` → `2026-01-02`）
 */
export function normalizeUbotDate(value: unknown): string | undefined {
  const text = normalizeHalfWidth(stringValue(value));
  if (!text || text === "99999999" || text === "00000000") return undefined;

  const datePart = text.split(/[ T]/)[0] ?? "";
  const separated = /^(\d{3,4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(datePart);
  if (separated) {
    const rawYear = Number(separated[1]);
    const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
    return validateYmd(year, Number(separated[2]), Number(separated[3]));
  }

  if (/^\d{8}$/.test(datePart)) {
    const first4 = Number(datePart.slice(0, 4));
    if (first4 >= 1911 && first4 <= 2100) {
      return validateYmd(
        first4,
        Number(datePart.slice(4, 6)),
        Number(datePart.slice(6, 8)),
      );
    }
    if (datePart.startsWith("0")) {
      const rocYear = Number(datePart.slice(1, 4));
      return validateYmd(
        rocYear + 1911,
        Number(datePart.slice(4, 6)),
        Number(datePart.slice(6, 8)),
      );
    }
  }

  if (/^\d{7}$/.test(datePart)) {
    const rocYear = Number(datePart.slice(0, 3));
    return validateYmd(
      rocYear + 1911,
      Number(datePart.slice(3, 5)),
      Number(datePart.slice(5, 7)),
    );
  }

  return undefined;
}

export function normalizeUbotTimestamp(value: unknown): string | undefined {
  const text = normalizeHalfWidth(stringValue(value));
  const match =
    /^(\d{3,4}[./-]\d{1,2}[./-]\d{1,2}|\d{7,8})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      text,
    );
  if (!match) return undefined;
  const date = normalizeUbotDate(match[1]);
  if (!date) return undefined;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? "0");
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return undefined;
  }
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function normalizeBillingPeriod(value: string): string | undefined {
  const text = normalizeHalfWidth(value).replace(/[./-]/g, "");
  if (/^\d{6}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6));
    if (year >= 1911 && year <= 2100 && month >= 1 && month <= 12) {
      return `${year}-${String(month).padStart(2, "0")}`;
    }
  }
  if (/^\d{5}$/.test(text)) {
    const year = Number(text.slice(0, 3)) + 1911;
    const month = Number(text.slice(3, 5));
    if (month >= 1 && month <= 12) {
      return `${year}-${String(month).padStart(2, "0")}`;
    }
  }
  return undefined;
}

function validateYmd(
  year: number,
  month: number,
  day: number,
): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function resBodyRecord(payload: unknown): JsonRecord {
  if (!isRecord(payload)) return {};
  return isRecord(payload.ResBody) ? payload.ResBody : payload;
}

function randomDigitString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => String(b % 10)).join("");
}

function stableHash(value: string): string {
  return forge.md.sha256
    .create()
    .update(value, "utf8")
    .digest()
    .toHex()
    .slice(0, 16);
}

function lastDigits(value: string, count: number): string {
  return value.replace(/\D/g, "").slice(-count);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  const result = normalizeHalfWidth(stringValue(value));
  return result || undefined;
}

function sanitizeCardText(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  return maskLongDigitSequences(text).trim() || undefined;
}

function sanitizeOptionalText(
  value: unknown,
  accountNumber: string,
): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  const withoutAccount = accountNumber
    ? text.replaceAll(accountNumber, "")
    : text;
  return maskLongDigitSequences(withoutAccount).trim() || undefined;
}

function maskLongDigitSequences(value: string): string {
  return value.replace(/\d(?:[\s-]*\d){4,}/g, (matched) => {
    const digits = matched.replace(/\D/g, "");
    return `••••${digits.slice(-4)}`;
  });
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = normalizeHalfWidth(value).replace(/[,$\s]/g, "");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]): T[] {
  return Array.from(
    new Map(records.map((record) => [record.sourceId, record])).values(),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
