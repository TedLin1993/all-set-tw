import type {
  Browser,
  Dialog,
  Frame,
  Page,
  Target,
} from "@cloudflare/puppeteer";
import type {
  SinotradeVerificationChallenge,
  SinotradeVerificationField,
  SinotradeVerificationFieldKey,
  SinotradeVerificationInput,
  SinotradeVerificationAction,
} from "@taiwan-fin-hub/shared";
import {
  isSinotradeLoginUrl,
  SINOTRADE_ORIGINS,
  SINOTRADE_SAVINGS_LOGOUT_SELECTOR,
  SinotradeConnectionError,
  type SinotradeConfig,
  type SinotradePlatform,
} from "./session-protocol";

const CERTIFICATE_HOST = "ca.sinotrade.com.tw";
/** Passed into the page: evaluated functions cannot capture module scope. */
const PAGE_SELECTORS = {
  // body only becomes a scope on the certificate origin, where the whole page is one flow.
  scope: 'form,[role="dialog"],.ant-modal-confirm,#backgroundDiv,body',
  control: "input,select",
  button:
    'button,input[type="button"],input[type="submit"],a[role="button"],a.btn',
} as const;
type PageSelectors = typeof PAGE_SELECTORS;

type Input = {
  index: number;
  id: string;
  name: string;
  description: string;
  type: string;
  maxLength: number;
  kind?: "text" | "radio" | "checkbox" | "select";
  /** Visible label of a radio or checkbox. */
  label?: string;
  checked?: boolean;
  /** Selectable option labels of a select; options without a value are left out. */
  options?: string[];
  selected?: number;
};
type Button = { index: number; label: string; disabled?: boolean };
export type SinotradeLoginForm = {
  scope: number | null;
  hasVisibleInputs?: boolean;
  inputs: Input[];
  buttons: Button[];
  certificatePrompt: boolean;
  recaptchaVisible: boolean;
  rejected?: boolean;
  /** The public terms the user must read before agreeing; never account text. */
  agreementText?: string;
  /** The official login refused a certificate it has not recorded yet (rcode 8040). */
  certificateRecordMissing?: boolean;
};
/** A radio group is one field backed by several official inputs (members). */
type Binding = { control: Input; members?: Input[] };
type VerificationForm = {
  scope?: number;
  challenge: SinotradeVerificationChallenge;
  inputs: Partial<Record<SinotradeVerificationFieldKey, Binding>>;
  buttons: Partial<
    Record<SinotradeVerificationAction, Pick<Button, "index" | "label">>
  >;
};

const STEP_CHANGED = "驗證步驟已變更，請更新驗證狀態。";
const FIELD_CHANGED = "驗證欄位已變更，請更新驗證狀態。";
const PAGE_SWITCHING = "官方頁面仍在切換，請稍後按「更新驗證狀態」。";
const REQUEST_OTP_LABEL =
  /^(?:取得|發送|傳送|寄送|重送|重新取得|重新發送)(?:簡訊)?(?:驗證碼|認證碼|OTP)$/i;
const SUBMIT_LABEL =
  /^(?:確認|確定|驗證|送出|下一步|確認送出|確認驗證|驗證並繼續)$/;
const CHANNEL_LABEL =
  /^(?:手機|行動電話|簡訊|SMS|E-?mail|電子(?:信箱|郵件)|信箱)/i;
const REJECTED_OR_FINAL = /reCAPTCHA|日期格式|未接受|尚未登記/;
// Raised while a page is navigating or closing; the next poll sees the settled page.
const TRANSIENT_PAGE_ERROR =
  /Execution context|Cannot find context|Target closed|Session closed|Connection closed|detached|Inspected target navigated/i;

const INSPECT_TIMEOUT_MS = 10_000;
// Issuing and deploying the certificate, then the official page's own alert.
const CERTIFICATE_IMPORT_TIMEOUT_MS = 60_000;
// The official RA database can lag behind a newly issued certificate (rcode 8040), so the
// first sign-in may be refused although the same sign-in works a little later. Retry within
// the budget: the whole request must still answer before the edge's 100 second limit.
const CERTIFICATE_RECORD_RETRY_DELAYS_MS = [
  4_000, 8_000, 12_000, 16_000, 20_000,
];
const CERTIFICATE_FINISH_BUDGET_MS = 85_000;
// 每次重試送出後，最多還會等官方回應 waitForVerification 的 12 秒；預算要把這段留給最後一次。
const CERTIFICATE_SUBMIT_RESERVE_MS = 12_000;
const CERTIFICATE_RECORD_MISSING =
  "官方系統尚未登記剛簽發的憑證（rcode 8040），已自動重試仍未完成。請取消後重新連線。";

