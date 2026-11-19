// 截圖與 docs/006-mcp.md 共用根目錄 images/，更新截圖時兩邊同時生效。
import authorizeClientImage from "../../../../../../images/mcp-authorize-client.png";
import chatgptAddServerImage from "../../../../../../images/mcp-chatgpt-add-server.png";
import chatgptDcrImage from "../../../../../../images/mcp-chatgpt-dcr.png";
import managedOauthImage from "../../../../../../images/mcp-managed-oauth.png";

/** 指令與文件使用的 MCP 伺服器名稱，與 docs/006-mcp.md 一致。 */
export const MCP_SERVER_NAME = "all-set";

/** MCP 端點與網頁版同一個 Worker，因此直接由目前網址組出。 */
export function mcpEndpoint(origin: string) {
  return `${origin}/mcp`;
}

/** 上游 repo 的 MCP 文件；只在 Demo 模式無法於 App 內設定時使用。 */
export function mcpDocsUrl(repository: string) {
  return `https://github.com/${repository}/blob/main/docs/006-mcp.md`;
}

export interface McpScreenshot {
  /** 展開截圖的按鈕文字。 */
  label: string;
  src: string;
  alt: string;
  width: number;
  height: number;
}

export const MANAGED_OAUTH_SCREENSHOT: McpScreenshot = {
  label: "查看 Managed OAuth 設定畫面",
  src: managedOauthImage,
  alt: "Access Application 的 Additional settings：開啟 Managed OAuth、允許 localhost 與 loopback、Grant session 1 month",
  width: 2000,
  height: 973,
};

const AUTHORIZE_CLIENT_SCREENSHOT: McpScreenshot = {
  label: "查看授權畫面",
  src: authorizeClientImage,
  alt: "Cloudflare Access 的 Authorize Client 頁面，確認帳號與用戶端後點擊 Allow",
  width: 999,
  height: 1046,
};

/** 啟用 MCP 的一次性 Cloudflare 設定，與 docs/006-mcp.md「一次性設定：開啟 Managed OAuth」一致。 */
export interface McpLink {
  label: string;
  href: string;
}

/**
 * Cloudflare 主控台的 Access Applications 列表（Zero Trust → Access controls → Applications），
 * 與 Cloudflare 官方文件使用的深層連結相同；:account 由主控台帶入目前帳號，多帳號時先選擇。
 * 沒有 Application 的內部 ID，無法直接開到單一 Application 的設定頁。
 */
export const CLOUDFLARE_ACCESS_APPS_URL =
  "https://dash.cloudflare.com/?to=/:account/one/access/apps";

const ACCESS_APPS_LINK: McpLink = {
  label: "開啟 Cloudflare Applications 頁面",
  href: CLOUDFLARE_ACCESS_APPS_URL,
};

export function managedOauthSteps(
  host: string,
): { text: string; link?: McpLink }[] {
  return [
    {
      text: `開啟 Cloudflare 的 Applications 頁面（Zero Trust → Access controls → Applications），點擊目的地為 ${host} 的 Application。`,
      link: ACCESS_APPS_LINK,
    },
    {
      text: "切換到 Additional settings，點擊上方的 OAuth 篩選，開啟 Managed OAuth 並展開設定。",
    },
    {
      text: "開啟 Allow localhost clients 與 Allow loopback clients；Grant session duration 可選 1 month，點擊 Save。",
    },
  ];
}

export interface McpGuideStep {
  title: string;
  detail?: string;
  link?: McpLink;
  copy?: { label: string; text: string; mono?: boolean };
  screenshots?: McpScreenshot[];
}

export interface McpSetupPrompt {
  /** 提示詞開頭的對象，例如「把這段話貼給 Codex」。 */
  audience: string;
  /** 貼給能自行執行指令的 AI 助理，由它完成新增、登入與確認。 */
  text: string;
  /** 過程中仍需使用者親自處理的事。 */
  userActions: string[];
  screenshots?: McpScreenshot[];
}

