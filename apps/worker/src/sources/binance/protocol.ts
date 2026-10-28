import { z } from "zod";
import {
  buildCryptoHoldings,
  cryptoEdgeSuffix,
  cryptoEndpointLabel,
  parseCryptoAmount,
  type CryptoHoldings,
  type CryptoValuedEntry,
  type CryptoWalletBalance,
} from "../crypto-holdings";

/** Binance API 設定。兩個欄位都由 Worker 加密保存。 */
export const binanceConfigSchema = z.object({
  apiKey: z.string().min(1).max(256).optional(),
  apiSecret: z.string().min(1).max(256).optional(),
});

export type BinanceConfig = z.infer<typeof binanceConfigSchema>;

export function parseBinanceConfig(config: unknown): BinanceConfig {
  return binanceConfigSchema.parse(config);
}

/** API key 格式錯誤、遭拒或簽章不符（-2014、-2015、-1022）。 */
export const BINANCE_CREDENTIAL_ERROR_CODES = new Set([-2014, -2015, -1022]);

export class BinanceApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(
      `Binance API 回應錯誤（${cryptoEndpointLabel(endpoint)}，HTTP ${status}${code === undefined ? "" : `，代碼 ${code}`}）`,
    );
    this.name = "BinanceApiError";
  }
}

export class BinanceCredentialError extends Error {
  constructor() {
    super(
      "Binance 拒絕此 API Key：請確認 API Key 與 Secret Key 正確、已開啟讀取權限，且未限制 IP 白名單。",
    );
    this.name = "BinanceCredentialError";
  }
}

/** Binance 依連線 IP 所在地區拒絕服務（HTTP 451，或 CloudFront 沒有錯誤碼的 403）。 */
export class BinanceRegionBlockedError extends Error {
  constructor(
    status: number,
    readonly edge?: string,
  ) {
    super(
      `Binance 依連線地區拒絕了這次請求（HTTP ${status}${cryptoEdgeSuffix(edge)}）。請求由亞太與西歐的 Cloudflare Browser Run 代發，兩個區域都被拒絕時無法同步，請稍後再試。`,
    );
    this.name = "BinanceRegionBlockedError";
  }
}

export type BinanceSpotAccount = {
  balances?: Array<{ asset?: string; free?: string; locked?: string }>;
};

export type BinanceFundingAsset = {
  asset?: string;
  free?: string;
  locked?: string;
  freeze?: string;
  withdrawing?: string;
};

export type BinanceFlexiblePosition = { asset?: string; totalAmount?: string };
export type BinanceLockedPosition = { asset?: string; amount?: string };

/** U 本位與幣本位合約帳戶；`assets[].marginBalance` 為該資產的權益（已含未實現損益）。 */
export type BinanceFuturesAccount = {
  assets?: Array<{ asset?: string; marginBalance?: string }>;
};

export type BinanceTickerPrice = { symbol?: string; price?: string };

/** `GET /sapi/v1/asset/wallet/balance?quoteAsset=USDT` 的每個錢包總值。 */
export type BinanceWalletBalance = {
  activate?: boolean;
  balance?: string;
  walletName?: string;
};

/** 各錢包原始回應；未開通或無權限的錢包為 undefined。 */
export type BinanceSnapshot = {
  spot: BinanceSpotAccount;
  funding?: BinanceFundingAsset[];
  flexible?: BinanceFlexiblePosition[];
  locked?: BinanceLockedPosition[];
  usdm?: BinanceFuturesAccount;
  coinm?: BinanceFuturesAccount;
  /** 未開通或無權限時為 undefined，只是不補上其他帳戶；其他錯誤使同步失敗。 */
  wallets?: BinanceWalletBalance[];
  tickers: BinanceTickerPrice[];
  /** MAX `usdttwd`；取不到時 client 已讓同步失敗。 */
  usdtTwd: number;
};

const USDT = "USDT";

/**
 * 理財活期與定期共用同一個 Earn 總值：兩者都取得時採用逐幣明細；只取得其中一個時
 * 捨棄這次的明細、改用 Earn 總值，避免少算也避免重複計入。連 Earn 總值都取不到時，
 * 才保留取得的那一半明細。
 */
