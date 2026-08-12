/**
 * Transport used by the 2026 Taiwan e-invoice app protocol.
 *
 * The app deliberately keeps the middle API payload opaque (ldata) and the
 * invoice API payload signed (einvoiceJwt).  This module contains only the
 * protocol primitives and a small client; it does not log credentials or
 * tokens.  Hosts and app metadata remain overridable so a future app update
 * can be accommodated without changing the connector shape.
 */

export type EInvoiceV2Session = {
  sid: string;
  token: string;
  iv?: string;
  svrCode?: string;
  clientCode?: string;
  loginAppId: string;
  loginLiat: number;
  loginSsMe: string;
  ltoken?: string;
  hkey?: string;
  carrierCode?: string;
  /** Difference between the service `now` and this worker's Unix clock. */
  serverTimeOffset?: number;
};

export type EInvoiceV2Options = {
  middleHost?: string;
  bigHost?: string;
  appVersion?: string;
  appBuild?: number;
  language?: string;
  ccs?: string;
  androidId?: string;
  ptoken?: string;
  loginClientCode?: string;
  loginType?: number;
  osVersion?: string;
  userAgent?: string;
  /** Cancels every request made by this client when the caller aborts it. */
  signal?: AbortSignal;
  /** Per-request deadline. Defaults to 30 seconds. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type EInvoiceV2LoginOptions = EInvoiceV2Options & {
  mobile: string;
  password: string;
  carrierCode?: string;
};

const PROD_MIDDLE_HOST = "https://uia.einvoice.nat.gov.tw";
const PROD_BIG_HOST = "https://upi.einvoice.nat.gov.tw";
const DEFAULT_APP_VERSION = "6.800.2";
const DEFAULT_APP_BUILD = 66;
const DEFAULT_USER_AGENT = "okhttp/5.3.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function cryptoApi() {
  const value = globalThis.crypto;
  if (!value?.subtle || !value.getRandomValues) {
    throw new Error("此執行環境缺少 WebCrypto，無法建立新版電子發票登入封包。");
  }
  return value;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function base64Url(bytes: Uint8Array) {
  return base64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

// TypeScript's DOM lib currently models Uint8Array with ArrayBufferLike while
// WebCrypto's overload still asks for ArrayBuffer. The runtime accepts both;
// keep the conversion in one place for Node and Cloudflare builds.
function cryptoSource(value: Uint8Array) {
  return value as unknown as BufferSource;
}

function swapPairs(value: string) {
  let output = "";
  for (let index = 0; index < value.length; index += 2) {
    output += value[index + 1] ?? "";
    output += value[index] ?? "";
  }
  return output;
}

function randomAlphaNumeric(length: number) {
  const random = new Uint32Array(length);
  cryptoApi().getRandomValues(random);
  return Array.from(
    random,
    (value) => ALPHANUMERIC[value % ALPHANUMERIC.length],
  ).join("");
}

async function sha256(value: string) {
  return new Uint8Array(
    await cryptoApi().subtle.digest("SHA-256", cryptoSource(utf8(value))),
  );
}

async function aesGcmEncrypt(
  plainText: string,
  key: Uint8Array,
  iv: Uint8Array,
) {
  const cryptoKey = await cryptoApi().subtle.importKey(
    "raw",
    cryptoSource(key),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  return new Uint8Array(
    await cryptoApi().subtle.encrypt(
      { name: "AES-GCM", iv: cryptoSource(iv), tagLength: 128 },
      cryptoKey,
      cryptoSource(utf8(plainText)),
    ),
  );
}

async function aesGcmDecrypt(
  cipherText: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
) {
  const cryptoKey = await cryptoApi().subtle.importKey(
    "raw",
    cryptoSource(key),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(
    await cryptoApi().subtle.decrypt(
      { name: "AES-GCM", iv: cryptoSource(iv), tagLength: 128 },
      cryptoKey,
      cryptoSource(cipherText),
    ),
  );
}

type LDataCryptoContext = { key: Uint8Array; iv: Uint8Array };

async function encryptLoginDataWithContext(data: Record<string, unknown>) {
  const json = JSON.stringify(data);
  const a = randomAlphaNumeric(16);
  const b = randomAlphaNumeric(16);
  const seed = `${swapPairs(b)}${swapPairs(a)}${[...a].reverse().join("")}${[...b].reverse().join("")}`;
  const key = await sha256(seed);
  const iv = utf8(`${a.slice(-6)}${b.slice(-6)}`);
  const cipherText = await aesGcmEncrypt(json, key, iv);
  return {
    value: `${a}|${base64(cipherText)}|${b}`,
    context: { key, iv } satisfies LDataCryptoContext,
  };
}

async function decryptLDataCiphertext(
  value: string,
  context: LDataCryptoContext,
) {
  const binary = globalThis.atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(
    await aesGcmDecrypt(bytes, context.key, context.iv),
  ) as Record<string, unknown>;
}

/** AppCrypto.lDataEncrypt: random 16+16 seed, SHA-256 key, AES-GCM payload. */
export async function encryptLoginData(data: Record<string, unknown>) {
  let step = "json";
  try {
    step = "random";
    return (await encryptLoginDataWithContext(data)).value;
  } catch (error) {
    throw new Error(
      `新版電子發票登入封包建立失敗（${step}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Decrypts the ldata response returned in the middle API payload. */
export async function decryptLoginData(value: string) {
  const parts = value.split("|");
  if (parts.length !== 3 || parts[0].length !== 16 || parts[2].length !== 16) {
    throw new Error("新版電子發票登入回應的 ldata 格式無效。");
  }
  const [a, encoded, b] = parts;
  const seed = `${swapPairs(b)}${swapPairs(a)}${[...a].reverse().join("")}${[...b].reverse().join("")}`;
  const key = await sha256(seed);
  const iv = utf8(`${a.slice(-6)}${b.slice(-6)}`);
  return decryptLDataCiphertext(encoded, { key, iv });
}

function jsonHeaders(options: EInvoiceV2Options) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    appver: options.appVersion ?? DEFAULT_APP_VERSION,
    appbn: String(options.appBuild ?? DEFAULT_APP_BUILD),
    platform: "android",
    version: options.appVersion ?? DEFAULT_APP_VERSION,
  };
}

function formHeaders(options: EInvoiceV2Options) {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    appver: options.appVersion ?? DEFAULT_APP_VERSION,
    appbn: String(options.appBuild ?? DEFAULT_APP_BUILD),
    platform: "android",
    version: options.appVersion ?? DEFAULT_APP_VERSION,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unwrapBody(body: unknown) {
  const root = recordValue(body);
  if (!root) return body;
  return root.payload ?? root.data ?? root.result ?? root;
}

async function decodeMiddleBody(body: unknown, context?: LDataCryptoContext) {
  const value = unwrapBody(body);
  if (typeof value !== "string") return value;
  if (context && !value.includes("|")) {
    try {
      return await decryptLDataCiphertext(value, context);
    } catch {
      // Fall through to the compatibility decoder for plain service messages.
    }
  }
  try {
    return await decryptLoginData(value);
  } catch {
    // A few service errors are returned as a plain message string.
    return value;
  }
}

function sessionFromLoginData(
  data: unknown,
  fallback: Partial<EInvoiceV2Session>,
) {
  const value = recordValue(data) ?? {};
  const agree = recordValue(value.agree_ver);
  const serverNow = Number(value.now);
  const serverTimeOffset = Number.isFinite(serverNow)
    ? Math.trunc(serverNow - Date.now() / 1000)
    : fallback.serverTimeOffset;
  const session: EInvoiceV2Session = {
    sid: stringValue(value.sid ?? fallback.sid),
    token: stringValue(value.token ?? fallback.token),
    iv: stringValue(value.iv ?? fallback.iv) || undefined,
    svrCode:
      stringValue(value.svrCode ?? value.svr_code ?? fallback.svrCode) ||
      undefined,
    clientCode:
      stringValue(value.clientCode ?? fallback.clientCode) || undefined,
    loginAppId: stringValue(
      value.appid ?? value.loginAppId ?? fallback.loginAppId,
    ),
    loginLiat: Number(value.liat ?? fallback.loginLiat ?? 0),
    loginSsMe: stringValue(value.ssme ?? value.loginSsMe ?? fallback.loginSsMe),
    ltoken: stringValue(value.ltoken ?? fallback.ltoken) || undefined,
    hkey: stringValue(value.hkey ?? value.skey ?? fallback.hkey) || undefined,
    carrierCode:
      stringValue(
        value.carrier_code ?? value.carrierCode ?? fallback.carrierCode,
      ) || undefined,
    serverTimeOffset,
  };
  if (agree?.eula != null)
    (
      session as EInvoiceV2Session & { agreedEulaVersion?: number }
    ).agreedEulaVersion = Number(agree.eula);
  if (
    !session.sid ||
    !session.token ||
    !session.loginAppId ||
    !session.loginSsMe ||
    !Number.isFinite(session.loginLiat)
  ) {
    throw new Error(
      `新版電子發票登入成功回應缺少必要 session 欄位（回應欄位：${Object.keys(value).join(",") || "無"}）。`,
    );
  }
  return session;
}

function accessToken(session: EInvoiceV2Session) {
  // ApiCrypto.getAcToken: sid[14..17] + sid[0..3] selects token[5..30].
  if (session.sid.length !== 18 || session.token.length < 44) return "";
  const indexes = [14, 15, 16, 17, 0, 1, 2, 3];
  return `${session.sid}|${indexes.map((index) => session.token.charAt((session.sid.charCodeAt(index) % 26) + 5)).join("")}`;
}

export function createInvoiceJwt(
  request: Record<string, unknown>,
  session: Pick<
    EInvoiceV2Session,
    "loginLiat" | "loginAppId" | "loginSsMe" | "carrierCode"
  >,
  now = Math.floor(Date.now() / 1000) - 10,
) {
  const header = { alg: "HS256", typ: "JWT", ver: "1.0" };
  const claims = {
    comms: {
      iat: now,
      exp: now + 40,
      liat: session.loginLiat,
      appid: session.loginAppId,
      barcode: session.carrierCode ?? "",
      keyType: "2",
    },
    reqdata: request,
  };
  const encodedHeader = base64Url(utf8(JSON.stringify(header)));
  const encodedClaims = base64Url(utf8(JSON.stringify(claims)));
  return {
    signingInput: `${encodedHeader}.${encodedClaims}`,
    secret: session.loginSsMe,
  };
}

function correctedInvoiceTimestamp(
  session: Pick<EInvoiceV2Session, "serverTimeOffset">,
) {
  return Math.floor(Date.now() / 1000) + (session.serverTimeOffset ?? 0) - 10;
}

export async function signInvoiceJwt(
  request: Record<string, unknown>,
  session: Pick<
    EInvoiceV2Session,
    "loginLiat" | "loginAppId" | "loginSsMe" | "carrierCode"
  >,
  now?: number,
) {
  const { signingInput, secret } = createInvoiceJwt(request, session, now);
  const key = await cryptoApi().subtle.importKey(
    "raw",
    cryptoSource(utf8(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await cryptoApi().subtle.sign(
      "HMAC",
      key,
      cryptoSource(utf8(signingInput)),
    ),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

export class EInvoiceV2Client {
  private readonly options: Required<
    Pick<EInvoiceV2Options, "middleHost" | "bigHost">
  > &
    EInvoiceV2Options;
  private readonly fetcher: typeof fetch;

  constructor(options: EInvoiceV2Options = {}) {
    this.options = {
      middleHost: options.middleHost ?? PROD_MIDDLE_HOST,
      bigHost: options.bigHost ?? PROD_BIG_HOST,
      ...options,
    };
    // Cloudflare's global fetch is Web-IDL bound; storing the bare function and
    // invoking it as a class member causes an Illegal invocation error.
    this.fetcher = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async login(params: EInvoiceV2LoginOptions) {
    const androidId = params.androidId ?? "taiwan-fin-hub";
    const ptoken = params.ptoken ?? "";
    const loginClientCode =
      params.loginClientCode ??
      this.options.loginClientCode ??
      randomAlphaNumeric(8);
    const inner = {
      type: params.loginType ?? 0,
      account: params.mobile,
      password: params.password,
      carrier_code: params.carrierCode ?? "",
      ckey: loginClientCode,
      device: {
        os: "a",
        os_version: params.osVersion ?? "15",
        model: "Android",
        pdid: `a:${androidId}`,
        ptoken,
        appver: params.appVersion ?? DEFAULT_APP_VERSION,
        appbn: params.appBuild ?? DEFAULT_APP_BUILD,
        lang: params.language ?? "zh",
        ccs: params.ccs ?? "tw",
      },
      ts: Math.floor(Date.now() / 1000),
      pdid: `a:${androidId}`,
    };
    const encrypted = await encryptLoginDataWithContext(inner);
    const body = await this.middleRequest(
      "/mid/v1/login",
      {
        ldata: encrypted.value,
      },
      params.signal,
    );
    const data = await decodeMiddleBody(body, encrypted.context);
    try {
      return sessionFromLoginData(data, {
        clientCode: loginClientCode,
        carrierCode: params.carrierCode,
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}；外層回應形狀：${responseShape(body)}`,
      );
    }
  }

  async loginToken(
    session: Pick<EInvoiceV2Session, "ltoken"> & Partial<EInvoiceV2Session>,
    options: EInvoiceV2Options = {},
  ) {
    if (!session.ltoken)
      throw new Error(
        "新版電子發票 session 沒有 ltoken，無法使用 token 登入。",
      );
    const androidId = options.androidId ?? "taiwan-fin-hub";
    const inner = {
      ltoken: session.ltoken,
      ckey:
        options.loginClientCode ??
        session.clientCode ??
        this.options.loginClientCode ??
        randomAlphaNumeric(8),
      device: {
        os: "a",
        os_version: options.osVersion ?? "15",
        model: "Android",
        pdid: `a:${androidId}`,
        ptoken: options.ptoken ?? "",
        appver: options.appVersion ?? DEFAULT_APP_VERSION,
        appbn: options.appBuild ?? DEFAULT_APP_BUILD,
        lang: options.language ?? "zh",
        ccs: options.ccs ?? "tw",
      },
      ts: Math.floor(Date.now() / 1000),
      pdid: `a:${androidId}`,
    };
    const encrypted = await encryptLoginDataWithContext(inner);
    const body = await this.middleRequest(
      "/mid/v1/logintoken",
      {
        ldata: encrypted.value,
      },
      options.signal,
    );
    return sessionFromLoginData(
      await decodeMiddleBody(body, encrypted.context),
      session,
    );
  }

  async queryCarrierInvoices(
    session: EInvoiceV2Session,
    startDate: string,
    endDate: string,
    page = 1,
  ) {
    const request = {
      version: "1.0",
      cardType: "3J0002",
      cardNo: session.carrierCode ?? "",
      action: "carrierInvChk",
      startDate,
      endDate,
      onlyWinningInv: "A",
      page,
    };
    return this.bigRequest(
      "/einvoice/carriers/query-invoices-header",
      await signInvoiceJwt(
        request,
        session,
        correctedInvoiceTimestamp(session),
      ),
    );
  }

  async queryCarrierInvoiceDetail(
    session: EInvoiceV2Session,
    invNum: string,
    invDate: string,
  ) {
    const request = {
      version: "1.0",
      cardType: "3J0002",
      cardNo: session.carrierCode ?? "",
      action: "carrierInvDetail",
      invNum,
      invDate,
    };
    return this.bigRequest(
      "/einvoice/carriers/query-invoices-details",
      await signInvoiceJwt(
        request,
        session,
        correctedInvoiceTimestamp(session),
      ),
    );
  }

  async queryInvoiceDetail(
    session: EInvoiceV2Session,
    invNum: string,
    invDate: string,
    randomNumber = "",
    invPeriod = "",
    sellerID = "",
    encrypt = "",
    isQrCode = false,
    isBuyerType = false,
  ) {
    const request = {
      version: "1.0",
      action: "qryInvDetail",
      invNum,
      invDate,
      randomNumber,
      type: randomNumber ? (isQrCode ? "QRCode" : "Barcode") : "NoRandomNumber",
      invTerm: invPeriod,
      sellerID,
      encrypt,
      isBuyerType: isBuyerType ? "Y" : "N",
    };
    return this.bigRequest(
      "/einvoice/invoices/query-details",
      await signInvoiceJwt(
        request,
        session,
        correctedInvoiceTimestamp(session),
      ),
    );
  }

  private async middleRequest(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const response = await this.request(`${this.options.middleHost}${path}`, {
      method: "POST",
      headers: jsonHeaders(this.options),
      body: JSON.stringify(body),
      signal,
    });
    return readJsonResponse(response, path);
  }

  private async bigRequest(path: string, jwt: string) {
    const form = new URLSearchParams({ einvoiceJwt: jwt });
    const response = await this.request(`${this.options.bigHost}${path}`, {
      method: "POST",
      headers: formHeaders(this.options),
      body: form.toString(),
    });
    return readJsonResponse(response, path);
  }

  private async request(input: RequestInfo | URL, init: RequestInit) {
    return fetchWithTimeout(this.fetcher, input, init, {
      signal: init.signal ?? this.options.signal,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs: number },
) {
  const controller = new AbortController();
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs));
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`新版電子發票請求逾時（${timeoutMs}ms）。`));
  }, timeoutMs);

  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error(`新版電子發票請求逾時（${timeoutMs}ms）。`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function readJsonResponse(response: Response, path: string) {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!response.ok) {
    const root = recordValue(body);
    const message = stringValue(
      root?.message ?? root?.msg ?? root?.description ?? root?.error,
    );
    throw new Error(
      `新版電子發票 ${path} HTTP ${response.status}${message ? `：${message}` : ""}`,
    );
  }
  const root = recordValue(body);
  if (typeof root?.result === "number" && root.result !== 0) {
    const payload = recordValue(root.payload);
    const encryptedPayload =
      typeof root.payload === "string"
        ? await tryDecryptErrorPayload(root.payload)
        : undefined;
    const decodedPayload = recordValue(encryptedPayload);
    const message = stringValue(
      root.message ??
        root.msg ??
        root.description ??
        root.error ??
        payload?.message ??
        payload?.msg ??
        payload?.description ??
        payload?.error ??
        decodedPayload?.message ??
        decodedPayload?.msg ??
        decodedPayload?.description ??
        decodedPayload?.error ??
        (typeof root.payload === "string" ? root.payload : undefined),
    );
    throw new Error(
      `新版電子發票 ${path} 回應錯誤（代碼 ${root.result}）${message ? `：${message}` : ""}`,
    );
  }
  return body;
}

async function tryDecryptErrorPayload(value: string) {
  try {
    return await decryptLoginData(value);
  } catch {
    return undefined;
  }
}

function responseShape(body: unknown) {
  const root = recordValue(body);
  if (!root) return typeof body;
  const payload = root.payload;
  return `keys=${Object.keys(root).join(",") || "無"}, payload=${typeof payload}${typeof payload === "string" ? `(${payload.length} chars)` : ""}`;
}
