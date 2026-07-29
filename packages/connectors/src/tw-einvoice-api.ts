import forge from "node-forge";

const BASE_URL = "https://invoiceapp.nat.gov.tw/UIAPAPP/api/";
// This is the API protocol version advertised by the service's 6608 upgrade
// response. It is not the same as the version shown in Google Play.
const DEFAULT_APP_VERSION = "7.9000.40";
const DEFAULT_OS = "Android";
const DEFAULT_API_KEY =
  "xkRT21hZ3uDJehRthVlDAdfzpAoPLEoKpTAKyR/eB2iMqErmM7U5IVC6G5eHD/MN";

export const RSA_PUBLIC_KEY = `<RSAKeyValue><Modulus>wWj/ElSXlSJCJv/ELn47aYNIx8pWec6RFgVWnW836DQwQjh7pL90av6Mvv5kPjNbM4njxeLeuXx9ZuNP2A+JUhVLkU6zdqB+T2Nyj+zhUa5szkmaJm0ntXJvGN7iAwIvLPE2BcMWGlsPBFhWMoRt8goM06AUcFIzI4dL3iDpUWvm/Og/bzeel7/rb0RVbV86zv4MzqIt7PJM7mnw+SCjH59nEBsKkR96kR3Ye6iwztvAZcIGyTihFW2J0GEq+sPO09XW+oobQt62qIaisbR7rVZcY5Qcu8g6qeVzoz1n77/SeG4BZo/hLR13I874ZUZ+rdbFNoOPj9mj+WSPFIPf6Q==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>`;

export type EInvoiceUser = {
  mobile?: string;
  userToken?: string;
  mobileBarcode?: string;
  [key: string]: unknown;
};

export type LoginParams =
  | {
      mobile: string;
      password: string;
      deviceId?: string;
      platform?: string;
      pushToken?: string;
    }
  | {
      Id: string;
      VerifyCode: string;
      DeviceID?: string;
      Platform?: string;
      PushToken?: string;
    };

export class EInvoiceProtocolUnavailableError extends Error {
  constructor(
    message = "財政部電子發票服務拒絕目前的 App 登入協定（代碼 6603）。這不是帳號密碼錯誤，也不是暫時忙碌；重複同步不會恢復，需改用新版協定或財政部正式 AppID API。",
  ) {
    super(message);
    this.name = "EInvoiceProtocolUnavailableError";
  }
}

export class EInvoiceClient {
  currentUser: EInvoiceUser | null;
  host: string;
  private headers: Record<string, string>;

  constructor({
    apiKey,
    appVersion,
    currentUser,
    host,
    os,
  }: {
    apiKey?: string;
    appVersion?: string;
    currentUser?: EInvoiceUser | null;
    host?: string;
    os?: string;
  } = {}) {
    this.host = host ?? BASE_URL;
    this.currentUser = currentUser ?? null;
    this.headers = {
      "Content-Type": "application/json",
      ApiKey: apiKey?.trim() || DEFAULT_API_KEY,
      AppVersion: appVersion?.trim() || DEFAULT_APP_VERSION,
      OS: os?.trim() || DEFAULT_OS,
    };
  }

  async post(path: string, body?: unknown) {
    const payload = this.normalizeRequestBody(path, body);
    let data = await this.send(path, payload);

    // The private App API returns a plain JSON 6608 response (while still
    // setting `encrypt: single`) when its protocol version changes. Follow the
    // version advertised by the service and retry login once so a future App
    // release does not require another emergency hard-coded version update.
    const requiredVersion =
      path === "User/Login" ? forcedUpgradeVersion(data) : undefined;
    if (requiredVersion && requiredVersion !== this.headers.AppVersion) {
      this.headers.AppVersion = requiredVersion;
      data = await this.send(path, payload);
    }

    if (path === "User/Login") this.setCurrentUserFromLogin(data);
    return data;
  }

  private async send(path: string, payload: unknown) {
    const { requestBody, cryptoKey, headers } = this.encryptRequest(payload);
    const res = await fetch(this.host + path, {
      method: "POST",
      headers: { ...this.headers, ...headers },
      body: requestBody,
    });
    return this.readResponse(res, path, cryptoKey);
  }