export interface McpClientGuide {
  id: "codex" | "claude-code" | "chatgpt" | "other";
  label: string;
  prompt?: McpSetupPrompt;
  /** 手動步驟；有提示詞時作為助理無法自行設定時的備案。 */
  steps?: McpGuideStep[];
  stepsTitle?: string;
  note?: string;
}

export function mcpClientGuides(endpoint: string): McpClientGuide[] {
  const name = MCP_SERVER_NAME;
  return [
    {
      id: "codex",
      label: "Codex",
      prompt: {
        audience: "Codex",
        text: [
          "請幫我把「不用記帳」的 MCP 伺服器加到 Codex：",
          "",
          `1. 執行 \`codex mcp add ${name} --url ${endpoint}\`。`,
          `2. 執行 \`codex mcp login ${name}\`。這個指令會開啟瀏覽器並等待我完成授權，請給它至少 5 分鐘，並提醒我在 Authorize Client 頁面點擊 Allow。`,
          "3. 這兩個指令需要修改 ~/.codex/config.toml 並連上網路；如果被沙盒擋住，請向我申請權限後再執行。",
          `4. 完成後提醒我開新的對話，再問「用 ${name} 的 whoami 看我是誰」確認連線。`,
        ].join("\n"),
        userActions: [
          "允許 Codex 執行指令（需要修改設定檔與連網）",
          "在瀏覽器的 Authorize Client 頁面點擊 Allow",
          `開新的對話後才會載入 ${name} 的工具`,
        ],
        screenshots: [AUTHORIZE_CLIENT_SCREENSHOT],
      },
    },
    {
      id: "claude-code",
      label: "Claude Code",
      prompt: {
        audience: "Claude Code",
        text: [
          "請幫我把「不用記帳」的 MCP 伺服器加到 Claude Code：",
          "",
          `1. 執行 \`claude mcp add --transport http --scope user ${name} ${endpoint}\`，讓所有專案都能使用。`,
          `2. 新增後提醒我在 Claude Code 輸入 /mcp，選擇 ${name} 後選 Authenticate，並在瀏覽器的 Authorize Client 頁面點擊 Allow；若 /mcp 還看不到 ${name}，請我重新啟動 Claude Code。`,
          `3. 登入完成後，呼叫 ${name} 的 whoami 確認連線。`,
        ].join("\n"),
        userActions: [
          "允許 Claude Code 執行新增指令",
          `輸入 /mcp → ${name} → Authenticate，並在瀏覽器點擊 Allow`,
        ],
        screenshots: [AUTHORIZE_CLIENT_SCREENSHOT],
      },
    },
    {
      id: "chatgpt",
      label: "ChatGPT",
      note: "使用工作區帳號時，可能需要管理員開放建立 MCP 外掛程式的權限。",
      steps: [
        {
          title: "新增自訂 MCP 伺服器",
          detail:
            "開啟「外掛程式」，點擊右上角「新增 → 新增自訂 MCP 伺服器」，貼上伺服器 URL，身分驗證選擇 OAuth。",
          copy: { label: "伺服器 URL", text: endpoint },
          screenshots: [
            {
              label: "查看新增伺服器畫面",
              src: chatgptAddServerImage,
              alt: "ChatGPT 新增自訂 MCP 伺服器：填入名稱與伺服器 URL，在進階 OAuth 設定複製回呼網址",
              width: 1920,
              height: 1482,
            },
          ],
        },
        {
          title: "把回呼網址加入 Access",
          detail:
            "展開「進階 OAuth 設定」，註冊方式先切換到「使用者自訂的 OAuth 用戶端」，複製回呼網址（https://chatgpt.com/connector/oauth/…），貼到 Cloudflare Access Managed OAuth 的 Allowed redirect URIs 並儲存。",
          link: ACCESS_APPS_LINK,
          screenshots: [MANAGED_OAUTH_SCREENSHOT],
        },
        {
          title: "改回動態註冊並建立",
          detail:
            "註冊方式改回「動態用戶端註冊 (DCR)」，不需填寫用戶端 ID 或密鑰。勾選「我已瞭解並希望繼續」後點擊「建立為外掛程式」，依提示登入並點擊 Allow。",
          screenshots: [
            {
              label: "查看註冊方式畫面",
              src: chatgptDcrImage,
              alt: "ChatGPT 進階 OAuth 設定的註冊方式選擇動態用戶端註冊 (DCR)",
              width: 818,
              height: 595,
            },
            AUTHORIZE_CLIENT_SCREENSHOT,
          ],
        },
      ],
    },
    {
      id: "other",
      label: "其他",
      prompt: {
        audience: "AI 助理",
        text: [
          "請幫我把「不用記帳」的 MCP 伺服器加到你的 MCP 設定：",
          "",
          `- 名稱：${name}`,
          `- URL：${endpoint}`,
          "- 傳輸方式：Streamable HTTP",
          "- 身分驗證：OAuth（Cloudflare Access，支援動態用戶端註冊，不需要用戶端 ID 或密鑰）",
          "",
          `請用你支援的方式新增（例如 CLI 指令或設定檔）；需要我在瀏覽器完成登入時，告訴我該怎麼做。完成後呼叫 ${name} 的 whoami 確認連線。`,
        ].join("\n"),
        userActions: [
          "允許助理修改它的 MCP 設定",
          "在瀏覽器的 Authorize Client 頁面點擊 Allow",
        ],
        screenshots: [AUTHORIZE_CLIENT_SCREENSHOT],
      },
      stepsTitle:
        "助理無法自行修改設定時（例如只能在網頁介面新增連接器），手動新增：",
      steps: [
        {
          title: "填入伺服器 URL",
          detail:
            "傳輸方式選 Streamable HTTP，身分驗證選 OAuth（動態用戶端註冊），不需填寫用戶端 ID 或密鑰。",
          copy: { label: "伺服器 URL", text: endpoint },
        },
        {
          title: "網頁型助理：允許回呼網址",
          detail:
            "把該助理提供的回呼網址加入 Cloudflare Access Managed OAuth 的 Allowed redirect URIs；本機程式以 localhost／loopback 接收登入結果，不需額外設定。",
          link: ACCESS_APPS_LINK,
          screenshots: [MANAGED_OAUTH_SCREENSHOT],
        },
      ],
    },
  ];
}

