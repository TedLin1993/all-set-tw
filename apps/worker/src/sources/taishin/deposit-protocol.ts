import forge from "node-forge";
import { z } from "zod";
import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/shared";
import { BANK_SYNC_MONTHS } from "../sync-window";

// Field meanings follow the official RWD RB0100/0101/0102 and RB0800/0802 pages.
const moneySchema = z.union([z.string(), z.number()]);
// 銀行回傳的幣別不一定是三碼大寫（可能夾空白、小寫、數字代碼或中文名稱）；請求沿用原值，
// 儲存與比對一律用 normalizeTaishinCurrency 換成 ISO 三碼。無法換算時驗證失敗。
const currencySchema = z
  .string()
  .refine((value) => normalizeTaishinCurrency(value) !== undefined, {
    error: "unsupported currency",
  });

// 外幣清單可能含沒有幣別的空白佔位列（例如綜存尚未開立任何外幣），先放行，
// 由 fetchTaishinDeposits 在餘額為零時略過、有餘額時失敗。
const fxDetailCurrencySchema = z
  .string()
  .refine(
    (value) =>
      value.trim() === "" || normalizeTaishinCurrency(value) !== undefined,
    { error: "unsupported currency" },
  );

const NUMERIC_CURRENCIES: Record<string, string> = {
  "000": "TWD",
  "901": "TWD",
  "840": "USD",
  "392": "JPY",
  "978": "EUR",
  "156": "CNY",
  "344": "HKD",
  "036": "AUD",
  "826": "GBP",
  "124": "CAD",
  "756": "CHF",
  "702": "SGD",
  "554": "NZD",
  "710": "ZAR",
  "752": "SEK",
  "764": "THB",
};
const NAMED_CURRENCIES: Array<[RegExp, string]> = [
  [/新臺幣|新台幣|臺幣|台幣/, "TWD"],
  [/美元|美金/, "USD"],
  [/日圓|日元|日幣/, "JPY"],
  [/歐元/, "EUR"],
  [/人民幣/, "CNY"],
  [/港幣|港元/, "HKD"],
  [/澳幣|澳元/, "AUD"],
  [/英鎊/, "GBP"],
  [/加幣|加元/, "CAD"],
  [/瑞士法郎|瑞郎/, "CHF"],
  [/新加坡幣|新幣/, "SGD"],
  [/紐幣|紐元/, "NZD"],
  [/南非幣/, "ZAR"],
  [/瑞典幣|瑞典克朗/, "SEK"],
  [/泰銖|泰幣/, "THB"],
];

export function normalizeTaishinCurrency(value: string): string | undefined {
  // 收集所有可辨識的幣別線索（三碼、ISO 數字代碼、中文名稱），全部一致才採用；
  // 同時指向不同幣別（例如「美元/日圓」）或含無法辨識的數字代碼時視為無法判斷。
  const text = value.trim().toUpperCase();
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![A-Z])([A-Z]{3})(?![A-Z])/g))
    found.add(match[1] === "NTD" ? "TWD" : match[1]!);
  for (const match of text.matchAll(/(?<!\d)(\d{1,3})(?!\d)/g)) {
    const code = NUMERIC_CURRENCIES[match[1]!.padStart(3, "0")];
    if (!code) return undefined;
    found.add(code);
  }
  for (const [pattern, code] of NAMED_CURRENCIES)
    if (pattern.test(value)) found.add(code);
  return found.size === 1 ? [...found][0] : undefined;
}