  async login(params: LoginParams) {
    const data = await this.post("User/Login", params);
    if (!this.currentUser) {
      const returnCode = responseReturnCode(data);
      const message = responseMessage(data);
      if (returnCode === "6603" || message === "目前系統繁忙，請稍後再試。") {
        throw new EInvoiceProtocolUnavailableError();
      }
      throw new Error(
        `${returnCode ? `代碼 ${returnCode}：` : ""}${message || "登入回應未包含使用者資料，請確認帳號、密碼與 App 版本。"}`,
      );
    }
    return data;
  }

  checkCarrierInvoices(params: unknown) {
    return this.post("Invoice/ChkCarrierInv", params);
  }

  checkCarrierInvoiceDetail(params: unknown) {
    return this.post("Invoice/ChkCarrierInvDetail", params);
  }

  private normalizeRequestBody(path: string, body?: unknown) {
    if (path !== "User/Login") return body;
    const loginBody = body as Partial<
      Extract<LoginParams, { mobile: string }>
    > &
      Partial<Extract<LoginParams, { Id: string }>>;
    if (!loginBody || loginBody.Id || loginBody.VerifyCode) return body;

    return {
      Id: loginBody.mobile,
      VerifyCode: loginBody.password,
      DeviceID: loginBody.deviceId ?? "http://OpenUDID.org",
      Platform: loginBody.platform ?? DEFAULT_OS,
      PushToken: loginBody.pushToken ?? "",
    };
  }

  private encryptRequest(body?: unknown) {
    const json = JSON.stringify(body ?? { "": "" });
    const user = this.currentUser;
    if (user?.mobile && user?.userToken) {
      const cryptoKey = aesEncryptString(user.mobile, user.userToken);
      return {
        cryptoKey,
        requestBody: aesEncryptString(json, cryptoKey),
        headers: {
          encrypt: "mixed",
          ValidationToken: cryptoKey,
          Token: user.userToken,
          UUID: "http://OpenUDID.org",
          ...(user.mobileBarcode ? { CarrierCode: user.mobileBarcode } : {}),
        },
      };
    }

    return {
      cryptoKey: singleResponseKey(),
      requestBody: rsaEncrypt(json),
      headers: { encrypt: "single" },
    };
  }

  private async readResponse(res: Response, path: string, cryptoKey?: string) {
    const encrypted = res.headers.get("encrypt")?.toLowerCase();
    const raw = await res.text();
    const plaintextJson = parseJson(raw);
    let data: unknown;

    // Maintenance and forced-upgrade responses can be plain JSON even when the
    // response still advertises an encrypted mode. Parse JSON before decrypting
    // so those errors remain readable instead of surfacing as a crypto URI error.
    if (plaintextJson.parsed) {
      data = plaintextJson.value;
    } else {
      let text = raw;
      try {
        if (raw && encrypted === "single")
          text = aesDecryptString(raw, singleResponseKey());
        if (raw && encrypted === "mixed" && cryptoKey)
          text = aesDecryptString(raw, cryptoKey);
      } catch {
        throw new Error(
          `電子發票服務回傳無法解讀（${path}），可能是官方 App 協定已更新。`,
        );
      }
      const decryptedJson = parseJson(text);
      data = decryptedJson.parsed ? decryptedJson.value : text;
    }

    if (!res.ok) {
      const message = responseMessage(data);
      throw new Error(
        `HTTP ${res.status} - ${path}${message ? `: ${message}` : ""}`,
      );
    }

    return data;
  }

  private setCurrentUserFromLogin(data: unknown) {
    const response = asRecord(data);
    const result = asRecord(response?.result ?? response?.Result);
    const rawUser = asRecord(result?.user ?? result?.User);
    if (!rawUser) return;

    const mobile = firstString(
      rawUser.mobile,
      rawUser.Mobile,
      rawUser.id,
      rawUser.Id,
    );
    const userToken = firstString(
      rawUser.userToken,
      rawUser.UserToken,
      rawUser.token,
      rawUser.Token,
    );
    const mobileBarcode = firstString(
      rawUser.mobileBarcode,
      rawUser.MobileBarcode,
      rawUser.carrierCode,
      rawUser.CarrierCode,
    );
    if (mobile && userToken)
      this.currentUser = { ...rawUser, mobile, userToken, mobileBarcode };
  }
}