/** 接上後的範例問題，取自 docs/006-mcp.md 開頭。 */
export const MCP_EXAMPLE_PROMPTS = [
  "這個月餐飲花多少？跟上個月比呢？",
  "最近有哪些信用卡要繳？扣款帳戶餘額夠嗎？",
  "幫我找上個月在全聯的消費。",
  "把含有『全聯』的交易都歸到餐飲，然後同步一次玉山。",
  "昨天夜市花了 350，今天領了 3000，幫我記一下。",
] as const;

/** 連線失敗時最常見的狀況，與 docs/006-mcp.md 的疑難排解一致。 */
export const MCP_TROUBLESHOOTING = [
  {
    problem: "登入頁出現 redirect URI 錯誤",
    fix: "網頁型助理的回呼網址尚未加入 Allowed redirect URIs，或本機助理所需的 Allow localhost／loopback clients 未開啟。",
  },
  {
    problem: "出現 OAuth discovery redirect to non-same-origin URL rejected",
    fix: "Managed OAuth 尚未開啟，或開在另一個 Access Application；上方會顯示目前的檢查結果。",
  },
  {
    problem: "登入一段時間後無法使用",
    fix: "Grant session 已到期，重新登入即可：Codex 重新執行登入指令，Claude Code 在 /mcp 重新 Authenticate，ChatGPT 依提示重新連線。",
  },
] as const;
