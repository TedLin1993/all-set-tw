import {
  EMPTY_INVESTMENT_SOURCE_ID,
  INVESTMENT_DUST_THRESHOLD_TWD,
} from "@taiwan-fin-hub/shared";
import type {
  InvestmentPosition,
  NetWorthHistoryPoint,
} from "./financial-types";

/**
 * 加密貨幣交易所（Binance、MAX）共用的持倉正規化與簽章；不呼叫外部 API。
 * 市值一律是同步當下換算的台幣整數，`currency` 固定為 TWD，不寫入匯率表。
 */

export type CryptoPosition = Omit<InvestmentPosition, "id" | "connectorId">;

/** 單一錢包內某幣種的數量；M 錢包借款以負數表示。 */
export type CryptoWalletBalance = {
  asset: string;
  wallet: string;
  quantity: number;
};

/** 已在來源端換算好台幣的額外列，例如合約帳戶權益。 */
export type CryptoValuedEntry = {
  sourceId: string;
  name: string;
  quantity?: number;
  /** undefined 表示無法估值；照樣輸出，不當成 0。 */
  marketValue?: number;
  raw?: Record<string, unknown>;
};

type CryptoHoldingsInput = {
  exchangeName: string;
  asOfDate: string;
  balances: CryptoWalletBalance[];
  /** 回傳 1 單位幣種的台幣價格；無報價路徑時回傳 undefined。 */
  priceTwd: (asset: string) => number | undefined;
  extraEntries?: CryptoValuedEntry[];
};

export type CryptoHoldings = {
  positions: CryptoPosition[];
  netWorth: NetWorthHistoryPoint;
  /** 無法估值的幣種代碼，只供 log；不含數量或金額。 */
  unpricedAssets: string[];
};

/** 去除字串轉數字與加總產生的浮點誤差。 */
export function normalizeCryptoQuantity(value: number) {
  return Number(value.toFixed(10));
}

/** 交易所 API 的數字欄位多為字串；非有限數字視為 0。 */
export function parseCryptoAmount(value: unknown) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(number) ? number : 0;
}

function isDust(marketValue: number) {
  return Math.abs(marketValue) < INVESTMENT_DUST_THRESHOLD_TWD;
}

export function buildCryptoHoldings(
  input: CryptoHoldingsInput,
): CryptoHoldings {
  const byAsset = new Map<
    string,
    { quantity: number; wallets: Record<string, number> }
  >();
  for (const balance of input.balances) {
    if (!Number.isFinite(balance.quantity) || balance.quantity === 0) continue;
    const asset = balance.asset.trim().toUpperCase();
    if (!asset) continue;
    const entry = byAsset.get(asset) ?? { quantity: 0, wallets: {} };
    entry.quantity += balance.quantity;
    entry.wallets[balance.wallet] = normalizeCryptoQuantity(
      (entry.wallets[balance.wallet] ?? 0) + balance.quantity,
    );
    byAsset.set(asset, entry);
  }

  const positions: CryptoPosition[] = [];
  const unpricedAssets: string[] = [];
  for (const [asset, entry] of [...byAsset].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const quantity = normalizeCryptoQuantity(entry.quantity);
    if (quantity === 0) continue;
    const price = input.priceTwd(asset);
    const marketValue =
      price === undefined ? undefined : Math.round(quantity * price);
    if (marketValue !== undefined && isDust(marketValue)) continue;
    if (marketValue === undefined) unpricedAssets.push(asset);
    positions.push({
      sourceId: asset,
      assetType: "crypto",
      symbol: asset,
      name: quantity < 0 ? `${input.exchangeName}（借款）` : input.exchangeName,
      quantity,
      marketValue,
      currency: "TWD",
      asOfDate: input.asOfDate,
      raw: { wallets: entry.wallets, priceTwd: price ?? null },
    });
  }

  for (const entry of input.extraEntries ?? []) {
    const marketValue =
      entry.marketValue === undefined
        ? undefined
        : Math.round(entry.marketValue);
    if (marketValue !== undefined && isDust(marketValue)) continue;
    if (marketValue === undefined) unpricedAssets.push(entry.sourceId);
    positions.push({
      sourceId: entry.sourceId,
      assetType: "crypto",
      name: entry.name,
      quantity:
        entry.quantity === undefined
          ? undefined
          : normalizeCryptoQuantity(entry.quantity),
      marketValue,
      currency: "TWD",
      asOfDate: input.asOfDate,
      raw: entry.raw ?? {},
    });
  }

  if (positions.length === 0) {
    positions.push({
      sourceId: EMPTY_INVESTMENT_SOURCE_ID,
      assetType: "crypto",
      name: `${input.exchangeName}（無持倉）`,
      quantity: 0,
      marketValue: 0,
      currency: "TWD",
      asOfDate: input.asOfDate,
      raw: {},
    });
  }

  return {
    positions,
    netWorth: {
      date: input.asOfDate,
      netWorth: positions.reduce(
        (sum, position) => sum + (position.marketValue ?? 0),
        0,
      ),
      assetType: "crypto",
    },
    unpricedAssets,
  };
}

/**
 * 錯誤訊息用的短端點名稱。完整路徑（如 `/api/v3/wallet/spot/accounts`）會被同步錯誤的
 * token 脫敏規則整段遮蔽，只保留最後兩段。
 */
export function cryptoEndpointLabel(path: string) {
  return path.split("?")[0]!.split("/").filter(Boolean).slice(-2).join("/");
}

/**
 * 回應實際經過的邊緣節點代碼，供封鎖錯誤判斷連線來自哪個地區：
 * MAX 位於 Cloudflare 之後（`cf-ray` 尾碼），Binance 位於 CloudFront 之後
 * （`x-amz-cf-pop` 前三碼）。只取機場代碼，不含識別碼。
 */
export function responseEdgeLocation(response: Response) {
  const pop = response.headers.get("x-amz-cf-pop");
  if (pop) return pop.slice(0, 3).toUpperCase();
  const ray = response.headers.get("cf-ray");
  const colo = ray?.split("-").at(-1);
  return colo && /^[A-Z]{3}$/i.test(colo) ? colo.toUpperCase() : undefined;
}

/**
 * 封鎖錯誤附加的對方邊緣節點代碼；取不到時為空字串。只供參考：CloudFront 依 DNS
 * 解析位置選節點，Cloudflare 子請求的 `cf-ray` 也不等於實際出口位置。
 */
export function cryptoEdgeSuffix(edge?: string) {
  return edge ? `，回應節點 ${edge}` : "";
}

/** HMAC-SHA256 hex；Binance 與 MAX 的請求簽章共用。 */
export async function hmacSha256Hex(secret: string, message: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