/** The page cannot answer, typically because a dialog is waiting for a reply. */
class PageUnresponsiveError extends SinotradeConnectionError {
  constructor() {
    super(
      "官方頁面暫時沒有回應，請稍後按「更新驗證狀態」；若持續沒有回應，請取消後重新連線。",
    );
    this.name = "PageUnresponsiveError";
  }
}

const blocked = (message: string): SinotradeVerificationChallenge => ({
  step: "blocked",
  fields: [],
  actions: [],
  message,
});
const isTransientPageError = (error: unknown) =>
  error instanceof Error && TRANSIENT_PAGE_ERROR.test(error.message);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanLabel = (value: string | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Only metadata leaves the official page: no field values, HTML or account text. The one
 * exception is the certificate terms, public text the user needs to read before consenting.
 */
function readLoginForm(
  selectors: PageSelectors,
  certificatePage: boolean,
): SinotradeLoginForm {
  // Inputs and selects share the properties used here; selects are cast where needed.
  type Control = HTMLInputElement;
  const visible = (el: Element) => {
    if (getComputedStyle(el).visibility === "hidden") return false;
    for (let node: Element | null = el; node; node = node.parentElement)
      if (getComputedStyle(node).display === "none") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const text = (value: string | null | undefined) =>
    (value ?? "").replace(/\s+/g, " ").trim();
  const kindOf = (el: Control) => {
    if (el.tagName === "SELECT")
      return el.type === "select-one" ? ("select" as const) : null;
    if (el.type === "radio" || el.type === "checkbox") return el.type;
    return ["hidden", "submit", "button", "file", "image", "reset"].includes(
      el.type,
    )
      ? null
      : ("text" as const);
  };
  const labelElement = (el: Control) => el.labels?.[0] ?? el.closest("label");
  const labelText = (el: Control) => {
    const label = labelElement(el);
    if (label) return text(label.textContent);
    const next = el.nextSibling;
    if (next?.nodeType === 3 && text(next.textContent))
      return text(next.textContent);
    const sibling = el.nextElementSibling;
    if (sibling && ["LABEL", "SPAN"].includes(sibling.tagName))
      return text(sibling.textContent);
    const parent = text(el.parentElement?.textContent);
    return parent.length <= 80 ? parent : "";
  };
  const description = (el: Control) =>
    [
      el.id,
      el.name,
      (el as HTMLInputElement).placeholder,
      el.getAttribute("aria-label"),
      ...Array.from(el.labels ?? [], (label) => label.textContent),
    ].join(" ");
  const editable = (el: Control) => {
    const kind = kindOf(el);
    if (
      !kind ||
      el.disabled ||
      (kind === "text" && (el as HTMLInputElement).readOnly)
    )
      return false;
    // Custom-styled radios and checkboxes are often hidden behind their label.
    const label =
      kind === "radio" || kind === "checkbox" ? labelElement(el) : null;
    return visible(el) || Boolean(label && visible(label));
  };
  const allControls = Array.from(
    document.querySelectorAll<Control>(selectors.control),
  );
  const scopes = Array.from(
    document.querySelectorAll<HTMLElement>(selectors.scope),
  );
  const promptContainers = scopes.filter(
    (el) =>
      visible(el) &&
      el.matches('[role="dialog"],.ant-modal-confirm') &&
      /憑證/.test(el.innerText) &&
      /是否載入憑證/.test(el.innerText),
  );
  // Ant Design wraps its confirmation card in another role=dialog container.
  // These are one prompt; keep the innermost card as the control boundary.
  const prompts = promptContainers.filter(
    (el) =>
      !promptContainers.some((inner) => inner !== el && el.contains(inner)),
  );
  const hasVerificationInput = (el: Element) =>
    Array.from(el.querySelectorAll<HTMLInputElement>("input")).some(
      (input) =>
        editable(input) &&
        /birthday|birthdate|birth|bday|dob|otp|sms.*code|verifycode|verify_code|生日|出生|生年月日|簡訊驗證|簡訊認證|動態密碼|一次性密碼/i.test(
          description(input),
        ),
    );
  const forms = scopes.filter(
    (el) => el.tagName === "FORM" && visible(el) && hasVerificationInput(el),
  );
  const dialogs = scopes.filter(
    (el) =>
      el.matches('[role="dialog"]') && visible(el) && hasVerificationInput(el),
  );
  // Every control on the certificate origin belongs to its single flow, but the
  // fields and buttons are still mapped by exact, known meaning below.
  const candidates =
    certificatePage && document.body
      ? [document.body]
      : prompts.length
        ? prompts
        : forms.length
          ? forms
          : dialogs;
  const scope = candidates.length === 1 ? candidates[0] : undefined;
  const recaptchaVisible = Array.from(
    document.querySelectorAll<HTMLIFrameElement>('iframe[src*="recaptcha"]'),
  ).some((el) => visible(el) && el.getBoundingClientRect().height > 50);
  const certificateRecordMissing = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"],.ant-modal'),
  ).some(
    (el) =>
      visible(el) && /rcode=8040|查無此筆憑證紀錄/.test(el.textContent ?? ""),
  );
  if (!scope)
    return {
      scope: null,
      hasVisibleInputs: allControls.some(editable),
      inputs: [],
      buttons: [],
      certificatePrompt: false,
      recaptchaVisible,
      ...(certificateRecordMissing ? { certificateRecordMissing } : {}),
    };
  const birthContext =
    scope.innerText?.match(
      /(?:生日|出生日期|出生年月日|生年月日)[^\n]{0,60}/,
    )?.[0] ?? "";
  const dateFormat = /民國/.test(birthContext)
    ? " YYYMMDD"
    : /西元|YYYYMMDD/i.test(birthContext)
      ? " YYYYMMDD"
      : "";
  const inputs = allControls
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => scope.contains(el) && editable(el))
    .map(({ el, index }): Input => {
      const kind = kindOf(el)!;
      const input: Input = {
        index,
        id: el.id,
        name: el.name,
        type: el.type,
        kind,
        maxLength: kind === "text" ? (el as HTMLInputElement).maxLength : -1,
        description: description(el) + dateFormat,
      };
      if (kind === "radio" || kind === "checkbox") {
        input.label = labelText(el);
        input.checked = (el as HTMLInputElement).checked;
      }
      if (kind === "select") {
        const options = Array.from(
          (el as unknown as HTMLSelectElement).options,
        ).filter((option) => option.value !== "" && !option.disabled);
        input.options = options.map((option) => text(option.textContent));
        input.selected = options.findIndex((option) => option.selected);
      }
      return input;
    });
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      selectors.button,
    ),
  )
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => scope.contains(el) && visible(el))
    .map(({ el, index }) => ({
      index,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
      label: (el instanceof HTMLInputElement
        ? el.value
        : (el.textContent ?? "")
      ).replace(/\s+/g, ""),
    }));
  const agreement = certificatePage
    ? document.getElementById("webcaAgreement")
    : null;
  const agreementText =
    agreement && visible(agreement)
      ? agreement.innerText
          .split("\n")
          .map(text)
          .filter((line) => line && !line.startsWith("我已閱讀並同意"))
          .join("\n")
          .slice(0, 12_000)
      : "";
  return {
    scope: scopes.indexOf(scope),
    hasVisibleInputs: inputs.length > 0,
    inputs,
    buttons,
    certificatePrompt: prompts.includes(scope),
    recaptchaVisible,
    ...(certificateRecordMissing ? { certificateRecordMissing } : {}),
    ...(agreementText ? { agreementText } : {}),
    rejected: Array.from(
      scope.querySelectorAll(
        '[role="alert"],.ant-modal-error,.field-validation-error,.validation-summary-errors,[id^="errMsg"]',
      ),
    ).some((el) => visible(el) && Boolean(el.textContent?.trim())),
  };
}

