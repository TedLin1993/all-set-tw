import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import ts from "typescript";
import { firstradeDiagnostics } from "./lib/firstrade-diagnostics.mjs";

const compiled = new URL(
  "../node_modules/.cache/firstrade-probe/",
  import.meta.url,
);
await mkdir(compiled, { recursive: true });
const source = await readFile(
  new URL("../packages/connectors/src/firstrade-api.ts", import.meta.url),
  "utf8",
);
await writeFile(
  new URL("client.mjs", compiled),
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText,
);
const { FirstradeApiClient, FirstradeApiError } = await import(
  new URL("client.mjs", compiled)
);
const csrf = randomBytes(32).toString("hex");
let origin,
  client,
  expiry,
  busy = false;
function clear() {
  clearTimeout(expiry);
  client?.clear();
  client = undefined;
}
// Only allow known schema keys into diagnostics; unknown keys could be account IDs.
const knownKeys = new Set(
  "statusCode error message items result page pages per_page total total_market_value total_gainloss total_gainloss_percent total_daychange_amount total_daychange_percent isCostBasisReady account pagination quantity last cost unit_cost sec_type market_value company_name adj_cost adj_unit_cost gainloss gainloss_percent symbol total_account_value cash_balance margin_balance margin_buying_power long_stock_value long_option_value short_option_value non_margin_buying_power daytrade_buying_power money_locked_by_pending_orders sid ftat mfa t_token otp channel recipientId recipientMask verificationSid".split(
    " ",
  ),
);
function shape(value, depth = 0) {
  if (value === null) return "null";
  if (depth > 5) return "nested";
  if (Array.isArray(value))
    return {
      type: "array",
      count: value.length,
      sample: value.slice(0, 1).map((v) => shape(v, depth + 1)),
    };
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => knownKeys.has(k))
        .map(([k, v]) => [k, shape(v, depth + 1)]),
    );
  return typeof value;
}
const page = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Firstrade 本機查詢測試</title>
<style>body{font:17px system-ui;max-width:700px;margin:30px auto;padding:20px;background:#f4f7fa;color:#172b42}form{display:grid;gap:12px}input,select,button{font:inherit;padding:12px}label{display:grid;gap:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none}</style>
<h1>Firstrade 本機查詢測試</h1><p>只查詢帳戶餘額與持倉，不會下單。帳密、驗證碼與回應只在本機記憶體使用，不寫入資料庫。這是尚待驗證的整合測試。</p>
<form id="login"><label>使用者名稱<input name="username" required autocomplete="off"></label><label>密碼<input name="password" type="password" required autocomplete="off"></label><button>登入並取得驗證方式</button></form>
<form id="delivery" hidden><label>接收驗證碼的方式<select name="recipient"></select></label><button>寄送一次驗證碼</button></form>
<form id="verify" hidden><label>收到的 6 位驗證碼<input name="code" required inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code"></label><button>驗證並查詢</button></form>
<pre id="status" role="status"></pre><button id="reset" type="button">清除本機工作階段並重新開始</button>
<script nonce="${csrf}">
const status=document.querySelector('#status'),forms=[...document.forms];
async function post(route,body){const r=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-Probe-Token':'${csrf}'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;}
function show(d){forms.forEach(f=>f.hidden=true);if(d.kind==='delivery'){const f=document.querySelector('#delivery');f.recipient.replaceChildren(...d.options.map(o=>{const e=document.createElement('option');e.value=o.index;e.textContent=(o.channel==='sms'?'簡訊':'Email')+' '+o.recipientMask;return e;}));f.hidden=false;status.textContent='請選擇驗證方式，再按寄送。';}else if(d.kind==='code'||d.kind==='authenticator'){document.querySelector('#verify').hidden=false;status.textContent=d.kind==='code'?'請輸入收到的驗證碼（本機工作階段最多五分鐘）。':'請輸入驗證器 App 的六位數驗證碼。';}else{status.textContent='查詢完成。下方為 API 提供的數值，請與官方網站核對；尚未寫入正式網站。\\n'+JSON.stringify(d.review,null,2)+'\\n本機憑證已清除；尚未確認伺服器登出介面，不能保證遠端工作階段已登出。';}}
for(const f of forms)f.onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(f));const body=f.id==='delivery'?{index:Number(values.recipient)}:values;document.querySelectorAll('input,select,button').forEach(x=>x.disabled=true);if(f.password)f.password.value='';if(f.code)f.code.value='';status.textContent='處理中，請勿重複送出…';try{show(await post('/'+f.id,body));}catch(e){forms.forEach(f=>f.hidden=true);status.textContent=e.message;}finally{body.password='';body.code='';document.querySelectorAll('input,select,button').forEach(x=>x.disabled=false);}};
document.querySelector('#reset').onclick=async()=>{await post('/reset',{});location.reload();};
</script></html>`;
function respond(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function project(accounts) {
  const number = (v) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return accounts.map((a, i) => ({
    account: `帳戶 ${i + 1}（末四碼 ${a.account.slice(-4)}）`,
    totalAccountValue: number(a.balance.total_account_value),
    cashBalance: number(a.balance.cash_balance),
    marginBalance: number(a.balance.margin_balance),
    balanceStockValue: number(a.balance.long_stock_value),
    longOptionValue: number(a.balance.long_option_value),
    shortOptionValue: number(a.balance.short_option_value),
    positionsSubtotal: number(a.positionsMarketValue),
    positionsSum: a.positions.every((p) => number(p.market_value) !== null)
      ? a.positions.reduce((sum, p) => sum + p.market_value, 0)
      : null,
    positions: a.positions.map((p) => ({
      symbol: typeof p.symbol === "string" ? p.symbol.slice(0, 80) : null,
      quantity: number(p.quantity),
      marketValue: number(p.market_value),
      cost: number(p.cost),
      securityType: number(p.sec_type),
    })),
  }));
}
const server = createServer(async (req, res) => {
  if (req.headers.host !== new URL(origin).host)
    return respond(res, 403, { error: "來源不符" });
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${csrf}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    });
    return res.end(page);
  }
  if (
    req.method !== "POST" ||
    req.headers.origin !== origin ||
    req.headers["x-probe-token"] !== csrf ||
    req.headers["content-type"] !== "application/json"
  )
    return respond(res, 403, { error: "來源不符" });
  if (!["/login", "/delivery", "/verify", "/reset"].includes(req.url))
    return respond(res, 404, { error: "操作不存在" });
  if (busy) return respond(res, 409, { error: "操作進行中，請勿重複送出" });
  busy = true;
  try {
    let text = "";
    for await (const chunk of req) {
      text += chunk.toString();
      if (text.length > 8192) throw Error("input");
    }
    const input = JSON.parse(text);
    text = "";
    if (req.url === "/reset") {
      clear();
      return respond(res, 200, { kind: "reset" });
    }
    let result;
    if (req.url === "/login") {
      if (client) throw Error("existing-session");
      if (
        typeof input.username !== "string" ||
        typeof input.password !== "string"
      )
        throw Error("input");
      client = new FirstradeApiClient(fetch, Date.now, (step, payload) =>
        console.log(
          "FIRSTRADE_SHAPE " + JSON.stringify({ step, shape: shape(payload) }),
        ),
      );
      expiry = setTimeout(clear, 5 * 60_000);
      try {
        result = await client.login(input.username, input.password);
      } finally {
        input.password = "";
      }
    } else {
      if (!client) throw Error("expired");
      if (req.url === "/delivery") result = await client.sendCode(input.index);
      else {
        try {
          await client.verify(input.code);
        } finally {
          input.code = "";
        }
        result = { kind: "ready" };
      }
    }
    if (result.kind === "ready") {
      const accounts = await client.readPortfolio();
      console.log(
        "FIRSTRADE_RECONCILIATION " +
          JSON.stringify(firstradeDiagnostics(accounts)),
      );
      result = { kind: "complete", review: project(accounts) };
      clear();
    }
    respond(res, 200, result);
  } catch (error) {
    clear();
    const detail =
      error instanceof FirstradeApiError
        ? { kind: error.kind, step: error.step, status: error.status ?? null }
        : { kind: "local_error", step: "本機工作階段", status: null };
    console.log("FIRSTRADE_RESULT " + JSON.stringify(detail));
    respond(res, 400, {
      error: `測試未完成：${detail.kind}；步驟：${detail.step}；HTTP：${detail.status ?? "未收到回應"}。不會重試帳密；請回報這段訊息。`,
    });
  } finally {
    busy = false;
  }
});
server.requestTimeout = 30_000;
const port = Number(process.env.FIRSTRADE_PROBE_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw Error("Invalid probe port");
server.listen(port, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Firstrade local probe: ${origin}`);
});
