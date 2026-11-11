import { z } from "zod";
import type {
  ConnectorSessionState,
  SinotradeVerificationChallenge,
} from "@taiwan-fin-hub/shared";
import type { SourceSyncError, SourceSyncErrorSource } from "../sync-error";

export const SINOTRADE_ORIGINS = {
  newweb: "https://www.sinotrade.com.tw",
  savings: "https://aiinvest.sinotrade.com.tw",
} as const;
export type SinotradePlatform = keyof typeof SINOTRADE_ORIGINS;

export const sinotradeVerificationInputSchema = z.object({
  action: z.enum([
    "confirm_certificate",
    "submit_birthday",
    "request_otp",
    "verify_otp",
    "accept_terms",
  ]),
  values: z
    .object({
      birthday: z
        .string()
        .max(10)
        .regex(/^[0-9-]*$/)
        .optional(),
      birthdayYear: z.string().max(4).regex(/^\d*$/).optional(),
      birthdayMonth: z.string().max(2).regex(/^\d*$/).optional(),
      birthdayDay: z.string().max(2).regex(/^\d*$/).optional(),
      // Choices are submitted as the position of the official option, never its text.
      otpChannel: z.string().max(2).regex(/^\d*$/).optional(),
      otpTarget: z.string().max(2).regex(/^\d*$/).optional(),
      otp: z
        .string()
        .max(32)
        .regex(/^[a-zA-Z0-9]*$/)
        .optional(),
      agreement: z.literal("true").optional(),
    })
    .strict()
    .default({}),
});

/** 自動填寫僅限官方登入及憑證頁；不得操作帳務、下單或其他網站。 */
export function isSinotradeLoginUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.origin === SINOTRADE_ORIGINS.newweb)
    return (
      /^\/newweb\/SinoTrade_login\/?$/i.test(url.pathname) ||
      url.pathname === "/signature/webcaFrm.html"
    );
  if (url.origin === SINOTRADE_ORIGINS.savings)
    return (
      /^\/Login\/?$/i.test(url.pathname) ||
      url.pathname === "/Content/CA/webcaFrm.html"
    );
  return (
    url.origin === "https://ca.sinotrade.com.tw" &&
    /^\/WebCA(?:Ex)?\//.test(url.pathname)
  );
}

const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
});
const originStateSchema = z.object({
  authenticated: z.boolean().optional(),
  cookies: z.array(cookieSchema),
  localStorage: z.record(z.string(), z.string()),
  capturedAt: z.string().datetime(),
});

export const sinotradeConfigSchema = z.object({
  userId: z.string().min(1).max(10).optional(),
  password: z.string().min(1).max(64).optional(),
  webState: z
    .object({
      newweb: originStateSchema.optional(),
      savings: originStateSchema.optional(),
    })
    .optional(),
  browserSessionId: z.string().optional(),
  browserSessionExpiresAt: z.string().datetime().optional(),
  loginPlatform: z.enum(["newweb", "savings"]).optional(),
});
export type SinotradeConfig = z.infer<typeof sinotradeConfigSchema>;
export type SinotradeOriginState = z.infer<typeof originStateSchema>;
export const parseSinotradeConfig = (value: unknown) =>
  sinotradeConfigSchema.parse(value);

export function describeSinotradeSession(
  stored: Record<string, unknown>,
): Partial<ConnectorSessionState> {
  const parsed = sinotradeConfigSchema.safeParse(stored);
  if (!parsed.success) return {};
  const config = parsed.data;
  const newweb = Boolean(
    config.webState?.newweb && config.webState.newweb.authenticated !== false,
  );
  const savings = Boolean(
    config.webState?.savings && config.webState.savings.authenticated !== false,
  );
  return {
    sinotradePlatforms: {
      newweb,
      savings,
    },
    sessionAvailable: newweb && savings,
    verificationPending: Boolean(
      config.browserSessionId &&
      Date.parse(config.browserSessionExpiresAt ?? "") > Date.now(),
    ),
    verificationExpiresAt: config.browserSessionExpiresAt ?? null,
  };
}

/** 只保存官方網站已確認的登入項目，排除行銷追蹤與其他 origin 的資料。 */
export function selectSinotradeStorage(
  platform: SinotradePlatform,
  storage: Record<string, string>,
) {
  const result: Record<string, string> = {};
  const keys = platform === "newweb" ? ["newweb_token", "acnts", "userID"] : [];
  for (const key of keys) if (storage[key]) result[key] = storage[key];
  const reference = storage.TWCACertIdxRef;
  if (reference) {
    let index: unknown;
    try {
      index = JSON.parse(reference);
    } catch {
      throw new SinotradeConnectionError("憑證索引格式無法辨識，請重新連線。");
    }
    if (!index || typeof index !== "object" || Array.isArray(index))
      throw new SinotradeConnectionError("憑證索引格式無法辨識，請重新連線。");
    result.TWCACertIdxRef = reference;
    for (const key of Object.keys(index)) {
      if (!/^TWCA\d+$/.test(key) || !storage[key])
        throw new SinotradeConnectionError("憑證資料不完整，請重新連線。");
      result[key] = storage[key];
    }
  }
  return result;
}

const CERTIFICATE_STORAGE_KEY = /^(?:TWCACertIdxRef|TWCA\d+)$/;

/**
 * The official site deploys one certificate to every platform (the same entry in each one's
 * storage). A platform without its own saved certificate starts from the other's, so one OTP
 * covers both and a never-saved platform does not issue a second certificate, which could
 * replace the first.
 */