/** 不含實際值的字元形狀，例如 "AAA_"（大寫、小寫 a、數字 9、空白 _、中文 C、其他 ?）。 */
function currencyShape(value: unknown) {
  if (typeof value !== "string") return undefined;
  const shape = [...value]
    .slice(0, 12)
    .map((char) =>
      /[A-Z]/.test(char)
        ? "A"
        : /[a-z]/.test(char)
          ? "a"
          : /\d/.test(char)
            ? "9"
            : /\s/.test(char)
              ? "_"
              : /\p{Script=Han}/u.test(char)
                ? "C"
                : "?",
    )
    .join("");
  return `${shape}${value.length > 12 ? "…" : ""}（長度 ${value.length}）`;
}
const twdAccountSchema = z.object({
  accountNo: z.string().min(1),
  accountTypeName: z.string(),
  balance: moneySchema,
});
const fxDetailSchema = z.object({
  ACCOUNT_NO: z.string().optional(),
  ACCOUNT_ALIAS: z.string().nullish(),
  CURRENCY_CODE: fxDetailCurrencySchema,
  BALANCE: moneySchema,
});
const fxAccountSchema = z.object({
  ACCOUNT_NO: z.string().min(1),
  ACCOUNT_NAME: z.string().optional(),
  FCS_ACCOUNT_DETAIL: z.array(fxDetailSchema),
});
const twdTransactionSchema = z.object({
  sysdate: z.string(),
  dateNew: z.string(),
  txnamt: moneySchema,
  txnamtIn: moneySchema,
  txnamtOut: moneySchema,
  newbal: moneySchema,
  memo: z.string(),
  message: z.string().nullish(),
  procSeq: moneySchema.nullish(),
});
const fxTransactionSchema = z.object({
  TRANSACTION_DATE_TIME: z.string(),
  TRANSACTION_DATE_TIME_DSC: z.string(),
  TX_DATE: z.string(),
  CCY_CODE: currencySchema,
  DRWAMT: moneySchema,
  DEPAMT: moneySchema,
  ACCT_BAL: moneySchema,
  REMARKS: z.string().nullish(),
});
const emptyObjectSchema = z.object({}).strict();
type TwdTransaction = z.infer<typeof twdTransactionSchema>;
type FxTransaction = z.infer<typeof fxTransactionSchema>;
type DepositRequest = (
  path: string,
  body: Record<string, unknown> | string,
) => Promise<unknown>;
export type TaishinDepositData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};
type DiagnosticValueType =
  | "missing"
  | "null"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "unknown";
type FxAccountDiagnosticIssue = {
  path: string;
  code:
    | "invalid_type"
    | "invalid_format"
    | "too_small"
    | "invalid_union"
    | "unknown";
  expected:
    | "string"
    | "number"
    | "array"
    | "object"
    | "string|number"
    | "array|object"
    | "unknown";
  received: DiagnosticValueType;
  /** 幣別欄位格式不符時的字元形狀（不含實際值）。 */
  shape?: string;
};
type FxAccountDiagnostics = {
  issues: FxAccountDiagnosticIssue[];
  truncated: boolean;
};

export class TaishinDepositProtocolError extends Error {
  constructor(
    message: string,
    readonly incomplete = false,
    readonly diagnostics?: FxAccountDiagnostics,
  ) {
    super(message);
    this.name = "TaishinDepositProtocolError";
  }
}

function checked<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  diagnose?: (
    issues: readonly z.core.$ZodIssue[],
    value: unknown,
  ) => FxAccountDiagnostics,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const diagnostics = diagnose?.(parsed.error.issues, value);
    const first = diagnostics?.issues[0];
    const message = diagnostics
      ? `台新存款${label}格式驗證失敗。`
      : `台新存款${label}格式已改變。`;
    const detail = first
      ? `（${first.path}：${first.code}，預期 ${first.expected}，收到 ${first.received}${first.shape ? `，形狀 ${first.shape}` : ""}。）`
      : "";
    throw new TaishinDepositProtocolError(message + detail, false, diagnostics);
  }
  return parsed.data;
}

