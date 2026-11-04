import type { Hono } from "hono";
import {
  CLASSIFICATION_RULE_FIELDS,
  CLASSIFICATION_RULE_OPERATORS,
  connectorCatalog,
  type ConnectorCredentialField,
  type ConnectorId,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import type { AppBindings, Env } from "../../platform/env";
import { manualSyncBody } from "../sync/registry";

/** MCP 透過同一個 /api app 呼叫網頁版的全部功能；只需要 fetch 與路由清單。 */
export type ApiApp = Pick<Hono<AppBindings>, "fetch" | "routes">;
export type ApiExecutionContext = Parameters<ApiApp["fetch"]>[2];

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const WRITE_API_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

export type ApiCallInput = {
  method: ApiMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
};

// 只轉送 Access 身分；/api 的 accessMiddleware 會再驗證一次。
const FORWARDED_REQUEST_HEADERS = ["Cf-Access-Jwt-Assertion", "Cookie"];
const RETURNED_RESPONSE_HEADERS = [
  "X-Has-More",
  "X-Next-Cursor",
  "Retry-After",
];

const MONTH_RANGE =
  "query：month=YYYY-MM，或 from、to=YYYY-MM；三者皆省略時以 limit、cursor 分頁（cursor 取自回應的 X-Next-Cursor）。";
const PAGINATION =
  "query：limit、cursor 分頁（cursor 取自回應的 X-Next-Cursor）。";
const SCHEDULE_FIELDS =
  "intervalMinutes 為支援的同步間隔分鐘數，preferredTime 為 HH:mm，preferredWeekdays 為 0–6（0 為週日）";

const ENDPOINT_NOTES: Record<string, string> = {
  "GET /runtime": "部署模式（是否為 Demo）。",
  "GET /summary": "總覽頁摘要。",
  "GET /exchange-rates": "目前匯率。",
  "GET /exchange-rates/currencies": "已記錄的幣別。",
  "POST /exchange-rates/refresh": "立即更新匯率。",
  "GET /manual-assets": "手動記錄的其他資產。",
  "POST /manual-assets":
    "新增手動資產。body：name、category、note?、currency（TWD、USD、JPY、EUR，預設 TWD）、value、date（YYYY-MM-DD）。",
  "PUT /manual-assets/:id":
    "修改手動資產。body 為 POST 欄位的任意子集；value 與 date 須同時提供，note 可為 null。",
  "DELETE /manual-assets/:id": "刪除手動資產。",
  "GET /manual-assets/:id/history": "手動資產的歷史價值。",
  "POST /manual-assets/:id/history": "新增或覆寫某日價值。body：value、date。",
  "DELETE /manual-assets/:id/history/:date":
    "刪除某日價值（date 為 YYYY-MM-DD）。",
  "GET /invoices": `電子發票。${MONTH_RANGE}`,
  "GET /invoice-detail": "發票明細。query：invoiceId。",
  "GET /invoices/:invoiceId": "發票明細。",
  "PATCH /invoices/:invoiceId/calculation":
    "設定發票是否排除統計。body：excludedFromCalculation（boolean）。",
  "GET /classification/ai": "AI 自動分類狀態。",
  "PUT /classification/ai": "開關 AI 自動分類。body：enabled（boolean）。",
  "POST /classification/ai/backfill": "以 AI 分類過去的活動（須先開啟）。",
  "DELETE /classification/ai/results": "清除所有 AI 分類結果。",
  "GET /classification/categories": "分類清單。",
  "POST /classification/categories": "新增分類。body：label（最多 24 字）。",
  "GET /classification/rules": "分類規則。",
  "POST /classification/rules": `新增分類規則。body：categoryId、field（${CLASSIFICATION_RULE_FIELDS.join("、")}）、operator（${CLASSIFICATION_RULE_OPERATORS.join("、")}）、pattern、priority?（0–10000）、description?、excludedFromCalculation?、targetType?（bank_transaction）。`,
  "PUT /classification/rules/:ruleId":
    "修改分類規則。body 為 categoryId、operator、pattern、priority、enabled、description（可為 null）、excludedFromCalculation 的任意非空子集。",
  "DELETE /classification/rules/:ruleId": "刪除分類規則。",
  "PUT /classification/rules/order":
    "重新排序規則。body：ruleIds（完整的規則 ID 陣列，依新順序）。",
  "PUT /classification/overrides/:targetType/*":
    "手動指定單筆交易分類。路徑為 /classification/overrides/bank_transaction/<交易 ID>，body：categoryId。",
  "DELETE /classification/overrides/:targetType/*":
    "移除單筆交易的手動分類，路徑同上。",
  "GET /activity/search":
    "搜尋活動。query：q（必填）、from?、to?（YYYY-MM-DD）、source?（all、bank、card、invoice）、flow?（all、income、expense）、category?、cursor?。",
  "GET /activity/invoice-mappings": `發票與交易的手動配對。${MONTH_RANGE}`,
  "PUT /activity/invoice-mappings/:invoiceId":
    "手動配對發票與交易。body：transactionId。",
  "DELETE /activity/invoice-mappings/:invoiceId": "取消發票的手動配對。",
  "GET /bank/accounts": "存款、信用卡與貸款帳戶及最新餘額。",
  "PUT /bank/accounts/:id/payment-account":
    "設定信用卡或貸款的扣款帳戶。body：paymentAccountId（存款帳戶 ID，或 null 取消）。",
  "DELETE /bank/accounts/:id/payment-account": "取消扣款帳戶設定。",
  "GET /bank": `銀行帳戶與交易。${MONTH_RANGE}`,
  "GET /bank/bills": `信用卡帳單。${MONTH_RANGE}`,
  "PATCH /bank/transactions/:transactionId/calculation":
    "設定交易是否排除統計。body：excludedFromCalculation（boolean）。",
  "PUT /bank/transactions/:transactionId/note":
    "設定交易備註，會覆寫原有內容。body：note（字串，最多 500 字；空字串清除備註）。",
  "GET /investments": `最新投資持倉。${PAGINATION}`,
  "GET /investment-transactions": `投資交易紀錄。${MONTH_RANGE}`,
  "GET /history/net-worth/chart": "淨資產歷史圖表資料。",
  "GET /history/net-worth": `淨資產歷史明細。${PAGINATION}`,
  "POST /history/net-worth/rebuild-bank":
    "依交易重建存款歷史餘額。body：from?、to?（YYYY-MM-DD）。",
  "GET /notifications/config": "推播通知設定。",
  "POST /notifications/subscriptions":
    "新增瀏覽器推播訂閱；需要瀏覽器產生的 PushSubscription，AI 助理通常不使用。",
  "DELETE /notifications/subscriptions/:id": "刪除推播訂閱。",
  "PUT /notifications/preferences":
    "通知偏好。body：success、failed、needsUserAction、paymentDue?（皆為 boolean）。",
  "POST /notifications/test": "傳送測試推播。",
  "GET /connectors/:connectorId/settings":
    "資料來源設定狀態（不含帳密）。connectorId 見 connectors。",
  "PUT /connectors/:connectorId/settings":
    "儲存資料來源設定。body：config（物件，帳密欄位見 connectors 的 credentialFields）。",
  "POST /connectors/einvoice/sync": "開始電子發票同步（Queue 背景執行）。",
  "POST /connectors/tdcc/sync":
    "開始集保同步（Queue 背景執行）。body：otp?、otpChannel?（email、sms）。",
  "POST /connectors/tdcc/sync/investments": "只同步集保持倉，body 同上。",
  "POST /connectors/tdcc/sync/bank": "只同步集保交割帳戶，body 同上。",
  "POST /connectors/tdcc/sync/trades": "只同步集保交易，body 同上。",
  "GET /sync-schedule": "預設排程。",
  "PUT /sync-schedule": `修改預設排程。body：intervalMinutes、preferredTime、preferredWeekdays（${SCHEDULE_FIELDS}）。`,
  "GET /sync-jobs": "各資料來源的排程與上次同步狀態。",
  "PATCH /sync-jobs/:connectorId/:scope": `修改單一來源排程，scope 為 all。body：enabled?、nextRunAt?（ISO 時間）、scheduleMode?（inherit、custom）、intervalMinutes?、preferredTime?、preferredWeekdays?（${SCHEDULE_FIELDS}）。`,
  "GET /sync-reports/latest": "最新一次排程同步報告。",
  "GET /sync-reports/:batchId/activities": "同步報告的活動變化明細。",
  "POST /ocr/validate-number": "需要 image/jpeg body，無法透過 MCP 呼叫。",
};

const CONNECTOR_ROUTE = /^\/connectors\/([a-z0-9]+)\/(sync|captcha)$/;

function connectorRouteNote(path: string) {
  const match = CONNECTOR_ROUTE.exec(path);
  const connectorId = match?.[1];
  if (!match || !connectorId || !(connectorId in connectorCatalog)) return;
  const id = connectorId as ConnectorId;
  const title = connectorCatalog[id].title;
  if (match[2] === "captcha")
    return {
      note: `取得${title}的登入驗證碼，回應含驗證碼圖片；辨識後將答案帶入 POST /connectors/${id}/sync。`,
    };
  const body = manualSyncBody(id);
  return body
    ? {
        note: `同步${title}。不帶 body 時交由 Queue 背景執行；帶驗證碼或 OTP 時在請求內完成登入與同步。`,
        body: z.toJSONSchema(body.schema, {
          io: "input",
          unrepresentable: "any",
        }),
      }
    : { note: `同步${title}（Queue 背景執行）。` };
}

export function listApiEndpoints(api: ApiApp) {
  const seen = new Set<string>();
  const endpoints = [];
  for (const { method, path } of api.routes) {
    if (!(API_METHODS as readonly string[]).includes(method)) continue;
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({
      method,
      path,
      ...(connectorRouteNote(path) ?? { note: ENDPOINT_NOTES[key] }),
    });
  }
  return {
    usage:
      "GET 以 query_api 呼叫，其餘方法以 call_api 呼叫；路徑中的 :param 替換為實際值。回應與網頁版 /api 相同，錯誤為 { success: false, error: { code, message } }。",
    endpoints,
    connectors: Object.values(connectorCatalog).map((entry) => ({
      id: entry.id,
      title: entry.title,
      credentialFields: entry.credentialFields.map(
        ({ key, type, options }: ConnectorCredentialField) => ({
          key,
          type,
          ...(options ? { options: options.map(({ value }) => value) } : {}),
        }),
      ),
    })),
  };
}

/** 在同一個 Worker 內呼叫 /api，沿用網頁版的驗證、授權與錯誤處理。 */
export async function callApi(
  api: ApiApp,
  source: Request,
  env: Env,
  executionCtx: ApiExecutionContext,
  input: ApiCallInput,
) {
  // 只替換 pathname，避免 "//host" 之類的路徑改變請求的主機。
  const url = new URL(source.url);
  url.pathname = input.path;
  url.search = "";
  for (const [name, value] of Object.entries(input.query ?? {}))
    url.searchParams.set(name, String(value));

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = source.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = input.method !== "GET" && input.body !== undefined;
  if (hasBody) headers.set("Content-Type", "application/json");

  const response = await api.fetch(
    new Request(url, {
      method: input.method,
      headers,
      body: hasBody ? JSON.stringify(input.body) : undefined,
    }),
    env,
    executionCtx,
  );
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 回應以文字回傳。
  }
  const returnedHeaders = Object.fromEntries(
    RETURNED_RESPONSE_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value ? [[name, value]] : [];
    }),
  );
  return { status: response.status, headers: returnedHeaders, body };
}
