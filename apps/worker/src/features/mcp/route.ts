import {
  createMcpHandler,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { sanitizeDatabaseError } from "../../db";
import { honoFactory } from "../../platform/hono";
import { isDemoMode } from "../../platform/http";
import {
  getFinancialOverview,
  getMonthlyCashFlow,
  getUpcomingPayments,
  listAccounts,
  listInvestmentHoldings,
  searchActivities,
} from "./service";

const isoDate = z.iso.date();
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** 以 JSON 文字回傳；錯誤只回通用訊息，細節消毒後寫入 log。 */
async function jsonResult(tool: string, load: () => Promise<unknown>) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await load()) }],
    };
  } catch (error) {
    const safeError = sanitizeDatabaseError(error);
    console.error(
      JSON.stringify({
        event: "mcp_tool_failed",
        tool,
        message:
          safeError instanceof Error ? safeError.message : String(safeError),
      }),
    );
    return {
      isError: true,
      content: [{ type: "text" as const, text: "讀取資料失敗，請稍後再試。" }],
    };
  }
}

// 身分驗證由 Composition Root 掛在 /mcp 的 accessMiddleware 負責；
// 這裡只註冊唯讀工具，不提供任何寫入能力。
function createServer(db: D1Database, accessEmail: string | undefined) {
  const server = new McpServer({ name: "all-set-tw", version: "0.1.0" });

  server.registerTool(
    "whoami",
    {
      description: "回傳目前透過 Cloudflare Access 登入的使用者。",
      annotations: READ_ONLY,
    },
    async () => ({
      content: [
        {
          type: "text",
          text: accessEmail
            ? `已登入：${accessEmail}`
            : "已通過驗證，但沒有可顯示的 email（本機開發或 service token）。",
        },
      ],
    }),
  );

  server.registerTool(
    "get_financial_overview",
    {
      description:
        "目前淨資產總覽（新台幣），與 App 總覽相同計算：netWorth = assets − creditCardDebt − loanDebt。creditCardDebt 為負數表示信用卡溢繳餘額，已計入淨資產；missingExchangeRateCurrencies 列出缺匯率而未計入的幣別。",
      annotations: READ_ONLY,
    },
    () => jsonResult("get_financial_overview", () => getFinancialOverview(db)),
  );

  server.registerTool(
    "list_accounts",
    {
      description:
        "列出銀行存款、信用卡、貸款帳戶的最新餘額（原幣別），以及手動記錄的其他資產。信用卡與貸款的欠款以負數表示；帳號只顯示末四碼。",
      annotations: READ_ONLY,
    },
    () => jsonResult("list_accounts", () => listAccounts(db)),
  );

  server.registerTool(
    "list_investment_holdings",
    {
      description:
        "列出股票、ETF、基金、加密貨幣等投資部位的最新持倉（原幣別市值與數量）。",
      annotations: READ_ONLY,
    },
    () =>
      jsonResult("list_investment_holdings", () => listInvestmentHoldings(db)),
  );

  server.registerTool(
    "get_monthly_cash_flow",
    {
      description:
        "指定月份的收入、支出總額與各分類金額（新台幣，與 App 活動頁相同計算：發票與刷卡配對不重複計入、排除統計的項目不計、退款沖減支出）。",
      inputSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional()
          .describe("YYYY-MM；省略時為台北時間本月。"),
      }),
      annotations: READ_ONLY,
    },
    ({ month }) =>
      jsonResult("get_monthly_cash_flow", () => getMonthlyCashFlow(db, month)),
  );

  server.registerTool(
    "search_activity",
    {
      description:
        "以關鍵字搜尋銀行交易、刷卡與電子發票（含品項），由新到舊最多回傳 30 筆；truncated 為 true 表示還有更多結果，可縮小日期範圍再查。金額負數為支出。",
      inputSchema: z
        .object({
          query: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("關鍵字，例如商家、品項或帳戶名稱。"),
          from: isoDate.optional().describe("起始日期 YYYY-MM-DD（含）。"),
          to: isoDate.optional().describe("結束日期 YYYY-MM-DD（含）。"),
          source: z
            .enum(["all", "bank", "card", "invoice"])
            .optional()
            .describe("bank 為存款帳戶、card 為信用卡、invoice 為電子發票。"),
          flow: z.enum(["all", "income", "expense"]).optional(),
        })
        .refine(
          (value) => !value.from || !value.to || value.from <= value.to,
          "from 不可晚於 to。",
        ),
      annotations: READ_ONLY,
    },
    (input) => jsonResult("search_activity", () => searchActivities(db, input)),
  );

  server.registerTool(
    "get_upcoming_payments",
    {
      description:
        "5 天內到期或已逾期的信用卡與貸款繳款提醒。state：due 待繳、overdue 已過期限、confirm 狀態不明請確認、collection_failed 扣款未完成、insufficient_funds 扣款帳戶餘額不足（shortfall 為差額）。扣款帳戶餘額足夠的款項不列出。",
      annotations: READ_ONLY,
    },
    () => jsonResult("get_upcoming_payments", () => getUpcomingPayments(db)),
  );

  return server;
}

export const mcpRoutes = honoFactory.createApp();

mcpRoutes.all("/", (c) => {
  // Demo 站不開放 MCP，避免公開可被任意呼叫的端點。
  if (isDemoMode(c.env)) return c.notFound();

  const request = c.req.raw;
  const rejected = originValidationResponse(request, [
    new URL(request.url).hostname,
  ]);
  if (rejected) return rejected;

  const accessEmail = c.get("accessEmail");
  return createMcpHandler(() => createServer(c.env.DB, accessEmail)).fetch(
    request,
  );
});
