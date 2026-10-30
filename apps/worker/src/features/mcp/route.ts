import {
  createMcpHandler,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { honoFactory } from "../../platform/hono";
import { isDemoMode } from "../../platform/http";

// 身分驗證由 Composition Root 掛在 /mcp 的 accessMiddleware 負責；
// 這裡只註冊唯讀工具，不提供任何寫入能力。
function createServer(accessEmail: string | undefined) {
  const server = new McpServer({ name: "all-set-tw", version: "0.1.0" });

  server.registerTool(
    "whoami",
    {
      description: "回傳目前透過 Cloudflare Access 登入的使用者。",
      annotations: { readOnlyHint: true },
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
  return createMcpHandler(() => createServer(accessEmail)).fetch(request);
});
