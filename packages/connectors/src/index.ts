import type {
  Connector,
  ConnectorId,
  Invoice,
  InvoiceLineItem,
} from "@taiwan-fin-hub/core";
import { z } from "zod";
import { currentPeriodIndex, periodFromIndex } from "./invoice-data";
import { EINVOICE_SYNC_PERIODS } from "./sync-window";
import { EInvoiceV2Client, type EInvoiceV2Session } from "./tw-einvoice-v2";

export { BANK_SYNC_MONTHS, EINVOICE_SYNC_PERIODS } from "./sync-window";

export { EInvoiceProtocolUnavailableError } from "./tw-einvoice-api";
export {
  EInvoiceV2Client,
  decryptLoginData,
  encryptLoginData,
  signInvoiceJwt,
} from "./tw-einvoice-v2";
export type { EInvoiceV2Options, EInvoiceV2Session } from "./tw-einvoice-v2";

export {
  tdccConnector,
  createTdccConnector,
  tdccConfigSchema,
  parseTdccConfig,
  syncTdccTradeHistory,
  TdccConnectionError,
  TdccOtpExpiredError,
  TdccVerificationRequiredError,
} from "./tdcc";
export type {
  TdccConfig,
  TdccHolding,
  TdccCashBalance,
  TdccCashMovement,
  TdccClient,
} from "./tdcc";
import { tdccConfigSchema } from "./tdcc";

export { esunConfigSchema, parseEsunConfig } from "./esun";
export type { EsunConfig } from "./esun";
import { esunConfigSchema } from "./esun";

export { cathaybkConfigSchema, parseCathaybkConfig } from "./cathaybk";
export type { CathaybkConfig } from "./cathaybk";
import { cathaybkConfigSchema } from "./cathaybk";

export { sinopacConfigSchema, parseSinopacConfig } from "./sinopac";
export type { SinopacConfig } from "./sinopac";
import { sinopacConfigSchema } from "./sinopac";

export {
  parseTaishinConfig,
  parseTaishinCreditCardData,
  taishinConfigSchema,
} from "./taishin";
export type {
  TaishinConfig,
  TaishinCreditCardData,
  TaishinCreditCardPayloads,
} from "./taishin";
import { taishinConfigSchema } from "./taishin";

export { ctbcConfigSchema, parseCtbcData, parseCtbcConfig } from "./ctbc";
export type { CtbcConfig, CtbcData, CtbcPayloads } from "./ctbc";
export {
  classifyCtbcError,
  createCtbcConnector,
  CtbcConnectionError,
  CtbcVerificationRequiredError,
  encryptCtbcPin,
  requireCtbcCredentials,
} from "./ctbc-mobile-api";
export type { CtbcFetch } from "./ctbc-mobile-api";
import { ctbcConfigSchema } from "./ctbc";

export { obankConfigSchema, parseObankConfig, parseObankData } from "./obank";
export type { ObankConfig, ObankData, ObankPayloads } from "./obank";
export {
  classifyObankError,
  createObankConnector,
  ObankCaptchaRejectedError,
  ObankConnectionError,
  ObankCredentialRejectedError,
  ObankMultipleLoginError,
  ObankProtocolError,
  ObankVerificationRequiredError,
  prepareObankCaptcha,
  requireObankCredentials,
} from "./obank-mobile-api";
export type {
  ObankCaptchaChallenge,
  ObankFetch,
  ObankSyncOptions,
} from "./obank-mobile-api";
import { obankConfigSchema } from "./obank";

const invoiceRecordSchema = z.object({
  sourceId: z.string().min(1),
  invoiceNumber: z.string().optional(),
  invoiceDate: z.string().min(1),
  sellerName: z.string().optional(),
  amount: z.number().int().nonnegative(),
  raw: z.unknown().optional(),
});