function fxDiagnosticPath(path: readonly PropertyKey[]) {
  if (path[0] !== "FCS_ACCOUNT") return "unknown";
  let result = "FCS_ACCOUNT";
  if (path.length === 1) return result;
  // This position is always a dynamic account key or index, even if its text
  // happens to match one of the schema's field names.
  result += "[*]";
  if (path.length === 2) return result;
  const field = path[2];
  if (
    typeof field !== "string" ||
    !["ACCOUNT_NO", "ACCOUNT_NAME", "FCS_ACCOUNT_DETAIL"].includes(field)
  )
    return `${result}.unknown`;
  result += `.${field}`;
  if (path.length === 3) return result;
  if (field !== "FCS_ACCOUNT_DETAIL") return `${result}.unknown`;
  result += "[*]";
  if (path.length === 4) return result;
  const detailField = path[4];
  if (
    typeof detailField !== "string" ||
    !["ACCOUNT_NO", "ACCOUNT_ALIAS", "CURRENCY_CODE", "BALANCE"].includes(
      detailField,
    )
  )
    return `${result}.unknown`;
  result += `.${detailField}`;
  return path.length === 5 ? result : `${result}.unknown`;
}

function diagnosticValueType(value: unknown): DiagnosticValueType {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  switch (type) {
    case "string":
    case "number":
    case "boolean":
    case "object":
      return type;
    default:
      return "unknown";
  }
}

function fxAccountDiagnostics(
  issues: readonly z.core.$ZodIssue[],
  value: unknown,
): FxAccountDiagnostics {
  const result: FxAccountDiagnostics = { issues: [], truncated: false };
  const seen = new Set<string>();
  const visit = (
    issues: readonly z.core.$ZodIssue[],
    prefix: readonly PropertyKey[] = [],
  ) => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      if (issue.code === "invalid_union") {
        // Zod union child paths are relative. A branch with field errors
        // matched the container; omit the other branch's root type error.
        const branches = issue.errors.filter((branch) =>
          branch.some((child) => child.path.length > 0),
        );
        if (branches.length > 0) {
          for (const branch of branches) {
            visit(branch, path);
            if (result.truncated) return;
          }
          continue;
        }
      }
      let receivedValue = value;
      for (const key of path) {
        receivedValue =
          receivedValue !== null &&
          typeof receivedValue === "object" &&
          Object.hasOwn(receivedValue, key)
            ? (receivedValue as Record<PropertyKey, unknown>)[key]
            : undefined;
      }
      const diagnostic: FxAccountDiagnosticIssue = {
        path: fxDiagnosticPath(path),
        code: "unknown",
        expected: "unknown",
        received: diagnosticValueType(receivedValue),
      };
      switch (issue.code) {
        case "invalid_type":
          diagnostic.code = issue.code;
          switch (issue.expected) {
            case "string":
              diagnostic.expected = "string";
              break;
            case "number":
              diagnostic.expected = "number";
              break;
            case "array":
              diagnostic.expected = "array";
              break;
            case "object":
            case "record":
              diagnostic.expected = "object";
              break;
          }
          break;
        case "invalid_format":
        case "too_small":
          diagnostic.code = issue.code;
          diagnostic.expected = "string";
          break;
        case "custom":
          if (diagnostic.path.endsWith(".CURRENCY_CODE")) {
            diagnostic.code = "invalid_format";
            diagnostic.expected = "string";
            const shape = currencyShape(receivedValue);
            if (shape) diagnostic.shape = shape;
          }
          break;
        case "invalid_union":
          diagnostic.code = issue.code;
          diagnostic.expected =
            diagnostic.path === "FCS_ACCOUNT"
              ? "array|object"
              : diagnostic.path.endsWith(".BALANCE")
                ? "string|number"
                : "unknown";
          break;
      }
      const identity = JSON.stringify(diagnostic);
      if (seen.has(identity)) continue;
      if (result.issues.length === 5) {
        result.truncated = true;
        return;
      }
      seen.add(identity);
      result.issues.push(diagnostic);
    }
  };
  visit(issues);
  return result;
}