function useEarnDetail(snapshot: BinanceSnapshot) {
  if (snapshot.flexible && snapshot.locked) return true;
  return !(snapshot.wallets ?? []).some(
    (wallet) =>
      wallet.activate !== false &&
      binanceWalletKey(wallet.walletName ?? "") === "earn",
  );
}

/**
 * 本次確實逐一取得、不可再以錢包總值重複計入的錢包（名稱只保留英文字母比較，
 * 例如 `USDⓈ-M Futures` 比較時為 `usdmfutures`）。逐一端點未開通或無權限時，
 * 改用 `wallet/balance` 的錢包總值補上，避免兩邊都不計入而少算資產。
 */
function detailedWalletKeys(snapshot: BinanceSnapshot, earnDetail: boolean) {
  const keys = new Set(["spot"]);
  if (snapshot.funding) keys.add("funding");
  if (earnDetail) keys.add("earn");
  if (snapshot.usdm) keys.add("usdmfutures");
  if (snapshot.coinm) keys.add("coinmfutures");
  return keys;
}

/** 其他錢包的中文名稱；未列出的沿用 Binance 原始名稱，方便發現名稱不符。 */
const WALLET_LABELS: Record<string, string> = {
  funding: "資金帳戶",
  earn: "理財",
  usdmfutures: "U 本位合約",
  coinmfutures: "幣本位合約",
  crossmargin: "全倉槓桿",
  isolatedmargin: "逐倉槓桿",
  options: "期權",
  tradingbots: "交易機器人",
  copytrading: "跟單",
};

export function binanceWalletKey(walletName: string) {
  return walletName.toLowerCase().replace(/[^a-z]/g, "");
}

/** 以 Binance 現貨報價換成 USDT：直接 XUSDT → 反向 USDTX → 經 XBTC × BTCUSDT。 */
export function createBinanceUsdtPricer(tickers: BinanceTickerPrice[]) {
  const prices = new Map<string, number>();
  for (const ticker of tickers) {
    const price = parseCryptoAmount(ticker.price);
    if (ticker.symbol && price > 0) prices.set(ticker.symbol, price);
  }
  return (asset: string): number | undefined => {
    if (asset === USDT) return 1;
    const direct = prices.get(`${asset}${USDT}`);
    if (direct !== undefined) return direct;
    const inverse = prices.get(`${USDT}${asset}`);
    if (inverse !== undefined) return 1 / inverse;
    const viaBtc = prices.get(`${asset}BTC`);
    const btc = prices.get(`BTC${USDT}`);
    if (viaBtc !== undefined && btc !== undefined) return viaBtc * btc;
    return undefined;
  };
}