/** Maps the observed certificate pages to this app's fields and explicit actions. */
export function describeSinotradeLoginForm(
  form: SinotradeLoginForm,
): VerificationForm {
  const result: VerificationForm = {
    challenge: blocked(
      "尚未確認登入完成，請更新驗證狀態；若仍無法繼續，請取消後重新連線。",
    ),
    inputs: {},
    buttons: {},
  };
  if (form.rejected) {
    result.challenge = blocked("官方未接受此登入或驗證資料，請確認後再試。");
  }
  if (form.certificateRecordMissing) {
    result.challenge = blocked(CERTIFICATE_RECORD_MISSING);
    return result;
  }
  if (form.recaptchaVisible) {
    result.challenge = blocked(
      "官方要求額外的 reCAPTCHA 安全驗證，目前無法透過此表單完成。請稍後重新連線。",
    );
    return result;
  }
  if (form.scope === null) return result;
  result.scope = form.scope;
  if (form.certificatePrompt) {
    const yes = form.buttons.find((button) => button.label === "是");
    if (yes) {
      result.buttons.confirm_certificate = yes;
      result.challenge = {
        step: "certificate",
        fields: [],
        actions: ["confirm_certificate"],
        message: "官方要求載入電子憑證，請確認後繼續。",
      };
    }
    return result;
  }
  const entries: Array<{ order: number; field: SinotradeVerificationField }> =
    [];
  const radioGroups = new Map<string, Input[]>();
  let recognized = 0;
  for (const input of form.inputs) {
    const kind = input.kind ?? "text";
    if (kind === "radio") {
      radioGroups.set(input.name, [
        ...(radioGroups.get(input.name) ?? []),
        input,
      ]);
      continue;
    }
    if (kind === "checkbox") {
      // Agreeing is the user's decision: only a clearly labelled consent is offered.
      if (
        result.inputs.agreement ||
        !/同意|agree/i.test(`${input.label ?? ""} ${input.description}`)
      )
        return result;
      recognized++;
      result.inputs.agreement = { control: input };
      entries.push({
        order: input.index,
        field: {
          key: "agreement",
          label: cleanLabel(input.label) || "我已閱讀並同意條款",
          action: "accept_terms",
          type: "checkbox",
        },
      });
      continue;
    }
    if (kind === "select") {
      const options = input.options ?? [];
      if (
        result.inputs.otpTarget ||
        !/phone|mobile|e-?mail/i.test(input.description) ||
        !options.length
      )
        return result;
      recognized++;
      result.inputs.otpTarget = { control: input };
      // The only official choice, already selected, needs no decision.
      if (options.length === 1 && input.selected === 0) continue;
      entries.push({
        order: input.index,
        field: {
          key: "otpTarget",
          label: "接收驗證碼的手機或信箱",
          action: "request_otp",
          type: "choice",
          options: options.map((label, index) => ({
            value: String(index),
            label: cleanLabel(label),
          })),
          ...(input.selected !== undefined && input.selected >= 0
            ? { value: String(input.selected) }
            : {}),
        },
      });
      continue;
    }
    let key: SinotradeVerificationFieldKey | undefined;
    let label = "";
    let hint: string | undefined;
    const text = input.description;
    if (
      /(?:birthday|birthdate|birth|bday|dob|生日|出生|生年月日)/i.test(text)
    ) {
      key = "birthday";
      label = "生日";
      if (input.maxLength > 0 && input.maxLength <= 4) {
        if (/year|年份|出生年|生日年/i.test(text)) {
          key = "birthdayYear";
          label = "出生年";
        } else if (/month|月份|出生月|生日月/i.test(text)) {
          key = "birthdayMonth";
          label = "出生月";
        } else if (
          /(?:[_-]day|birthDayOfMonth|日期|出生日|生日日期)/i.test(text)
        ) {
          key = "birthdayDay";
          label = "出生日";
        }
      }
      if (key === "birthday") {
        if (input.type === "date") hint = "西元 YYYY-MM-DD";
        else if (/民國|YYYMMDD/.test(text) && !/YYYYMMDD/.test(text))
          hint = "民國 YYYMMDD";
        else if (/西元|YYYYMMDD/i.test(text)) hint = "西元 YYYYMMDD";
        else {
          result.challenge = blocked(
            "官方生日欄位的日期格式尚未確認，未提交資料。請取消後重新連線。",
          );
          return result;
        }
      }
    } else if (
      /(?:otp|sms.*code|verifycode|verify_code|簡訊驗證|簡訊認證|動態密碼|一次性密碼)/i.test(
        text,
      )
    ) {
      key = "otp";
      label = "驗證碼（OTP）";
    }
    if (!key || (!input.id && !input.name)) continue;
    if (result.inputs[key] !== undefined) return result;
    result.inputs[key] = { control: input };
    recognized++;
    entries.push({
      order: input.index,
      field: {
        key,
        label,
        action: key === "otp" ? "verify_otp" : "submit_birthday",
        ...(hint ? { hint } : {}),
        ...(input.maxLength > 0 && input.maxLength <= 32
          ? { maxLength: input.maxLength }
          : {}),
      },
    });
  }
  for (const members of radioGroups.values()) {
    const labels = members.map((member) => cleanLabel(member.label));
    if (
      result.inputs.otpChannel ||
      members.length < 2 ||
      !labels.every((label) => CHANNEL_LABEL.test(label))
    )
      return result;
    recognized += members.length;
    result.inputs.otpChannel = { control: members[0]!, members };
    const checked = members.findIndex((member) => member.checked);
    entries.push({
      order: members[0]!.index,
      field: {
        key: "otpChannel",
        label: "驗證碼收取方式",
        action: "request_otp",
        type: "choice",
        options: labels.map((label, index) => ({
          value: String(index),
          label,
        })),
        ...(checked >= 0 ? { value: String(checked) } : {}),
      },
    });
  }
  // Unknown inputs may be a different workflow (e.g. a password change). Never guess.
  if (recognized !== form.inputs.length) return result;
  const hasBirthday = entries.some(
    (entry) => entry.field.action === "submit_birthday",
  );
  const submitAction: SinotradeVerificationAction | undefined = result.inputs
    .agreement
    ? "accept_terms"
    : result.inputs.otp
      ? "verify_otp"
      : hasBirthday
        ? "submit_birthday"
        : undefined;
  for (const button of form.buttons) {
    const action = REQUEST_OTP_LABEL.test(button.label)
      ? "request_otp"
      : SUBMIT_LABEL.test(button.label)
        ? submitAction
        : undefined;
    if (!action) continue;
    // Two matching buttons: never guess which one to press.
    if (result.buttons[action]) return result;
    result.buttons[action] = button;
  }
  const actions = Object.keys(result.buttons) as SinotradeVerificationAction[];
  // The official send button only appears after a way to receive the code is chosen.
  if (result.inputs.otpChannel && !actions.includes("request_otp"))
    actions.unshift("request_otp");
  if (!actions.length) return result;
  const fields = entries
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.field);
  const step = result.inputs.agreement
    ? "terms"
    : hasBirthday
      ? "birthday"
      : "otp";
  result.challenge = {
    step,
    fields,
    actions,
    ...(form.rejected
      ? { message: "官方未接受此驗證資料，請確認後再試。" }
      : step === "terms"
        ? {
            message: form.agreementText
              ? "請先閱讀下方條款，確認後勾選同意再繼續。"
              : "官方要求同意憑證作業條款，同意後才會簽發並匯入憑證。",
          }
        : step === "otp"
          ? {
              message: result.inputs.otp
                ? "驗證碼已寄出，請輸入收到的驗證碼。"
                : "請選擇驗證碼收取方式，再按「寄送驗證碼」；系統不會自動寄送。",
            }
          : {}),
    ...(step === "terms" && form.agreementText
      ? { document: { title: "憑證作業條款", text: form.agreementText } }
      : {}),
  };
  return result;
}