function twdData(payload: unknown) {
  const envelope = checked(
    z.object({ RESULT: z.literal("NORMAL"), OUTPUTDATA: z.unknown() }),
    payload,
    "回應",
  );
  return envelope.OUTPUTDATA;
}

function fxData(payload: unknown) {
  return checked(
    z.object({ error: z.null(), data: z.unknown() }),
    payload,
    "外幣回應",
  ).data;
}

function hash(value: string) {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}

function plainText(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();
}

function redact(value: string) {
  return plainText(value)
    .replace(/[A-Z][12]\d{8}/gi, "[身分證已遮罩]")
    .replace(
      /\d(?:[ -]?\d){7,}/g,
      (match) => `****${match.replace(/\D/g, "").slice(-4)}`,
    );
}

function amount(value: string | number) {
  const text =
    typeof value === "number"
      ? String(value)
      : plainText(value).replaceAll(",", "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)))
    throw new TaishinDepositProtocolError("台新存款金額格式已改變。");
  return Number(text);
}

function isZeroOrBlankAmount(value: string | number) {
  if (typeof value === "number") return value === 0;
  const text = plainText(value).replaceAll(",", "").trim();
  return (
    text === "" || (/^[+-]?\d+(?:\.\d+)?$/.test(text) && Number(text) === 0)
  );
}

function accountIdentity(value: string) {
  const digits = value.replace(/[ -]/g, "");
  if (!/^\d{8,14}$/.test(digits))
    throw new TaishinDepositProtocolError("台新存款帳戶識別格式已改變。");
  // The official formatAccount pads a 13-digit account to 14 digits.
  return digits.length === 13 ? digits.padStart(14, "0") : digits;
}

function accountId(value: string, currency: string) {
  const identity = accountIdentity(value);
  return `bank:taishin:${identity.slice(-4)}:${hash(identity)}:${currency}`;
}

function dateTime(value: string) {
  const text = plainText(value);
  const match = text.match(
    /^(\d{4})(?:[/-](\d{1,2})[/-](\d{1,2})|(\d{2})(\d{2}))(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?| (\d{1,8})|(\d{6})(?:\d{2})?)?$/,
  );
  if (!match)
    throw new TaishinDepositProtocolError("台新存款交易日期格式已改變。");
  const day = `${match[1]}-${(match[2] ?? match[4])!.padStart(2, "0")}-${(match[3] ?? match[5])!.padStart(2, "0")}`;
  if (
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new TaishinDepositProtocolError("台新存款交易日期無效。");
  if (!match[6] && !match[9] && !match[10]) return day;
  // RB0102 pads the clock to HHmmssSS before displaying it (centiseconds omitted).
  const clock = match[9]?.padStart(8, "0") ?? match[10];
  const hour = clock?.slice(0, 2) ?? match[6]!.padStart(2, "0");
  const minute = clock?.slice(2, 4) ?? match[7]!;
  const second = clock?.slice(4, 6) ?? match[8] ?? "00";
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
    throw new TaishinDepositProtocolError("台新存款交易時間無效。");
  return `${day}T${hour}:${minute}:${second}+08:00`;
}

function twdRows(payload: unknown) {
  const data = checked(
    z.object({
      userList: z.array(twdTransactionSchema),
      inNo: moneySchema,
      outNo: moneySchema,
    }),
    twdData(payload),
    "交易清單",
  );
  const incomingCount = amount(data.inNo);
  const outgoingCount = amount(data.outNo);
  if (
    ![incomingCount, outgoingCount].every(
      (count) => Number.isInteger(count) && count >= 0,
    )
  )
    throw new TaishinDepositProtocolError("台新存款交易筆數格式已改變。");
  const count = incomingCount + outgoingCount;
  if (!Number.isInteger(count) || count < 0 || count !== data.userList.length)
    throw new TaishinDepositProtocolError("台新存款交易清單筆數不完整。", true);
  return data.userList;
}

function fxRows(payload: unknown) {
  const data = checked(
    z.object({
      TRANS_DETAILS: z.union([z.array(fxTransactionSchema), emptyObjectSchema]),
    }),
    fxData(payload),
    "外幣交易清單",
  );
  // The official page tests Object.keys(TRANS_DETAILS).length for no transactions.
  return Array.isArray(data.TRANS_DETAILS) ? data.TRANS_DETAILS : [];
}

function normalizeTransactions(
  rows: Array<TwdTransaction | FxTransaction>,
  accountNumber: string,
  currency: string,
): TaishinDepositData["bankTransactions"] {
  const id = accountId(accountNumber, currency);
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const twd = "sysdate" in row;
    if (!twd && normalizeTaishinCurrency(row.CCY_CODE) !== currency)
      throw new TaishinDepositProtocolError("台新外幣交易幣別與查詢不符。");
    const authorizedAt = dateTime(
      twd ? row.sysdate : row.TRANSACTION_DATE_TIME_DSC,
    );
    const postedDate = dateTime(twd ? row.dateNew : row.TX_DATE).slice(0, 10);
    const out = twd ? row.txnamtOut : row.DRWAMT;
    const incoming = twd ? row.txnamtIn : row.DEPAMT;
    if ((String(out) === "-") === (String(incoming) === "-"))
      throw new TaishinDepositProtocolError("台新存款交易方向無法確認。");
    amount(String(out) === "-" ? incoming : out);
    const signed = twd
      ? (String(out) === "-" ? 1 : -1) * Math.abs(amount(row.txnamt))
      : String(out) === "-"
        ? Math.abs(amount(incoming))
        : -Math.abs(amount(out));
    const balance = amount(twd ? row.newbal : row.ACCT_BAL);
    const reference =
      twd && row.procSeq != null ? String(row.procSeq).padStart(7, "0") : "";
    const identity = hash(
      JSON.stringify([
        id,
        authorizedAt.slice(0, 10),
        signed,
        balance,
        reference,
      ]),
    );
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const memo = redact(twd ? row.memo : signed < 0 ? "支出" : "存入");
    const remarks = redact((twd ? row.message : row.REMARKS) ?? "");
    return {
      accountId: id,
      sourceId: `taishin:deposit:tx:${identity}:${occurrence}`,
      authorizedAt,
      postedDate,
      amount: signed,
      currency,
      description: remarks ? `${memo} · ${remarks}` : memo,
      status: "posted",
      raw: { balance },
    };
  });
}