export const invoiceConfigSchema = z.object({
  records: z.array(invoiceRecordSchema).default([]),
  protocol: z
    .enum(["legacy", "v2"])
    .default("v2")
    .transform(() => "v2" as const),
  mobile: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  mobileBarcode: z.string().min(1).optional(),
  userToken: z.string().min(1).optional(),
  androidId: z.string().min(1).optional(),
  ptoken: z.string().optional(),
  loginClientCode: z.string().optional(),
  loginType: z.number().int().min(0).max(9).default(0),
  sid: z.string().optional(),
  token: z.string().optional(),
  iv: z.string().optional(),
  svrCode: z.string().optional(),
  loginAppId: z.string().optional(),
  loginLiat: z.number().int().optional(),
  loginSsMe: z.string().optional(),
  ltoken: z.string().optional(),
  hkey: z.string().optional(),
  serverTimeOffset: z.number().int().optional(),
  fetchDetails: z.boolean().default(true),
});

export type InvoiceConfig = z.infer<typeof invoiceConfigSchema>;
export function parseInvoiceConfig(config: unknown) {
  return invoiceConfigSchema.parse(config);
}

export const einvoiceConnector: Connector<
  InvoiceConfig,
  Omit<Invoice, "id" | "connectorId">
> = {
  id: "einvoice",
  name: "E-Invoice",
  async sync(config, cursor) {
    if (config.mobile && config.password) {
      return syncTaiwanEInvoices(config, cursor);
    }

    return {
      records: config.records.map((record) => ({
        sourceId: record.sourceId,
        invoiceNumber: record.invoiceNumber,
        invoiceDate: record.invoiceDate,
        sellerName: record.sellerName,
        amount: record.amount,
        raw: record.raw ?? record,
      })),
      cursor,
    };
  },
};

async function syncTaiwanEInvoices(config: InvoiceConfig, cursor?: string) {
  return syncTaiwanEInvoicesV2(config, cursor);
}