async function platformPages(browser: Browser, platform: SinotradePlatform) {
  const pages = await browser.pages();
  const root = pages
    .filter((page) => page.url().startsWith(SINOTRADE_ORIGINS[platform] + "/"))
    .at(-1);
  if (!root)
    throw new SinotradeConnectionError("登入工作階段已關閉，請重新連線。");
  const rootTarget = root.target();
  const related = pages.filter((page) => {
    if (page === root) return true;
    for (let target = page.target().opener(); target; target = target.opener())
      if (target === rootTarget) return true;
    return false;
  });
  return { root, related };
}

async function inspect(
  browser: Browser,
  platform: SinotradePlatform,
): Promise<VerificationForm & { frame: Frame }> {
  const { root, related } = await platformPages(browser, platform);
  let unknownCertificateForm: (VerificationForm & { frame: Frame }) | undefined;
  for (const page of [...related].reverse()) {
    for (const frame of [...page.frames()].reverse()) {
      if (!isSinotradeLoginUrl(frame.url())) continue;
      const certificatePage =
        new URL(frame.url()).hostname === CERTIFICATE_HOST;
      let metadata: SinotradeLoginForm;
      try {
        metadata = await frame.evaluate(
          readLoginForm,
          PAGE_SELECTORS,
          certificatePage,
        );
      } catch (error) {
        // A frame that is navigating or closing is read again by the next poll.
        if (isTransientPageError(error)) continue;
        throw error;
      }
      const form = describeSinotradeLoginForm(metadata);
      if (
        form.challenge.step !== "blocked" ||
        REJECTED_OR_FINAL.test(form.challenge.message ?? "")
      )
        return { ...form, frame };
      if (
        certificatePage &&
        (metadata.hasVisibleInputs || metadata.inputs.length > 0)
      )
        unknownCertificateForm = { ...form, frame };
    }
  }
  if (unknownCertificateForm) return unknownCertificateForm;
  let authenticated = false;
  try {
    authenticated =
      platform === "newweb"
        ? await root.evaluate(() =>
            Boolean(
              localStorage.getItem("newweb_token") &&
              localStorage.getItem("acnts"),
            ),
          )
        : Boolean(await root.$(SINOTRADE_SAVINGS_LOGOUT_SELECTOR));
  } catch (error) {
    if (!isTransientPageError(error)) throw error;
  }
  if (authenticated)
    return {
      challenge: {
        step: "ready",
        fields: [],
        actions: [],
        message: "登入驗證已完成，可繼續檢查完整連線。",
      } satisfies SinotradeVerificationChallenge,
      inputs: {},
      buttons: {},
      frame: root.mainFrame(),
    };
  return {
    challenge: blocked("系統未辨識出官方登入的下一步，目前無法提供驗證操作。"),
    inputs: {},
    buttons: {},
    frame: root.mainFrame(),
  };
}

