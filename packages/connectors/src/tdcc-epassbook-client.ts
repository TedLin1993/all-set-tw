// Ported from the TDCC ePassbook Android app's mobile API (reverse-engineered).
// Trimmed to login/OTP + stock & fund holdings — bank balances, trade detail
// drill-down, and asset trend charts are out of scope per docs/002-tdcc-connector.md.
const BASE_URL = "https://epassbooksys.tdcc.com.tw/MPSBKV2/rest/";
const APP_INFO = "tw.com.tdcc.epassbook:3.3.4";
const API_VER = "20250220";
const DEFAULT_LAST_UPDATE = "19000101000000";
const BANK_TRANSACTION_PAGE_SIZE = 100;
const MAX_BANK_TRANSACTION_PAGES = 1_000;
const AES_IV = new TextEncoder().encode("0000000000000000");
const encoder = new TextEncoder();

type BankTransactionDetail = {
  stan?: string;
  txnDateTime?: string;
  transferInAmount?: string;
  transferOutAmount?: string;
  summary?: string;
  memo?: string;
};

export class EPassbookError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
  }
}

export type EPassbookSession = {
  tokenId: string | null;
  richUrl: string | null;
};

type EPassbookClientOptions = {
  devId: string;
  devType: string;
  devModel: string;
  session?: EPassbookSession;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timestamp(): string {
  const date = new Date();
  const pad = (value: number, width = 2) =>
    value.toString().padStart(width, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}Z`;
}

function deriveEncryptionKey(ts: string, devType: string): string {
  const encoded = btoa(ts + APP_INFO + devType).replace(/\n/g, "");
  const chars = encoded.split("");
  const out: string[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const source =
      index % 2 === 0
        ? index - Math.floor(index / 2)
        : chars.length - 1 - Math.floor(index / 2);
    out.push(chars[source] ?? "");
    if (out.length === 32) break;
  }
  const key = out.join("");
  return key.length < 32 ? "*".repeat(32 - key.length) + key : key;
}

async function aesEncrypt(key: string, plaintext: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: AES_IV },
    cryptoKey,
    encoder.encode(plaintext),
  );
  return bytesToBase64(new Uint8Array(ciphertext));
}

async function sha256Signature(data: string): Promise<string> {
  return bytesToBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data))),
  ).replace(/\n/g, "");
}

function makeSequence(ts: string): string {
  return btoa(ts).replace(/\n/g, "");
}

export class EPassbookClient {
  private tokenId: string | null;
  private richUrl: string | null;
  private readonly devId: string;
  private readonly devType: string;
  private readonly devModel: string;

  constructor(options: EPassbookClientOptions) {
    this.devId = options.devId;
    this.devType = options.devType;
    this.devModel = options.devModel;
    this.tokenId = options.session?.tokenId ?? null;
    this.richUrl = options.session?.richUrl ?? null;
  }

  exportSession(): EPassbookSession {
    return { tokenId: this.tokenId, richUrl: this.richUrl };
  }

  private async post<T extends object>(
    endpoint: string,
    body: Record<string, unknown>,
    options: { encryptFields?: string[]; allowedReturnCodes?: string[] } = {},
  ): Promise<T & { _returnCode?: string; _returnMsg?: string }> {
    const ts = timestamp();
    const requestBody: Record<string, unknown> = { ...body };
    if (options.encryptFields?.length) {
      const key = deriveEncryptionKey(ts, this.devType);
      for (const field of options.encryptFields) {
        if (typeof requestBody[field] === "string")
          requestBody[field] = await aesEncrypt(
            key,
            requestBody[field] as string,
          );
      }
    }

    const hasBody = Object.keys(requestBody).length > 0;
    const bodyJson = hasBody ? JSON.stringify(requestBody) : undefined;
    const signInput = bodyJson ?? ts;
    const requestHeader = {
      appInfo: APP_INFO,
      devID: this.devId,
      devType: this.devType,
      sequence: makeSequence(ts),
      signature: await sha256Signature(signInput),
      tokenID: this.tokenId,
    };

    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "okhttp/4.9.3",
        Connection: "Keep-Alive",
        "Accept-Encoding": "gzip",
      },
      body: JSON.stringify({
        requestHeader,
        requestBody: hasBody ? requestBody : {},
      }),
    });
    if (!response.ok) {
      throw new EPassbookError(
        `HTTP_${response.status}`,
        "TDCC ePassbook request failed.",
      );
    }

    const envelope = (await response.json()) as {
      responseHeader?: {
        returnCode?: string;
        returnMsg?: string;
        tokenID?: string;
      };
      responseBody?: unknown;
    };
    const header = envelope.responseHeader ?? {};
    if (header.tokenID) this.tokenId = header.tokenID;
    const code = header.returnCode ?? "0000";
    if (code !== "0000" && !options.allowedReturnCodes?.includes(code)) {
      throw new EPassbookError(
        code,
        header.returnMsg ?? "TDCC ePassbook error",
      );
    }
    return {
      ...((envelope.responseBody ?? {}) as T),
      _returnCode: code,
      _returnMsg: header.returnMsg,
    };
  }

  async getInitialToken() {
    const result = await this.post<{ tokenID?: string }>("CM001", {});
    if (result.tokenID) this.tokenId = result.tokenID;
  }

  async login(userId: string, password: string) {
    const result = await this.post<Record<string, unknown>>(
      "AU001",
      {
        apiVer: API_VER,
        devModel: this.devModel,
        loginCode: password,
        loginType: "M",
        networkType: "WIFI",
        userID: userId,
      },
      { encryptFields: ["userID", "loginCode"] },
    );
    if (typeof result.richUrl === "string") this.richUrl = result.richUrl;
    if (typeof result.tokenID === "string") this.tokenId = result.tokenID;
    return result;
  }

  async requestEmailOtp(userId: string) {
    return this.post<Record<string, unknown>>(
      "AU013",
      { apiVer: API_VER, applyType: "D", birthday: "", userID: userId },
      { encryptFields: ["userID"] },
    );
  }

  async requestMobileOtp(userId: string) {
    return this.post<Record<string, unknown>>(
      "AU014",
      { applyType: "D", birthday: "", userID: userId },
      { encryptFields: ["userID"] },
    );
  }

  async verifyOtp(
    userId: string,
    otp: string,
    channel: "email" | "sms" = "email",
  ) {
    return this.post<Record<string, unknown>>(
      "AU015",
      {
        applyType: "D",
        birthday: "",
        otp,
        sendType: channel === "sms" ? "MOBILE" : "EMAIL",
        userID: userId,
      },
      { encryptFields: ["userID", "otp"] },
    );
  }

  async getPositions() {
    return this.post<Record<string, unknown>>("TR001", {
      lastUpdateTime: DEFAULT_LAST_UPDATE,
    });
  }

  async getFundPositions() {
    return this.post<Record<string, unknown>>("TR051V1", {
      lastUpdateTime: DEFAULT_LAST_UPDATE,
    });
  }

  async getBankBalances(): Promise<{
    tspAccountInfos?: Array<{
      bankId: string;
      tspAccount?: Array<{
        accountNo: string;
        accountType?: string;
        currency: string;
        balanceAmt: string;
        availableBalance?: string;
        isShow?: boolean;
      }>;
    }>;
  }> {
    return this.post("tsp/TSP006", {});
  }

  // ponytail: &fund=Y/N makes no difference — both return chartDate/chartVal (total)
  // and fundChartDate/fundChartVal (fund-only). Stock = chartVal - fundChartVal.
  async getAssetTrend(type = "1Y"): Promise<{
    chartDate: string[];
    chartVal: number[];
    fundChartDate: string[];
    fundChartVal: number[];
  } | null> {
    if (!this.richUrl) return null;
    const qs = this.richUrl.includes("?")
      ? this.richUrl.slice(this.richUrl.indexOf("?"))
      : "";
    const url = `${BASE_URL}TR087${qs}&type=${type}`;
    const response = await fetch(url, {
      headers: {
        Referer: "https://digitalprocesssys-epassbook.cdn.hinet.net/",
        "User-Agent": "okhttp/4.9.3",
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      responseBody?: Record<string, unknown>;
    };
    const body = data.responseBody;
    if (
      !body?.chartDate ||
      !Array.isArray(body.chartDate) ||
      body.chartDate.length === 0
    )
      return null;
    return {
      chartDate: body.chartDate as string[],
      chartVal: Array.isArray(body.chartVal) ? (body.chartVal as number[]) : [],
      fundChartDate: Array.isArray(body.fundChartDate)
        ? (body.fundChartDate as string[])
        : [],
      fundChartVal: Array.isArray(body.fundChartVal)
        ? (body.fundChartVal as number[])
        : [],
    };
  }

  async getBankTransactions(
    bankNo: string,
    acctNo: string,
    currency: string,
  ): Promise<{
    transactions: Array<{
      txnId: string;
      occurredAt: string;
      amount: string;
      memo?: string;
    }>;
  }> {
    const details: BankTransactionDetail[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken = "";
    let expectedTotal: number | undefined;

    for (let page = 1; ; page += 1) {
      if (page > MAX_BANK_TRANSACTION_PAGES) {
        throw new EPassbookError(
          "PAGINATION_LIMIT",
          `TSP007 exceeded ${MAX_BANK_TRANSACTION_PAGES} pages.`,
        );
      }
      seenPageTokens.add(pageToken);

      const raw = await this.post<{
        transactionDetails?: BankTransactionDetail[];
        pageToken?: string | null;
        totalCount?: number | string;
      }>("tsp/TSP007", {
        bankId: bankNo,
        accountNo: acctNo,
        currency,
        limitsInPage: BANK_TRANSACTION_PAGE_SIZE,
        pageToken,
      });

      const pageDetails = raw.transactionDetails ?? [];
      details.push(...pageDetails);
      const parsedTotal =
        typeof raw.totalCount === "number" || typeof raw.totalCount === "string"
          ? Number(raw.totalCount)
          : Number.NaN;
      if (Number.isFinite(parsedTotal) && parsedTotal >= 0)
        expectedTotal = parsedTotal;

      console.log(
        JSON.stringify({
          event: "tdcc_bank_transactions_page",
          bankId: bankNo,
          account: maskAccountNumber(acctNo),
          currency,
          page,
          records: pageDetails.length,
          totalCount: expectedTotal ?? null,
        }),
      );

      if (expectedTotal !== undefined && details.length >= expectedTotal) break;

      const nextPageToken =
        typeof raw.pageToken === "string" ? raw.pageToken : "";
      if (!nextPageToken) {
        if (expectedTotal !== undefined && details.length < expectedTotal) {
          throw new EPassbookError(
            "PAGINATION_INCOMPLETE",
            `TSP007 returned ${details.length} of ${expectedTotal} transactions without a next page token.`,
          );
        }
        break;
      }
      if (seenPageTokens.has(nextPageToken)) {
        throw new EPassbookError(
          "PAGINATION_LOOP",
          "TSP007 returned a repeated page token.",
        );
      }
      pageToken = nextPageToken;
    }

    // ponytail: some banks reuse the same stan for recurring/batch entries (e.g. interest).
    // Count occurrences so duplicates get a compound key that includes date+amounts.
    const stanCount = new Map<string, number>();
    for (const d of details) {
      if (d.stan) stanCount.set(d.stan, (stanCount.get(d.stan) ?? 0) + 1);
    }

    const transactions = details.map((d) => {
      const dt = d.txnDateTime ?? "";
      const occurredAt =
        dt.length >= 14
          ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(8, 10)}:${dt.slice(10, 12)}:${dt.slice(12, 14)}`
          : new Date().toISOString();
      const isDupStan = d.stan && (stanCount.get(d.stan) ?? 0) > 1;
      const txnId = isDupStan
        ? `${d.stan}:${occurredAt}:${d.transferInAmount ?? "0"}:${d.transferOutAmount ?? "0"}`
        : (d.stan ?? occurredAt);
      return {
        txnId,
        occurredAt,
        amount: String(
          Number(d.transferInAmount ?? "0") -
            Number(d.transferOutAmount ?? "0"),
        ),
        ...(d.memo?.trim() || d.summary?.trim()
          ? { memo: d.memo?.trim() || d.summary?.trim() }
          : {}),
      };
    });

    return { transactions };
  }

  async getTradeDetail(input: {
    brokerNo: string;
    brokerAccount: string;
    postDate?: string;
    txnSerNo?: string;
    updateType: "B" | "F";
  }) {
    return this.post<{
      brokerNo?: string;
      brokerAccount?: string;
      exchangeRates?: Record<string, unknown>;
      items?: unknown[];
      lastServerTime?: string;
    }>(
      "TR002",
      {
        brokerNo: input.brokerNo,
        brokerAccount: input.brokerAccount,
        postDate: input.postDate ?? "",
        txnSerNo: input.txnSerNo ?? "",
        updateType: input.updateType,
      },
      { allowedReturnCodes: ["D0002"] },
    );
  }
}

function maskAccountNumber(value: string) {
  const suffix = value.slice(-4);
  return suffix ? `***${suffix}` : "***";
}