function parseJson(text: string): { parsed: boolean; value?: unknown } {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("[")))
    return { parsed: false };
  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch {
    return { parsed: false };
  }
}

function responseMessage(data: unknown) {
  const response = asRecord(data);
  if (!response) return typeof data === "string" ? data : "";
  return firstString(
    response.Message,
    response.message,
    response.Msg,
    response.msg,
    response.Description,
    response.description,
  );
}

function responseReturnCode(data: unknown) {
  const response = asRecord(data);
  const value = response?.ReturnCode ?? response?.returnCode;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function forcedUpgradeVersion(data: unknown) {
  const response = asRecord(data);
  const returnCode = firstString(response?.ReturnCode, response?.returnCode);
  if (returnCode !== "6608") return undefined;

  const rawInfo = response?.Info ?? response?.info;
  let info = asRecord(rawInfo);
  if (!info && typeof rawInfo === "string") {
    const parsed = parseJson(rawInfo);
    info = parsed.parsed ? asRecord(parsed.value) : null;
  }

  const version = firstString(info?.VersionNumber, info?.versionNumber);
  return version && /^[0-9A-Za-z._-]{1,32}$/.test(version)
    ? version
    : undefined;
}

function asRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function aesEncryptString(text: string, keyText: string) {
  const cipher = createAesCipher("encrypt", keyText);
  cipher.update(forge.util.createBuffer(text, "utf8"));
  cipher.finish();
  return forge.util.encode64(cipher.output.getBytes());
}

function aesDecryptString(text: string, keyText: string) {
  const cipher = createAesCipher("decrypt", keyText);
  cipher.update(forge.util.createBuffer(forge.util.decode64(text), "raw"));
  if (!cipher.finish()) throw new Error("Invalid encrypted response");
  return cipher.output.toString();
}

function createAesCipher(direction: "encrypt" | "decrypt", keyText: string) {
  const key = forge.md.sha256
    .create()
    .update(keyText, "utf8")
    .digest()
    .getBytes();
  const iv = forge.md.md5.create().update(keyText, "utf8").digest().getBytes();
  const cipher =
    direction === "encrypt"
      ? forge.cipher.createCipher("AES-CBC", key)
      : forge.cipher.createDecipher("AES-CBC", key);
  cipher.start({ iv });
  return cipher;
}

function rsaEncrypt(text: string) {
  const publicKey = forge.pki.publicKeyFromPem(rsaPublicKeyPem());
  const bytes = forge.util.encodeUtf8(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 245) {
    chunks.push(
      publicKey.encrypt(bytes.slice(offset, offset + 245), "RSAES-PKCS1-V1_5"),
    );
  }
  return forge.util.encode64(chunks.join(""));
}

function rsaPublicKeyPem() {
  const key = forge.pki.setRsaPublicKey(
    new forge.jsbn.BigInteger(
      forge.util.bytesToHex(forge.util.decode64(rsaXmlValue("Modulus"))),
      16,
    ),
    new forge.jsbn.BigInteger(
      forge.util.bytesToHex(forge.util.decode64(rsaXmlValue("Exponent"))),
      16,
    ),
  );
  return forge.pki.publicKeyToPem(key);
}

function rsaXmlValue(name: string) {
  const match = RSA_PUBLIC_KEY.match(new RegExp(`<${name}>([^<]+)</${name}>`));
  if (!match) throw new Error(`Missing RSA key field: ${name}`);
  return match[1];
}

function singleResponseKey() {
  return forge.util.encode64(
    forge.md.sha256
      .create()
      .update(RSA_PUBLIC_KEY.slice(0, 16), "utf8")
      .digest()
      .getBytes(),
  );
}