/** Gives up instead of waiting forever on a page that cannot answer. */
async function withinTimeout<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A failure that arrives after the timeout is not worth an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PageUnresponsiveError()),
          INSPECT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const inspectResponsive = (browser: Browser, platform: SinotradePlatform) =>
  withinTimeout(inspect(browser, platform));

/** A navigating or unresponsive page is a state to read again, not an error to report. */
export function readSinotradeVerification(
  browser: Browser,
  platform: SinotradePlatform,
) {
  return inspectResponsive(browser, platform).then(
    (form) => form.challenge,
    (error: unknown) => {
      if (isTransientPageError(error)) return blocked(PAGE_SWITCHING);
      if (error instanceof PageUnresponsiveError) return blocked(error.message);
      throw error;
    },
  );
}

async function waitForVerification(
  browser: Browser,
  platform: SinotradePlatform,
  previous?: SinotradeVerificationChallenge,
) {
  const deadline = Date.now() + 12_000;
  let challenge = await readSinotradeVerification(browser, platform);
  while (
    ((challenge.step === "blocked" &&
      !REJECTED_OR_FINAL.test(challenge.message ?? "")) ||
      (previous && JSON.stringify(challenge) === JSON.stringify(previous))) &&
    Date.now() < deadline
  ) {
    await sleep(300);
    challenge = await readSinotradeVerification(browser, platform);
  }
  return challenge;
}