export function normalizeBinanceHoldings(
  snapshot: BinanceSnapshot,
  asOfDate: string,
): CryptoHoldings {
  const usdtPrice = createBinanceUsdtPricer(snapshot.tickers);
  const usdtTwd = snapshot.usdtTwd;
  const priceTwd = (asset: string) => {
    if (asset === "TWD") return 1;
    const usdt = usdtPrice(asset);
    return usdt === undefined ? undefined : usdt * usdtTwd;
  };

  const earnDetail = useEarnDetail(snapshot);
  const flexibleAssets = new Set(
    (snapshot.flexible ?? []).map((row) => (row.asset ?? "").toUpperCase()),
  );
  // 活期理財的 LD 憑證可能同時出現在現貨餘額，已由理財明細或 Earn 總值計入。
  // 改用 Earn 總值時，活期明細不可靠，改看報價：憑證本身沒有報價、去掉 LD 後的
  // 幣種有報價才略過；有自己報價的真實幣種（例如 LDO）照常計入。兩者都沒有計入時
  // 保留憑證（無法估值），不讓部位無聲消失。
  const isEarnVoucher = (asset: string) => {
    if (!asset.startsWith("LD")) return false;
    const underlying = asset.slice(2);
    if (flexibleAssets.has(underlying)) return true;
    if (earnDetail) return false;
    return (
      usdtPrice(asset) === undefined && usdtPrice(underlying) !== undefined
    );
  };
  const balances: CryptoWalletBalance[] = [];
  for (const row of snapshot.spot.balances ?? []) {
    const asset = (row.asset ?? "").toUpperCase();
    if (isEarnVoucher(asset)) continue;
    balances.push({
      asset,
      wallet: "spot",
      quantity: parseCryptoAmount(row.free) + parseCryptoAmount(row.locked),
    });
  }
  for (const row of snapshot.funding ?? []) {
    balances.push({
      asset: row.asset ?? "",
      wallet: "funding",
      quantity:
        parseCryptoAmount(row.free) +
        parseCryptoAmount(row.locked) +
        parseCryptoAmount(row.freeze) +
        parseCryptoAmount(row.withdrawing),
    });
  }
  for (const row of earnDetail ? (snapshot.flexible ?? []) : []) {
    balances.push({
      asset: row.asset ?? "",
      wallet: "earnFlexible",
      quantity: parseCryptoAmount(row.totalAmount),
    });
  }
  for (const row of earnDetail ? (snapshot.locked ?? []) : []) {
    balances.push({
      asset: row.asset ?? "",
      wallet: "earnLocked",
      quantity: parseCryptoAmount(row.amount),
    });
  }

  // 合約只取帳戶權益：逐一換算 `assets[].marginBalance`（已含未實現損益）。
  // 不用 U 本位的 `totalMarginBalance`，它在單資產模式只計 USDT，會漏掉 USDC、BNB 等保證金。
  const unpricedFutures: string[] = [];
  const futuresEntry = (
    sourceId: string,
    name: string,
    account: BinanceFuturesAccount | undefined,
  ): CryptoValuedEntry[] => {
    const marginBalances: Record<string, number> = {};
    let twd = 0;
    let priced = true;
    for (const row of account?.assets ?? []) {
      const asset = (row.asset ?? "").toUpperCase();
      const marginBalance = parseCryptoAmount(row.marginBalance);
      if (!asset || marginBalance === 0) continue;
      marginBalances[asset] = marginBalance;
      const price = priceTwd(asset);
      if (price === undefined) {
        priced = false;
        unpricedFutures.push(asset);
      } else {
        twd += marginBalance * price;
      }
    }
    if (Object.keys(marginBalances).length === 0) return [];
    return [
      {
        sourceId,
        name,
        marketValue: priced ? twd : undefined,
        raw: { marginBalances, usdtTwd },
      },
    ];
  };
  // 沒有逐一取得的錢包（期權、交易機器人、跟單、槓桿，以及未開通權限的錢包）各列一筆帳戶總值。
  const walletEntries: CryptoValuedEntry[] = [];
  const detailedWallets = detailedWalletKeys(snapshot, earnDetail);
  for (const wallet of snapshot.wallets ?? []) {
    const name = wallet.walletName?.trim() ?? "";
    const key = binanceWalletKey(name);
    const balanceUsdt = parseCryptoAmount(wallet.balance);
    if (!key || detailedWallets.has(key)) continue;
    if (wallet.activate === false || balanceUsdt === 0) continue;
    walletEntries.push({
      sourceId: `wallet-${key}`,
      name: WALLET_LABELS[key] ?? name,
      marketValue: balanceUsdt * usdtTwd,
      raw: { walletName: name, balanceUsdt, usdtTwd },
    });
  }

  const extraEntries = [
    ...futuresEntry("futures-usdm", "Binance U 本位合約權益", snapshot.usdm),
    ...futuresEntry("futures-coinm", "Binance 幣本位合約權益", snapshot.coinm),
    ...walletEntries,
  ];

  const holdings = buildCryptoHoldings({
    exchangeName: "Binance",
    asOfDate,
    balances,
    priceTwd,
    extraEntries,
  });
  return {
    ...holdings,
    unpricedAssets: [
      ...new Set([...holdings.unpricedAssets, ...unpricedFutures]),
    ],
  };
}