async function syncTaiwanEInvoicesV2(config: InvoiceConfig, cursor?: string) {
  if (!config.mobile || !config.password) {
    throw new Error("新版電子發票需要手機號碼與密碼。");
  }

  const client = new EInvoiceV2Client({
    androidId: config.androidId,
    loginClientCode: config.loginClientCode,
    ptoken: config.ptoken,
  });
  let session: EInvoiceV2Session;
  if (
    config.sid &&
    config.token &&
    config.loginAppId &&
    config.loginLiat != null &&
    config.loginSsMe
  ) {
    session = {
      sid: config.sid,
      token: config.token,
      iv: config.iv,
      svrCode: config.svrCode,
      clientCode: config.loginClientCode,
      loginAppId: config.loginAppId,
      loginLiat: config.loginLiat,
      loginSsMe: config.loginSsMe,
      ltoken: config.ltoken,
      hkey: config.hkey,
      serverTimeOffset: config.serverTimeOffset,
      carrierCode: config.mobileBarcode,
    };
  } else {
    try {
      session = await client.login({
        mobile: config.mobile,
        password: config.password,
        androidId: config.androidId,
        loginClientCode: config.loginClientCode,
        ptoken: config.ptoken,
        loginType: config.loginType,
        carrierCode: config.mobileBarcode,
      });
    } catch (error) {
      throw new Error(
        `電子發票登入失敗：${error instanceof Error ? error.message : "發生未知錯誤"}`,
      );
    }
    Object.assign(config, session);
    config.loginClientCode = session.clientCode ?? config.loginClientCode;
    config.mobileBarcode = session.carrierCode ?? config.mobileBarcode;
  }

  const carrierCode = config.mobileBarcode ?? session.carrierCode;
  if (!carrierCode) throw new Error("新版電子發票登入未回傳手機條碼。");
  session.carrierCode = carrierCode;

  const now = new Date();
  const currentIndex = currentPeriodIndex(now);
  const periodIndexes = Array.from(
    { length: EINVOICE_SYNC_PERIODS },
    (_, index) => currentIndex - index,
  );
  const records: Array<Omit<Invoice, "id" | "connectorId">> = [];
  const invoiceLineItems: Array<
    Omit<InvoiceLineItem, "id" | "connectorId" | "invoiceId">
  > = [];
  let detailErrorCount = 0;

  for (const periodIndex of periodIndexes) {
    const period = periodFromIndex(periodIndex, now);
    const payload = await client.queryCarrierInvoices(
      session,
      period.startDate,
      period.endDate,
    );
    const invoices = getV2Invoices(payload);
    for (const invoice of invoices) {
      const sourceId = invoiceSourceId(
        invoice.invNum,
        invoice.invDate,
        invoice.id,
      );
      let detail: unknown;
      let detailItems: ReturnType<typeof getV2DetailItems> = [];
      if (config.fetchDetails && invoice.invNum && invoice.detailInvDate) {
        try {
          detail = await client.queryCarrierInvoiceDetail(
            session,
            invoice.invNum,
            invoice.detailInvDate,
          );
          detailItems = getV2DetailItems(detail);
          detailItems.forEach((item, index) => {
            invoiceLineItems.push({
              invoiceSourceId: sourceId,
              sourceId: item.id || String(index + 1),
              lineNumber: index + 1,
              description: item.description || "未命名品項",
              quantity: parseOptionalNumber(item.quantity),
              unitPrice: parseOptionalInteger(item.unitPrice),
              amount: parseRequiredInteger(item.amount),
              raw: item,
            });
          });
        } catch (error) {
          detailErrorCount += 1;
          detail = {
            error:
              error instanceof Error
                ? error.message
                : "Unable to fetch invoice detail.",
          };
        }
      }
      records.push({
        sourceId,
        invoiceNumber: invoice.invNum || undefined,
        invoiceDate: normalizeInvoiceDate(invoice.invDate),
        sellerName: invoice.sellerName,
        amount: Math.max(0, Math.trunc(invoice.amount)),
        raw: { invoice, period, detail, detailItems },
      });
    }
  }

  return {
    records: dedupeInvoices(records),
    invoiceLineItems: dedupeInvoiceLineItems(invoiceLineItems),
    detailErrorCount,
    cursor: JSON.stringify({
      syncedAt: now.toISOString(),
      previousSyncedAt: cursor ? readPreviousSyncedAt(cursor) : undefined,
      latestPeriodIndex: currentIndex,
      syncedPeriods: EINVOICE_SYNC_PERIODS,
    }),
  };
}

function getV2Invoices(payload: unknown) {
  const rows = findArray(payload, [
    "invoices",
    "invoice",
    "invoiceList",
    "invList",
    "headers",
    "header",
    "invoiceHeaders",
    "details",
    "result",
    "data",
    "list",
  ]);
  return rows
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item, index) => {
      const invoiceDate = parseV2InvoiceDate(
        item.invDate ?? item.invoiceDate ?? item.date,
      );
      return {
        id:
          firstStringValue(item.invNum, item.invoiceNumber, item.id) ||
          `v2-${index}`,
        invNum: firstStringValue(item.invNum, item.invoiceNumber),
        invDate: invoiceDate.iso,
        detailInvDate: invoiceDate.apiDate,
        sellerName:
          firstStringValue(item.sellerName, item.seller, item.sellerNameE) ||
          "未知商店",
        amount: parseNumericValue(item.amount, item.total, item.totalAmount),
        randomNumber: firstStringValue(item.randomNumber),
        invPeriod: firstStringValue(item.invPeriod, item.invTerm),
        sellerID: firstStringValue(item.sellerID, item.sellerBan),
        encrypt: firstStringValue(item.encrypt),
        isQrCode: item.isQrCode === true || item.isScanInv === true,
        isBuyerType: item.isBuyerType === true || item.isBuyerType === "Y",
      };
    });
}