const dialogWatchers = new WeakSet<Page>();

/**
 * An unanswered dialog freezes its page, and one opened while nobody is connected cannot be
 * answered later. While connected, acknowledge the official site's informational alerts (it
 * announces the imported certificate with one) and give every question the cautious answer.
 */
export function acknowledgeOfficialDialogs(browser: Browser) {
  const watch = (page: Page) => {
    if (dialogWatchers.has(page)) return;
    dialogWatchers.add(page);
    page.on("dialog", (dialog: Dialog) => {
      const type = dialog.type();
      // Another connection may have answered it already.
      (type === "alert" || type === "beforeunload"
        ? dialog.accept()
        : dialog.dismiss()
      ).catch(() => undefined);
    });
  };
  const watchTarget = (target: Target) => {
    void target.page().then(
      (page) => page && watch(page),
      () => undefined,
    );
  };
  for (const target of browser.targets()) watchTarget(target);
  browser.on("targetcreated", watchTarget);
}

/** Every certificate window has closed and the login page holds the new certificate. */
async function certificateImported(
  browser: Browser,
  platform: SinotradePlatform,
) {
  const { root, related } = await platformPages(browser, platform);
  if (related.length > 1 || !isSinotradeLoginUrl(root.url())) return false;
  return root.evaluate(() => Boolean(localStorage.getItem("TWCACertIdxRef")));
}

/** Closes the official error dialog about a missing certificate record; nothing else. */
async function dismissMissingCertificateRecord(
  browser: Browser,
  platform: SinotradePlatform,
) {
  const { root } = await platformPages(browser, platform);
  const frame = root.mainFrame();
  if (!isSinotradeLoginUrl(frame.url())) return false;
  try {
    return await withinTimeout(
      frame.evaluate(() => {
        const dialog = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"],.ant-modal'),
        ).find((el) =>
          /rcode=8040|查無此筆憑證紀錄/.test(el.textContent ?? ""),
        );
        const button = Array.from(
          dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((el) => /^\s*(?:OK|確定|確認)\s*$/.test(el.textContent ?? ""));
        if (!button) return false;
        button.click();
        return true;
      }),
    );
  } catch (error) {
    if (isTransientPageError(error)) return false;
    throw error;
  }
}

/** Signs in with the new certificate, waiting out the official RA's recording delay. */
async function signInWithIssuedCertificate(
  browser: Browser,
  platform: SinotradePlatform,
  config: SinotradeConfig,
  giveUpAt: number,
) {
  let challenge = await submitSinotradeCredentials(browser, platform, config);
  for (const delay of CERTIFICATE_RECORD_RETRY_DELAYS_MS) {
    if (
      challenge.message !== CERTIFICATE_RECORD_MISSING ||
      Date.now() + delay + CERTIFICATE_SUBMIT_RESERVE_MS > giveUpAt ||
      !(await dismissMissingCertificateRecord(browser, platform))
    )
      break;
    await sleep(delay);
    challenge = await submitSinotradeCredentials(browser, platform, config);
  }
  return challenge;
}

