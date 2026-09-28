import { z } from "zod";
// Read-only protocol; source evidence is recorded in docs/firstrade-integration.md.
export const firstradeSessionSchema = z.object({
  state: z.enum(["delivery", "code", "authenticator", "ready"]),
  deadline: z.number().finite(),
  cookies: z.array(z.tuple([z.string(), z.string()])).max(100),
  sid: z.string(),
  ftat: z.string(),
  temporaryToken: z.string(),
  options: z
    .array(
      z.object({
        channel: z.enum(["sms", "email"]),
        recipientId: z.union([
          z.string(),
          z.number().int().nonnegative().safe(),
        ]),
        recipientMask: z.string(),
      }),
    )
    .max(20),
});
export type FirstradeSession = z.infer<typeof firstradeSessionSchema>;
const origin = "https://api3x.firstrade.com";
// Public application identifier used by the referenced open-source client;
// this is not a customer's authentication token.
const applicationToken = "833w3XuIFycv18ybi";
type ObjectData = Record<string, unknown>;
export interface FirstradePortfolioAccount {
  account: string;
  balance: ObjectData;
  positions: ObjectData[];
  positionsMarketValue?: number;
}
export class FirstradeReconciliationError extends Error {}
export class FirstradeApiError extends Error {
  constructor(
    public readonly kind:
      "transport" | "protocol" | "authentication" | "expired" | "state",
    public readonly step: string,
    public readonly status?: number,
  ) {
    super(`Firstrade ${step}: ${kind}`);
  }
}
function object(value: unknown, step: string): ObjectData {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FirstradeApiError("protocol", step);
  return value as ObjectData;
}
function string(value: unknown, step: string): string {
  if (typeof value !== "string" || !value || value.length > 8192)
    throw new FirstradeApiError("protocol", step);
  return value;
}
export type FirstradeChallenge =
  | { kind: "ready" }
  | { kind: "authenticator" }
  | {
      kind: "delivery";
      options: { index: number; channel: string; recipientMask: string }[];
    }
  | { kind: "code" };