function parseV2InvoiceDate(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    const iso = normalizeInvoiceDate(value);
    return { iso, apiDate: formatTaipeiApiDate(new Date(iso)) };
  }

  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const epoch = Number(record?.time);
  if (Number.isFinite(epoch) && epoch > 0) {
    const date = new Date(epoch);
    return { iso: date.toISOString(), apiDate: formatTaipeiApiDate(date) };
  }

  const rocYear = Number(record?.year);
  const month = Number(record?.month);
  const day = Number(record?.date);
  if (
    Number.isFinite(rocYear) &&
    Number.isFinite(month) &&
    Number.isFinite(day)
  ) {
    const year = rocYear < 1911 ? rocYear + 1911 : rocYear;
    const apiDate = `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
    return { iso: normalizeInvoiceDate(apiDate), apiDate };
  }

  return { iso: "", apiDate: "" };
}

function formatTaipeiApiDate(date: Date) {
  if (Number.isNaN(date.getTime())) return "";
  const taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${taipei.getUTCFullYear()}/${String(taipei.getUTCMonth() + 1).padStart(2, "0")}/${String(taipei.getUTCDate()).padStart(2, "0")}`;
}

function getV2DetailItems(payload: unknown) {
  const rows = findArray(payload, [
    "details",
    "items",
    "itemList",
    "invoiceDetails",
    "result",
    "data",
    "list",
  ]);
  return rows
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object"),
    )
    .map((item, index) => ({
      id: firstStringValue(item.rowNum, item.id) || String(index),
      amount: firstStringValue(item.amount, item.subtotal),
      description:
        firstStringValue(item.description, item.itemName, item.name) ||
        "未命名品項",
      quantity: firstStringValue(item.quantity, item.qty),
      unitPrice: firstStringValue(item.unitPrice, item.price),
    }));
}

function findArray(value: unknown, keys: string[], depth = 0): unknown[] {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const child of Object.values(record)) {
    const found = findArray(child, keys, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function firstStringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return "";
}

function parseNumericValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(String(value ?? "").replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseOptionalNumber(value: string) {
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value: string) {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function parseRequiredInteger(value: string) {
  return parseOptionalInteger(value) ?? 0;
}

function readPreviousSyncedAt(cursor: string) {
  try {
    const parsed = JSON.parse(cursor) as { syncedAt?: unknown };
    return typeof parsed.syncedAt === "string" ? parsed.syncedAt : undefined;
  } catch {
    return undefined;
  }
}

function invoiceSourceId(invNum: string, invDate: string, fallback: string) {
  return [invNum || fallback, invDate].filter(Boolean).join(":");
}

function normalizeInvoiceDate(value: string) {
  const normalized = value.trim().replace(/\//g, "-");
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00`
    : normalized.replace(" ", "T");
  const date = new Date(withTime);
  if (Number.isNaN(date.getTime())) return normalized || value;
  return date.toISOString();
}

function dedupeInvoices(records: Array<Omit<Invoice, "id" | "connectorId">>) {
  const bySourceId = new Map<string, Omit<Invoice, "id" | "connectorId">>();
  for (const record of records) {
    bySourceId.set(record.sourceId, record);
  }
  return Array.from(bySourceId.values());
}

function dedupeInvoiceLineItems(
  items: Array<Omit<InvoiceLineItem, "id" | "connectorId" | "invoiceId">>,
) {
  const bySourceId = new Map<
    string,
    Omit<InvoiceLineItem, "id" | "connectorId" | "invoiceId">
  >();
  for (const item of items) {
    bySourceId.set(`${item.invoiceSourceId}:${item.sourceId}`, item);
  }
  return Array.from(bySourceId.values());
}

export const connectorConfigSchemas = {
  einvoice: invoiceConfigSchema,
  tdcc: tdccConfigSchema,
  esun: esunConfigSchema,
  cathaybk: cathaybkConfigSchema,
  sinopac: sinopacConfigSchema,
  taishin: taishinConfigSchema,
  ctbc: ctbcConfigSchema,
  obank: obankConfigSchema,
} satisfies Record<ConnectorId, z.ZodTypeAny>;

export function parseConnectorConfig(
  connectorId: ConnectorId,
  config: unknown,
) {
  return connectorConfigSchemas[connectorId].parse(config);
}