/**
 * Accepting the terms makes the official page issue the certificate and deploy it from other
 * windows, then it only asks to continue. Sign in once more with the saved credentials.
 */
async function finishCertificateLogin(
  browser: Browser,
  platform: SinotradePlatform,
  config: SinotradeConfig,
  previous: SinotradeVerificationChallenge,
) {
  const startedAt = Date.now();
  const deadline = startedAt + CERTIFICATE_IMPORT_TIMEOUT_MS;
  let quiet = 0;
  for (;;) {
    const challenge = await readSinotradeVerification(browser, platform);
    const settled =
      challenge.step === "blocked"
        ? REJECTED_OR_FINAL.test(challenge.message ?? "")
        : JSON.stringify(challenge) !== JSON.stringify(previous);
    if (settled) return challenge;
    quiet = (await withinTimeout(certificateImported(browser, platform)).catch(
      () => false,
    ))
      ? quiet + 1
      : 0;
    // Only the login page is left, twice in a row: sign in, never retry a refused login.
    if (quiet >= 2)
      return signInWithIssuedCertificate(
        browser,
        platform,
        config,
        startedAt + CERTIFICATE_FINISH_BUDGET_MS,
      );
    if (Date.now() >= deadline) return challenge;
    await sleep(700);
  }
}

async function fillControl(
  frame: Frame,
  expected: Input,
  scope: number,
  value: string,
) {
  if (!isSinotradeLoginUrl(frame.url())) throw new SinotradeConnectionError();
  const control = (await frame.$$(PAGE_SELECTORS.control))[expected.index];
  if (!control) throw new SinotradeConnectionError(FIELD_CHANGED);
  try {
    const filled = await control.evaluate(
      (el, data) => {
        const input = el as HTMLInputElement & HTMLSelectElement;
        const owner = document.querySelectorAll(data.selector)[data.scope];
        if (
          !owner?.contains(el) ||
          input.id !== data.id ||
          input.name !== data.name ||
          input.type !== data.type ||
          input.disabled ||
          input.readOnly
        )
          return false;
        const notify = () => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        if (data.kind === "radio") {
          // A real click lets the page's own handlers reveal the matching section.
          input.click();
          return input.checked;
        }
        if (data.kind === "checkbox") {
          const wanted = data.value === "true";
          if (input.checked !== wanted) input.click();
          return input.checked === wanted;
        }
        if (el.getBoundingClientRect().width <= 0) return false;
        if (data.kind === "select") {
          const option = Array.from(input.options).filter(
            (item) => item.value !== "" && !item.disabled,
          )[Number(data.value)];
          if (!option) return false;
          input.value = option.value;
          notify();
          return input.value === option.value;
        }
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setValue.call(el, data.value);
        notify();
        return true;
      },
      {
        selector: PAGE_SELECTORS.scope,
        scope,
        value,
        kind: expected.kind ?? "text",
        id: expected.id,
        name: expected.name,
        type: expected.type,
      },
    );
    if (!filled) throw new SinotradeConnectionError(FIELD_CHANGED);
  } finally {
    await control.dispose();
  }
}

async function fillBinding(
  frame: Frame,
  binding: Binding,
  scope: number,
  value: string,
) {
  const control = binding.members
    ? binding.members[Number(value)]
    : binding.control;
  if (!control) throw new SinotradeConnectionError(FIELD_CHANGED);
  if (control.kind === "radio" && control.checked) return;
  await fillControl(frame, control, scope, value);
}

/** Re-reads the page until a change made by this app has produced the expected state. */
async function inspectUntil(
  browser: Browser,
  platform: SinotradePlatform,
  settled: (form: VerificationForm) => boolean,
) {
  const deadline = Date.now() + 3_000;
  let form = await inspectResponsive(browser, platform);
  while (!settled(form) && Date.now() < deadline) {
    await sleep(150);
    form = await inspectResponsive(browser, platform);
  }
  return form;
}