export function restorableSinotradeState(
  webState: SinotradeConfig["webState"],
  platform: SinotradePlatform,
): SinotradeOriginState | undefined {
  const own = webState?.[platform];
  if (own?.localStorage.TWCACertIdxRef) return own;
  const other = webState?.[platform === "newweb" ? "savings" : "newweb"];
  const certificate = Object.fromEntries(
    Object.entries(other?.localStorage ?? {}).filter(([key]) =>
      CERTIFICATE_STORAGE_KEY.test(key),
    ),
  );
  if (!other || !certificate.TWCACertIdxRef) return own;
  return {
    authenticated: false,
    cookies: own?.cookies ?? [],
    localStorage: { ...own?.localStorage, ...certificate },
    capturedAt: own?.capturedAt ?? other.capturedAt,
  };
}

export function isSinotradeCookie(
  platform: SinotradePlatform,
  cookie: { name: string; domain: string },
) {
  const domain = cookie.domain.replace(/^\./, "");
  const originHost = new URL(SINOTRADE_ORIGINS[platform]).hostname;
  if (
    domain !== originHost &&
    domain !== "sinotrade.com.tw" &&
    !(platform === "newweb" && domain === "service.sinotrade.com.tw")
  )
    return false;
  return /^(?:ASP\.NET_SessionId|TS[0-9a-f]+|aiinvest(?:_P|_A|_OpenUrlPara)?|AiinvestAntiForgery|client_ip)$/i.test(
    cookie.name,
  );
}

export type SinotradeAccount = {
  brokerNo: string;
  brokerAccount: string;
  market: "TW" | "US";
};

/** Only a logged-in 豐存股 page has this link; the login page does not. */
export const SINOTRADE_SAVINGS_LOGOUT_SELECTOR = 'a[href="/Login/Logout"]';

export function parseSavingsAccountIdentities(
  payload: unknown,
): SinotradeAccount[] {
  const parsed = z
    .object({
      Data: z.object({
        ActsData: z.array(
          z.object({
            AccType: z.string(),
            Broker: z.string().min(1),
            Act: z.string().min(1),
          }),
        ),
      }),
    })
    .safeParse(payload);
  if (!parsed.success)
    throw new SinotradeConnectionError("豐存股帳戶資料無法辨識，請重新連線。");
  // Same account types as the new site: S is the Taiwan account, H the overseas one.
  return parsed.data.Data.ActsData.flatMap((row) =>
    row.AccType === "S" || row.AccType === "H"
      ? [
          {
            brokerNo: row.Broker,
            brokerAccount: row.Act,
            market: row.AccType === "S" ? ("TW" as const) : ("US" as const),
          },
        ]
      : [],
  );
}
export function parseSinotradeAccounts(value: unknown): SinotradeAccount[] {
  const schema = z.array(
    z.object({
      broker_id: z.string().min(1),
      account: z.string().min(1),
      accttype: z.string(),
    }),
  );
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new SinotradeConnectionError(
      "新理財網帳戶資料無法辨識，請重新登入。",
    );
  const accounts = parsed.data.filter(
    (a) => a.accttype === "S" || a.accttype === "H",
  );
  if (!accounts.length)
    throw new SinotradeConnectionError(
      "找不到可查詢的證券帳戶，請確認登入狀態。",
    );
  const result = accounts.map((a) => ({
    brokerNo: a.broker_id,
    brokerAccount: a.account,
    market: a.accttype === "S" ? ("TW" as const) : ("US" as const),
  }));
  const identities = result.map(
    (a) => `${a.market}:${a.brokerNo}:${a.brokerAccount}`,
  );
  if (new Set(identities).size !== identities.length)
    throw new SinotradeConnectionError("新理財網回傳重複帳戶，未更新持倉。");
  return result;
}

export class SinotradeConnectionError
  extends Error
  implements SourceSyncErrorSource
{
  constructor(message = "請先完成證券連線驗證，再重新同步。") {
    super(message);
    this.name = "SinotradeConnectionError";
  }
  toSyncError(): SourceSyncError {
    return {
      status: 400,
      code: "SINOTRADE_CONNECTION_REQUIRED",
      needsUserAction: true,
    };
  }
}

/** 只有官方明確表示未登入時，才允許互動流程重新提交帳密。 */
export class SinotradeAuthenticationRequiredError extends SinotradeConnectionError {
  constructor(message = "永豐證券登入已失效，請重新連線。") {
    super(message);
    this.name = "SinotradeAuthenticationRequiredError";
  }
}

export function isSinotradeAuthenticationRequiredError(
  error: unknown,
): error is SinotradeAuthenticationRequiredError {
  return error instanceof SinotradeAuthenticationRequiredError;
}

const PLATFORM_LABELS: Record<SinotradePlatform, string> = {
  newweb: "新理財網",
  savings: "豐存股",
};

/**
 * 同步時以已儲存的帳密與憑證自動重新登入，但官方沒有讓它完成。之後的同步不得再送出帳密，
 * 直到使用者重新連線：反覆送出被拒絕的密碼可能鎖住證券帳戶。
 */
export class SinotradeUnattendedLoginError extends SinotradeConnectionError {
  constructor(
    readonly platform: SinotradePlatform,
    /** 停下來的官方步驟；`not_authenticated` 表示登入後官方仍回應未登入。 */
    readonly step: SinotradeVerificationChallenge["step"] | "not_authenticated",
    detail?: string,
  ) {
    super(
      `永豐證券${PLATFORM_LABELS[platform]}登入已失效，自動重新登入未完成${
        detail ? `（${detail}）` : ""
      }，請到設定頁重新連線。`,
    );
    this.name = "SinotradeUnattendedLoginError";
  }
}

export class SinotradeLoginExpiredError extends SinotradeConnectionError {
  constructor() {
    super("登入驗證已關閉或逾時，請取消後重新連線。");
  }
}