export class FirstradeApiClient {
  private cookies = new Map<string, string>();
  private sid = "";
  private ftat = "";
  private temporaryToken = "";
  private options: ObjectData[] = [];
  private state:
    | "new"
    | "busy"
    | "delivery"
    | "code"
    | "authenticator"
    | "ready"
    | "closed" = "new";
  private deadline = 0;
  constructor(
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private now: () => number = Date.now,
    private observe: (step: string, payload: unknown) => void = () => {},
  ) {}
  clear() {
    this.cookies.clear();
    this.sid = this.ftat = this.temporaryToken = "";
    this.options = [];
    this.state = "closed";
    this.deadline = 0;
  }
  exportSession(): FirstradeSession {
    this.requireState(
      ["delivery", "code", "authenticator", "ready"],
      "session",
    );
    return firstradeSessionSchema.parse({
      state: this.state,
      deadline: this.deadline,
      cookies: [...this.cookies],
      sid: this.sid,
      ftat: this.ftat,
      temporaryToken: this.temporaryToken,
      options: this.options,
    });
  }
  restoreSession(value: FirstradeSession) {
    this.requireState(["new"], "restore");
    const session = firstradeSessionSchema.parse(value);
    this.state = session.state;
    this.deadline = session.deadline;
    this.cookies = new Map(session.cookies);
    this.sid = session.sid;
    this.ftat = session.ftat;
    this.temporaryToken = session.temporaryToken;
    this.options = session.options;
    this.requireState([session.state], "restore");
  }
  private requireState(states: string[], step: string) {
    if (!states.includes(this.state))
      throw new FirstradeApiError("state", step);
    if (this.deadline && this.now() >= this.deadline) {
      this.clear();
      throw new FirstradeApiError("expired", step);
    }
  }
  private async request(
    path: string,
    data?: Record<string, string>,
    bootstrap = false,
  ) {
    const step = path.split("?")[0];
    if (this.deadline && this.now() >= this.deadline) {
      this.clear();
      throw new FirstradeApiError("expired", step);
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "okhttp/4.9.2",
      "access-token": applicationToken,
    };
    if (this.cookies.size)
      headers.Cookie = [...this.cookies.values()].join("; ");
    if (this.sid) headers.sid = this.sid;
    if (this.ftat) headers.ftat = this.ftat;
    if (data) headers["Content-Type"] = "application/x-www-form-urlencoded";
    let response: Response;
    try {
      response = await this.fetcher(origin + path, {
        method: data ? "POST" : "GET",
        headers,
        body: data ? new URLSearchParams(data).toString() : undefined,
        // Workers supports manual redirects; non-2xx responses are rejected below.
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new FirstradeApiError("transport", step);
    }
    if (!response.ok)
      throw new FirstradeApiError(
        response.status === 401 || response.status === 403
          ? "authentication"
          : "transport",
        step,
        response.status,
      );
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair);
    }
    if (bootstrap) {
      await response.body?.cancel();
      return {};
    }
    let result: ObjectData;
    try {
      result = object(await response.json(), step);
    } catch {
      throw new FirstradeApiError("protocol", step, response.status);
    }
    // The observer must never persist payloads. The local probe emits types only.
    this.observe(step, result);
    if (
      result.error ||
      (typeof result.statusCode === "number" && result.statusCode !== 200)
    )
      throw new FirstradeApiError("authentication", step, response.status);
    return result;
  }
  private authenticate(result: ObjectData) {
    this.sid = string(result.sid, "session");
    this.ftat = string(result.ftat, "session");
    this.temporaryToken = "";
    this.options = [];
    this.state = "ready";
  }
  async login(username: string, password: string): Promise<FirstradeChallenge> {
    this.requireState(["new"], "login");
    if (!username || !password) throw new FirstradeApiError("state", "login");
    this.state = "busy";
    this.deadline = this.now() + 5 * 60_000;
    try {
      await this.request("/", undefined, true);
      const result = await this.request("/sess/login", { username, password });
      if (result.ftat && result.sid && !result.mfa) {
        this.authenticate(result);
        return { kind: "ready" };
      }
      this.temporaryToken = string(result.t_token, "login");
      if (result.mfa) {
        this.state = "authenticator";
        return { kind: "authenticator" };
      }
      if (!Array.isArray(result.otp))
        throw new FirstradeApiError("protocol", "login");
      this.options = result.otp
        .map((item) => object(item, "otp"))
        .filter((item) => item.channel === "sms" || item.channel === "email");
      if (!this.options.length) throw new FirstradeApiError("protocol", "otp");
      const options = this.options.map((item, index) => ({
        index,
        channel: String(item.channel),
        recipientMask: string(item.recipientMask, "otp").slice(0, 100),
      }));
      this.state = "delivery";
      return { kind: "delivery", options };
    } catch (error) {
      this.clear();
      throw error;
    }
  }
  async sendCode(index: number): Promise<FirstradeChallenge> {
    this.requireState(["delivery"], "send-code");
    const option = this.options[index];
    if (!Number.isInteger(index) || !option)
      throw new FirstradeApiError("state", "send-code");
    this.state = "busy";
    try {
      const result = await this.request("/sess/request_code", {
        recipientId:
          typeof option.recipientId === "number" &&
          Number.isSafeInteger(option.recipientId) &&
          option.recipientId >= 0
            ? String(option.recipientId)
            : string(option.recipientId, "send-code"),
        t_token: this.temporaryToken,
      });
      this.sid = string(result.verificationSid, "send-code");
      this.state = "code";
      return { kind: "code" };
    } catch (error) {
      this.clear();
      throw error;
    }
  }
  async verify(code: string) {
    this.requireState(["code", "authenticator"], "verify");
    if (!/^\d{6}$/.test(code)) throw new FirstradeApiError("state", "verify");
    const data: Record<string, string> =
      this.state === "authenticator"
        ? { mfaCode: code }
        : { otpCode: code, verificationSid: this.sid };
    this.state = "busy";
    try {
      // Omit remember_for: this probe does not request a remembered device.
      const result = await this.request("/sess/verify_pin", {
        ...data,
        t_token: this.temporaryToken,
      });
      this.authenticate(result);
    } catch (error) {
      this.clear();
      throw error;
    }
  }
  async readPortfolio(
    validate?: (accounts: FirstradePortfolioAccount[]) => Promise<unknown>,
  ): Promise<FirstradePortfolioAccount[]> {
    this.requireState(["ready"], "portfolio");
    this.state = "busy";
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const listing = await this.request("/private/acct_list");
          if (!Array.isArray(listing.items))
            throw new FirstradeApiError("protocol", "accounts");
          const accounts = [];
          const seen = new Set<string>();
          for (const row of listing.items) {
            const account = string(object(row, "accounts").account, "accounts");
            if (seen.has(account))
              throw new FirstradeApiError("protocol", "accounts");
            seen.add(account);
            const query = `account=${encodeURIComponent(account)}`;
            const balances = await this.request(`/private/balances?${query}`);
            const positions: ObjectData[] = [];
            let total: number | undefined;
            let pages: number | undefined;
            let positionsMarketValue: number | undefined;
            for (let page = 1; ; page++) {
              if (page > 100)
                throw new FirstradeApiError("protocol", "positions-limit");
              const response = await this.request(
                `/private/positions?${query}&per_page=200&page=${page}`,
              );
              if (
                response.account !== account ||
                response.page !== page ||
                !Number.isInteger(response.pages) ||
                Number(response.pages) < 0 ||
                Number(response.pages) > 100 ||
                (Number(response.total) > 0 && Number(response.pages) < page) ||
                !Number.isInteger(response.total) ||
                Number(response.total) < 0 ||
                !Array.isArray(response.items)
              )
                throw new FirstradeApiError("protocol", "positions");
              if (total !== undefined && total !== response.total)
                throw new FirstradeApiError("protocol", "positions-changed");
              if (pages !== undefined && pages !== response.pages)
                throw new FirstradeApiError(
                  "protocol",
                  "positions-pages-changed",
                );
              if (response.total_market_value !== undefined) {
                if (
                  typeof response.total_market_value !== "number" ||
                  !Number.isFinite(response.total_market_value)
                )
                  throw new FirstradeApiError("protocol", "positions-value");
                if (
                  positionsMarketValue !== undefined &&
                  positionsMarketValue !== response.total_market_value
                )
                  throw new FirstradeReconciliationError(
                    "Firstrade 持倉分頁期間估值已變動，未更新資料；既有資料不受影響。",
                  );
                positionsMarketValue = response.total_market_value;
              }
              pages = Number(response.pages);
              total = Number(response.total);
              positions.push(
                ...response.items.map((item) => object(item, "positions")),
              );
              if (page >= Number(response.pages)) break;
              if (!response.items.length)
                throw new FirstradeApiError("protocol", "positions-empty-page");
            }
            if (positions.length !== total)
              throw new FirstradeApiError("protocol", "positions-count");
            const balance = object(balances.result, "balances");
            if (balance.account !== account)
              throw new FirstradeApiError("protocol", "balances-account");
            accounts.push({
              account,
              balance,
              positions,
              positionsMarketValue,
            });
          }
          await validate?.(accounts);
          return accounts;
        } catch (error) {
          // Only repeat read-only portfolio queries, once in the same session.
          // Never repeat credentials, OTP, or arbitrary protocol failures.
          if (
            attempt === 0 &&
            error instanceof FirstradeReconciliationError &&
            this.now() < this.deadline
          )
            continue;
          throw error;
        }
      }
    } finally {
      // No verified server logout endpoint yet. Discard local credentials only;
      // the probe must not claim that the server session has been logged out.
      this.clear();
    }
  }
}