export async function submitSinotradeCredentials(
  browser: Browser,
  platform: SinotradePlatform,
  config: SinotradeConfig,
) {
  if (!config.userId || !config.password)
    throw new SinotradeConnectionError("請先儲存身分證字號與證券網路密碼。");
  const { root } = await platformPages(browser, platform);
  if (!isSinotradeLoginUrl(root.url()))
    return readSinotradeVerification(browser, platform);
  const frame = root.mainFrame();
  const selectors =
    platform === "newweb"
      ? {
          user: "#complex-form_ant",
          password: "#complex-form_password",
          submit: 'form#complex-form button[type="submit"]',
        }
      : { user: "#txt_IDNO", password: "#txt_PW", submit: "#Btn_Next" };
  await frame.waitForSelector(selectors.password, {
    visible: true,
    timeout: 15_000,
  });
  for (const [selector, value] of [
    [selectors.user, config.userId],
    [selectors.password, config.password],
  ] as const) {
    const input = await frame.$(selector);
    if (!input || !isSinotradeLoginUrl(frame.url()))
      throw new SinotradeConnectionError();
    try {
      await input.click({ clickCount: 3 });
      await input.press("Backspace");
      await input.type(value);
    } finally {
      await input.dispose();
    }
  }
  if (!isSinotradeLoginUrl(frame.url())) throw new SinotradeConnectionError();
  await frame.click(selectors.submit);
  return waitForVerification(browser, platform);
}

function requiredFieldMessage(field: SinotradeVerificationField) {
  if (field.key === "otp") return "請輸入驗證碼。";
  if (field.key === "agreement") return "請先勾選同意憑證作業條款。";
  if (field.type === "choice") return "請先選擇官方要求的選項。";
  return "請先輸入官方要求的生日欄位。";
}

export async function submitSinotradeVerification(
  browser: Browser,
  platform: SinotradePlatform,
  input: SinotradeVerificationInput,
  config: SinotradeConfig,
) {
  const state = await inspectResponsive(browser, platform);
  if (
    state.scope === undefined ||
    !state.challenge.actions.includes(input.action) ||
    !isSinotradeLoginUrl(state.frame.url())
  )
    throw new SinotradeConnectionError(STEP_CHANGED);
  const values = Object.entries(input.values).filter(
    ([, value]) => value !== "",
  ) as Array<[SinotradeVerificationFieldKey, string]>;
  const owned = state.challenge.fields.filter(
    (field) => field.action === input.action,
  );
  if (values.some(([key]) => !owned.some((field) => field.key === key)))
    throw new SinotradeConnectionError(FIELD_CHANGED);
  for (const field of owned) {
    const value = input.values[field.key];
    if (!value) throw new SinotradeConnectionError(requiredFieldMessage(field));
    if (
      (field.type === "choice" &&
        !field.options?.some((option) => option.value === value)) ||
      (field.type === "checkbox" && value !== "true")
    )
      throw new SinotradeConnectionError(FIELD_CHANGED);
  }
  for (const [key, value] of values)
    await fillBinding(state.frame, state.inputs[key]!, state.scope, value);
  const updated = await inspectUntil(
    browser,
    platform,
    (form) => form.buttons[input.action] !== undefined,
  );
  const updatedButton = updated.buttons[input.action];
  if (
    !updatedButton ||
    updated.scope === undefined ||
    !isSinotradeLoginUrl(updated.frame.url())
  )
    throw new SinotradeConnectionError(STEP_CHANGED);
  // A choice can reveal another one (e.g. which phone number): ask before sending.
  if (
    updated.challenge.fields.some(
      (field) => field.action === input.action && !input.values[field.key],
    )
  )
    return updated.challenge;
  const button = (await updated.frame.$$(PAGE_SELECTORS.button))[
    updatedButton.index
  ];
  if (!button) throw new SinotradeConnectionError(STEP_CHANGED);
  try {
    const allowed = await button.evaluate(
      (el, expected) => {
        const owner = document.querySelectorAll(expected.selector)[
          expected.scope
        ];
        const label = (
          el instanceof HTMLInputElement ? el.value : (el.textContent ?? "")
        ).replace(/\s+/g, "");
        const rect = el.getBoundingClientRect();
        return Boolean(
          owner?.contains(el) &&
          label === expected.label &&
          rect.width > 0 &&
          rect.height > 0 &&
          !(el as HTMLButtonElement).disabled &&
          el.getAttribute("aria-disabled") !== "true",
        );
      },
      {
        selector: PAGE_SELECTORS.scope,
        scope: updated.scope,
        label: updatedButton.label,
      },
    );
    if (!allowed)
      throw new SinotradeConnectionError(
        "驗證按鈕尚未通過官方檢查，請更新狀態後再試。",
      );
    await button.click();
  } finally {
    await button.dispose();
  }
  return input.action === "accept_terms"
    ? finishCertificateLogin(browser, platform, config, updated.challenge)
    : waitForVerification(browser, platform, updated.challenge);
}