export function parseTaishinTwdDepositTransactions(
  payload: unknown,
  accountNumber: string,
) {
  return normalizeTransactions(twdRows(payload), accountNumber, "TWD");
}

export function parseTaishinFxDepositTransactions(
  payload: unknown,
  accountNumber: string,
  currency: string,
) {
  return normalizeTransactions(fxRows(payload), accountNumber, currency);
}

export async function fetchTaishinDeposits(
  request: DepositRequest,
  now = new Date(),
): Promise<TaishinDepositData> {
  const root = "/TIBNetBank/svc";
  const twdAccounts = checked(
    z.object({ SavingAccount: z.array(twdAccountSchema) }),
    twdData(await request(`${root}/web1/rb0100/query`, "")),
    "臺幣帳戶清單",
  ).SavingAccount;
  const fxAccounts = checked(
    z.object({
      FCS_ACCOUNT: z.union([
        z.array(fxAccountSchema),
        z.record(z.string(), fxAccountSchema),
      ]),
    }),
    fxData(await request(`${root}/web2/rb0800/getRB08000100Data`, "")),
    "外幣帳戶清單",
    fxAccountDiagnostics,
  ).FCS_ACCOUNT;
  const result: TaishinDepositData = {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    bankTransactions: [],
  };
  const end = new Date(now.getTime() + 8 * 3600_000);
  const endDay = end.toISOString().slice(0, 10);
  const start = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - BANK_SYNC_MONTHS, 1),
  );
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(end.getUTCDate(), lastDay));
  const startDay = start.toISOString().slice(0, 10);
  const addAccount = (
    number: string,
    currency: string,
    name: string,
    balance: number,
    availableBalance?: number,
  ) => {
    const id = accountId(number, currency);
    if (result.bankAccounts.some((account) => account.sourceId === id))
      throw new TaishinDepositProtocolError("台新存款帳戶清單重複。");
    result.bankAccounts.push({
      sourceId: id,
      institutionName: "台新銀行",
      accountName: `末四碼 ${accountIdentity(number).slice(-4)}`,
      accountType: /支票|支存/.test(name) ? "checking" : "savings",
      currency,
    });
    result.bankBalanceSnapshots.push({
      accountId: id,
      sourceId: `${id}:balance:${endDay}`,
      balance,
      availableBalance,
      currency,
      asOfAt: now.toISOString(),
      raw: { balance, availableBalance },
    });
  };
  const checkWindow = (
    transactions: TaishinDepositData["bankTransactions"],
  ) => {
    for (const transaction of transactions) {
      if (
        ![transaction.authorizedAt?.slice(0, 10), transaction.postedDate].some(
          (day) => day && day >= startDay && day <= endDay,
        )
      )
        throw new TaishinDepositProtocolError("台新存款交易超出查詢期間。");
    }
    result.bankTransactions.push(...transactions);
  };

  if (twdAccounts.length > 0) {
    const options = checked(
      z.array(z.object({ value: z.string() })),
      twdData(await request(`${root}/web1/rb0102/listaccount`, {})),
      "臺幣查詢帳戶",
    );
    for (const account of twdAccounts) {
      if (
        !options.some(
          (option) =>
            accountIdentity(option.value) ===
            accountIdentity(account.accountNo),
        )
      )
        throw new TaishinDepositProtocolError(
          "台新存款帳戶未出現在交易查詢清單。",
        );
      const balance = checked(
        z.object({ balance: moneySchema, availbalance: moneySchema.nullish() }),
        twdData(
          await request(`${root}/web1/rb0101/query`, {
            account: account.accountNo,
          }),
        ),
        "臺幣即時餘額",
      );
      addAccount(
        account.accountNo,
        "TWD",
        account.accountTypeName,
        amount(balance.balance),
        balance.availbalance == null ? undefined : amount(balance.availbalance),
      );
      const fetchRows = async (
        from: string,
        to: string,
      ): Promise<TwdTransaction[]> => {
        const payload = await request(`${root}/web1/rb0102/query`, {
          account: account.accountNo,
          start: from.replaceAll("-", ""),
          end: to.replaceAll("-", ""),
        });
        try {
          return twdRows(payload);
        } catch (error) {
          if (
            !(error instanceof TaishinDepositProtocolError) ||
            !error.incomplete ||
            from === to
          )
            throw error;
          const middle = new Date(
            Math.floor((Date.parse(from) + Date.parse(to)) / 2 / 86400_000) *
              86400_000,
          );
          const next = new Date(middle.getTime() + 86400_000);
          return [
            ...(await fetchRows(from, middle.toISOString().slice(0, 10))),
            ...(await fetchRows(next.toISOString().slice(0, 10), to)),
          ];
        }
      };
      checkWindow(
        normalizeTransactions(
          await fetchRows(startDay, endDay),
          account.accountNo,
          "TWD",
        ),
      );
    }
  }

  let blankCurrencyDetails = 0;
  const fxGroups = Object.values(fxAccounts).flatMap((group) => {
    const details = group.FCS_ACCOUNT_DETAIL.filter((detail) => {
      if (detail.CURRENCY_CODE.trim() !== "") return true;
      if (!isZeroOrBlankAmount(detail.BALANCE))
        throw new TaishinDepositProtocolError(
          "台新外幣帳戶有餘額但未提供幣別，無法判斷幣別。",
        );
      blankCurrencyDetails += 1;
      return false;
    });
    // 整個帳戶只有空白佔位列時，銀行的交易查詢清單也不會有它，整組略過。
    if (group.FCS_ACCOUNT_DETAIL.length > 0 && details.length === 0) return [];
    return [{ ...group, FCS_ACCOUNT_DETAIL: details }];
  });
  if (blankCurrencyDetails > 0)
    console.log(
      JSON.stringify({
        event: "taishin_fx_blank_currency_skipped",
        count: blankCurrencyDetails,
      }),
    );
  if (fxGroups.length > 0) {
    // RB0802's mounted hook initializes through RB0812 even for in-year queries.
    const options = checked(
      z.object({
        ACCOUNT_OPTION: z.array(z.object({ value: z.string() })),
        EMAIL: z.string().nullish(),
        NEXT_NEXT_WORK_DAY: z.string().nullish(),
        RB0802_ORDER_TYPE: moneySchema.optional(),
      }),
      fxData(await request(`${root}/web2/rb0812/getRB08120100Options`, "")),
      "外幣查詢帳戶",
    );
    for (const group of fxGroups) {
      const option = options.ACCOUNT_OPTION.find(
        (option) =>
          accountIdentity(option.value) === accountIdentity(group.ACCOUNT_NO),
      );
      if (!option)
        throw new TaishinDepositProtocolError(
          "台新外幣帳戶未出現在交易查詢清單。",
        );
      for (const detail of group.FCS_ACCOUNT_DETAIL) {
        if (
          detail.ACCOUNT_NO &&
          accountIdentity(detail.ACCOUNT_NO) !==
            accountIdentity(group.ACCOUNT_NO)
        )
          throw new TaishinDepositProtocolError("台新外幣餘額帳戶與總覽不符。");
        const balances = checked(
          z.array(
            z.object({
              ACCT_NO: z.string(),
              ACCT_TYPE_NAME: z.string().optional(),
              CURRENCY_CODE: currencySchema,
              BALANCE: moneySchema,
            }),
          ),
          fxData(
            await request(
              `${root}/web2/rb0800/getRB08000100QueryRealtimeBalance`,
              {
                requestAccount: detail.ACCOUNT_NO ?? group.ACCOUNT_NO,
                requestAccountAlias: detail.ACCOUNT_ALIAS ?? "",
                requestCcyCode: detail.CURRENCY_CODE,
              },
            ),
          ),
          "外幣即時餘額",
        );
        if (
          balances.length !== 1 ||
          accountIdentity(balances[0]!.ACCT_NO) !==
            accountIdentity(group.ACCOUNT_NO) ||
          normalizeTaishinCurrency(balances[0]!.CURRENCY_CODE) !==
            normalizeTaishinCurrency(detail.CURRENCY_CODE)
        )
          throw new TaishinDepositProtocolError(
            "台新外幣即時餘額與查詢帳戶或幣別不符。",
          );
        const currency = normalizeTaishinCurrency(detail.CURRENCY_CODE)!;
        addAccount(
          group.ACCOUNT_NO,
          currency,
          group.ACCOUNT_NAME ?? "",
          amount(balances[0]!.BALANCE),
        );
        const payload = await request(
          `${root}/web2/rb0802/getRB08020100ForeignTranDetail`,
          {
            requestAcctNo: option.value,
            requestCurrency: detail.CURRENCY_CODE,
            requestStartDate: startDay.replaceAll("-", ""),
            requestEndDate: endDay.replaceAll("-", ""),
            requestDateType: "I",
            nextNextWorkDay: options.NEXT_NEXT_WORK_DAY ?? "",
            requestEmail: options.EMAIL ?? "",
            rb0802OrderType: String(options.RB0802_ORDER_TYPE ?? 0),
          },
        );
        checkWindow(
          parseTaishinFxDepositTransactions(
            payload,
            group.ACCOUNT_NO,
            currency,
          ),
        );
      }
    }
  }
  return result;
}
