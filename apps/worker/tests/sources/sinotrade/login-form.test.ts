import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import type { Browser, Frame } from "@cloudflare/puppeteer";
import type { SinotradeVerificationInput } from "@taiwan-fin-hub/shared";
import {
  acknowledgeOfficialDialogs,
  describeSinotradeLoginForm,
  readSinotradeVerification,
  submitSinotradeVerification as submitWithConfig,
  type SinotradeLoginForm,
} from "../../../src/sources/sinotrade/login-form";
import { verifySinotradeLogin } from "../../../src/sources/sinotrade/connector";
import {
  sinotradeVerificationInputSchema,
  type SinotradeConfig,
  type SinotradePlatform,
} from "../../../src/sources/sinotrade/session-protocol";

const mocked = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../../src/sources/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/sources/browser")>()),
  connectBrowserWithCancellation: mocked.connect,
}));
const config: SinotradeConfig = {
  userId: "A000000000",
  password: "fixture-password",
};
const submitSinotradeVerification = (
  browser: Browser,
  platform: SinotradePlatform,
  input: SinotradeVerificationInput,
) => submitWithConfig(browser, platform, input, config);
const CA_URL = "https://ca.sinotrade.com.tw/WebCAEx/WebCA";
const LOGIN_URL = "https://www.sinotrade.com.tw/newweb/SinoTrade_login/";
const birthdayForm: SinotradeLoginForm = {
  scope: 0,
  certificatePrompt: false,
  recaptchaVisible: false,
  inputs: [
    {
      index: 0,
      id: "birthday",
      name: "birthday",
      type: "text",
      description: "birthday 出生年月日 西元YYYYMMDD",
      maxLength: 8,
    },
  ],
  buttons: [{ index: 0, label: "確定" }],
};
const otpForm: SinotradeLoginForm = {
  scope: 0,
  certificatePrompt: false,
  recaptchaVisible: false,
  inputs: [
    {
      index: 0,
      id: "otpData",
      name: "otpData",
      type: "text",
      description: "otpData 請輸入驗證碼",
      maxLength: 6,
    },
  ],
  buttons: [{ index: 0, label: "確定" }],
};
const radio = (index: number, label: string, checked = false) => ({
  index,
  id: "flexRadioDefault" + (index + 1),
  name: "flexRadioDefault",
  type: "radio",
  kind: "radio" as const,
  description: "flexRadioDefault",
  maxLength: -1,
  label,
  checked,
});
const channelForm: SinotradeLoginForm = {
  scope: 0,
  certificatePrompt: false,
  recaptchaVisible: false,
  inputs: [radio(0, "手機"), radio(1, "Email信箱")],
  buttons: [{ index: 0, label: "取消" }],
};
const targetSelect = (options: string[], selected: number) => ({
  index: 2,
  id: "emailList",
  name: "",
  type: "select-one",
  kind: "select" as const,
  description: "emailList",
  maxLength: -1,
  options,
  selected,
});
const termsForm: SinotradeLoginForm = {
  scope: 0,
  certificatePrompt: false,
  recaptchaVisible: false,
  inputs: [
    {
      index: 0,
      id: "chkAgree",
      name: "",
      type: "checkbox",
      kind: "checkbox",
      description: "chkAgree",
      maxLength: -1,
      label: "我已閱讀並同意憑證作業條款",
      checked: false,
    },
  ],
  buttons: [
    { index: 0, label: "確定" },
    { index: 1, label: "取消" },
  ],
};
function loginBrowser(url = CA_URL) {
  let form = birthdayForm;
  const input = { evaluate: vi.fn().mockResolvedValue(true), dispose: vi.fn() };
  const click = vi.fn(async () => {
    form = otpForm;
  });
  const button = {
    click,
    evaluate: vi.fn().mockResolvedValue(true),
    dispose: vi.fn(),
  };
  const frame = {
    url: () => url,
    evaluate: vi.fn(async () => form),
    $$: vi.fn(async (selector: string) =>
      selector === "input,select" ? [input] : [button],
    ),
  } as unknown as Frame;
  const target = { opener: () => null };
  const root = {
    url: () => LOGIN_URL,
    frames: () => [frame],
    target: () => target,
    mainFrame: () => frame,
    evaluate: vi.fn().mockResolvedValue(false),
  };
  const browser = {
    pages: vi.fn().mockResolvedValue([root]),
  } as unknown as Browser;
  return { browser, frame, input, click };
}

/** A small stand-in for the official WebCA pages, driven by real DOM events. */
function certificateSite() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    bottom: 10,
    right: 10,
    toJSON: () => ({}),
  });
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
  vi.stubGlobal("Event", window.Event);
  const doc = window.document;
  const counters = { sent: 0, verified: 0, agreed: 0, birthday: "" };
  let authenticated = false;
  const get = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const show = (id: string, visible: boolean) => {
    get(id).style.display = visible ? "block" : "none";
  };
  const birthdayPage =
    '<div id="sectionForm"><div id="backgroundDiv" class="card-body">' +
    "<h4>生日驗證</h4><p>請輸入8碼西元出生年月日</p>" +
    '<form id="formBirth"><input id="birthday" name="Birthday" maxlength="8"' +
    ' placeholder="8碼西元出生年月日 如 19890101"></form>' +
    '<button id="btnOK" class="btn btn-info">確定</button></div></div>';
  const otpPage =
    '<div id="backgroundDiv" class="card-body"><h4>OTP 驗證</h4>' +
    '<form id="formOTP">' +
    '<div class="form-check"><input type="radio" name="flexRadioDefault" id="flexRadioDefault1">' +
    '<label for="flexRadioDefault1">手機</label></div>' +
    '<div class="form-check"><input type="radio" name="flexRadioDefault" id="flexRadioDefault2">' +
    '<label for="flexRadioDefault2">Email信箱</label></div>' +
    '<div id="rb_phone" style="display:none"><select id="phoneList">' +
    '<option value="p1">0912***678</option></select>' +
    '<button type="button" id="sendPhoneOTP">取得驗證碼</button></div>' +
    '<div id="rb_email" style="display:none"><select id="emailList">' +
    '<option value="e1">a***@example.com</option><option value="e2">b***@example.com</option></select>' +
    '<button type="button" id="sendEmailOTP">取得驗證碼</button></div>' +
    '<div id="blk_valid" style="display:none"><input id="otpData" maxlength="6" placeholder="請輸入驗證碼">' +
    '<button type="button" id="btnOK">確定</button></div></form>' +
    '<button type="button" id="btnCancel">取消</button></div>';
  const termsPage =
    '<div id="backgroundDiv" class="card-body"><h4>憑證申請</h4>' +
    '<div id="webcaAgreement">憑證作業條款\n' +
    "一、本公司使用臺灣網路認證股份有限公司核發之電子憑證。\n" +
    "二、用戶應妥善保管憑證。\n" +
    '<input type="checkbox" id="chkAgree">' +
    '<label for="chkAgree">我已閱讀並同意憑證作業條款</label></div>' +
    '<button id="btnOK">確定</button><button id="btnCancel">取消</button></div>';
  const open = (html: string) => {
    doc.body.innerHTML = html;
  };
  const wireOtp = () => {
    for (const id of ["flexRadioDefault1", "flexRadioDefault2"])
      get(id).addEventListener("change", () => {
        show("rb_phone", get("flexRadioDefault1").checked);
        show("rb_email", get("flexRadioDefault2").checked);
      });
    for (const id of ["sendPhoneOTP", "sendEmailOTP"])
      get(id).addEventListener("click", () => {
        counters.sent++;
        show("blk_valid", true);
        for (const control of doc.querySelectorAll("input[type=radio],select"))
          (control as HTMLInputElement).disabled = true;
        for (const sender of ["sendPhoneOTP", "sendEmailOTP"]) {
          get(sender).textContent = "倒數4分59秒";
          get(sender).disabled = true;
        }
      });
    doc.querySelector("#blk_valid #btnOK")!.addEventListener("click", () => {
      counters.verified++;
      open(termsPage);
      wireTerms();
    });
  };
  const wireTerms = () => {
    get("btnOK").addEventListener("click", () => {
      if (get("chkAgree").checked) counters.agreed++;
      open("");
      authenticated = true;
    });
  };
  const wireBirthday = () => {
    get("btnOK").addEventListener("click", () => {
      counters.birthday = get("birthday").value;
      open(otpPage);
      wireOtp();
    });
  };
  const handle = (el: Element) => ({
    evaluate: async (
      fn: (el: Element, data: unknown) => unknown,
      data: unknown,
    ) => fn(el, data),
    click: async () => (el as HTMLElement).click(),
    dispose: async () => undefined,
  });
  const frame = {
    url: () => CA_URL,
    evaluate: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      fn(...args),
    $$: async (selector: string) =>
      Array.from(doc.querySelectorAll(selector)).map(handle),
  } as unknown as Frame;
  const root = {
    url: () => LOGIN_URL,
    frames: () => [frame],
    target: () => ({ opener: () => null }),
    mainFrame: () => frame,
    evaluate: async () => authenticated,
  };
  const browser = { pages: async () => [root] } as unknown as Browser;
  open(birthdayPage);
  wireBirthday();
  return { browser, counters, doc, close: () => dom.window.close() };
}

describe("證券原生欄位與驗證授權", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("從官方欄位格式產生生日、收取方式、OTP 與條款的原生欄位", () => {
    expect(describeSinotradeLoginForm(birthdayForm).challenge).toMatchObject({
      step: "birthday",
      fields: [
        {
          key: "birthday",
          action: "submit_birthday",
          hint: "西元 YYYYMMDD",
          maxLength: 8,
        },
      ],
      actions: ["submit_birthday"],
    });
    expect(describeSinotradeLoginForm(otpForm).challenge).toMatchObject({
      step: "otp",
      fields: [{ key: "otp", action: "verify_otp", maxLength: 6 }],
      actions: ["verify_otp"],
    });
    // The official send button only appears once a channel is chosen.
    const channel = describeSinotradeLoginForm(channelForm);
    expect(channel.challenge).toEqual({
      step: "otp",
      fields: [
        {
          key: "otpChannel",
          label: "驗證碼收取方式",
          action: "request_otp",
          type: "choice",
          options: [
            { value: "0", label: "手機" },
            { value: "1", label: "Email信箱" },
          ],
        },
      ],
      actions: ["request_otp"],
      message: "請選擇驗證碼收取方式，再按「寄送驗證碼」；系統不會自動寄送。",
    });
    expect(channel.buttons.request_otp).toBeUndefined();
    const chosen = describeSinotradeLoginForm({
      ...channelForm,
      inputs: [
        radio(0, "手機"),
        radio(1, "Email信箱", true),
        targetSelect(["a@example.com", "b@example.com"], 0),
      ],
      buttons: [{ index: 0, label: "取得驗證碼" }],
    });
    expect(chosen.challenge.fields).toMatchObject([
      { key: "otpChannel", value: "1" },
      {
        key: "otpTarget",
        action: "request_otp",
        type: "choice",
        value: "0",
        options: [
          { value: "0", label: "a@example.com" },
          { value: "1", label: "b@example.com" },
        ],
      },
    ]);
    expect(chosen.buttons.request_otp).toEqual({
      index: 0,
      label: "取得驗證碼",
    });
    // Its only selected option needs no decision from the user.
    expect(
      describeSinotradeLoginForm({
        ...channelForm,
        inputs: [
          radio(0, "手機"),
          radio(1, "Email信箱", true),
          targetSelect(["a@example.com"], 0),
        ],
        buttons: [{ index: 0, label: "取得驗證碼" }],
      }).challenge.fields.map((field) => field.key),
    ).toEqual(["otpChannel"]);
    expect(describeSinotradeLoginForm(termsForm).challenge).toMatchObject({
      step: "terms",
      fields: [
        {
          key: "agreement",
          label: "我已閱讀並同意憑證作業條款",
          action: "accept_terms",
          type: "checkbox",
        },
      ],
      actions: ["accept_terms"],
    });
    // The public terms are only attached when the official page shows them.
    expect(describeSinotradeLoginForm(termsForm).challenge.document).toBe(
      undefined,
    );
    expect(
      describeSinotradeLoginForm({
        ...termsForm,
        agreementText: "一、條款內容",
      }).challenge,
    ).toMatchObject({
      step: "terms",
      document: { title: "憑證作業條款", text: "一、條款內容" },
    });
    expect(
      describeSinotradeLoginForm({
        scope: 0,
        inputs: [],
        buttons: [{ index: 0, label: "是" }],
        certificatePrompt: true,
        recaptchaVisible: false,
      }).challenge,
    ).toMatchObject({ step: "certificate", actions: ["confirm_certificate"] });
  });

  it("日期格式不明、未知欄位、含糊按鈕或 reCAPTCHA 時不猜測、不提供提交動作", () => {
    const forms: SinotradeLoginForm[] = [
      {
        ...birthdayForm,
        inputs: [{ ...birthdayForm.inputs[0]!, description: "birthday" }],
      },
      {
        ...otpForm,
        inputs: [
          ...otpForm.inputs,
          {
            index: 1,
            id: "newPassword",
            name: "newPassword",
            type: "password",
            description: "newPassword",
            maxLength: 32,
          },
        ],
      },
      { ...birthdayForm, recaptchaVisible: true },
      {
        ...channelForm,
        inputs: [radio(0, "是，我需要重新申請"), radio(1, "否")],
      },
      {
        ...termsForm,
        inputs: [
          {
            ...termsForm.inputs[0]!,
            label: "訂閱電子報",
            id: "news",
            description: "news",
          },
        ],
      },
      { ...otpForm, buttons: [...otpForm.buttons, ...otpForm.buttons] },
    ];
    for (const form of forms)
      expect(describeSinotradeLoginForm(form).challenge).toMatchObject({
        step: "blocked",
        fields: [],
        actions: [],
      });
    for (const body of [
      { action: "request_otp", values: { userId: "A000000000" } },
      { action: "click", x: 1, y: 2 },
      { action: "accept_terms", values: { agreement: "false" } },
      { action: "request_otp", values: { otpChannel: "手機" } },
    ])
      expect(sinotradeVerificationInputSchema.safeParse(body).success).toBe(
        false,
      );
    expect(
      sinotradeVerificationInputSchema.safeParse({
        action: "request_otp",
        values: { otpChannel: "1", otpTarget: "0" },
      }).success,
    ).toBe(true);
  });

  it("讀取狀態不填欄位也不點擊；只有明確提交且步驟一致才填生日並按官方確定", async () => {
    const { browser, input, click } = loginBrowser();
    expect(await readSinotradeVerification(browser, "newweb")).toMatchObject({
      step: "birthday",
    });
    expect(input.evaluate).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    await expect(
      submitSinotradeVerification(browser, "newweb", {
        action: "verify_otp",
        values: { otp: "123456" },
      }),
    ).rejects.toThrow(/步驟已變更/);
    await expect(
      submitSinotradeVerification(browser, "newweb", {
        action: "submit_birthday",
        values: {},
      }),
    ).rejects.toThrow(/生日/);
    await expect(
      submitSinotradeVerification(browser, "newweb", {
        action: "submit_birthday",
        values: { birthday: "19990101", otp: "123456" },
      }),
    ).rejects.toThrow(/欄位已變更/);
    expect(click).not.toHaveBeenCalled();
    expect(
      await submitSinotradeVerification(browser, "newweb", {
        action: "submit_birthday",
        values: { birthday: "19990101" },
      }),
    ).toMatchObject({ step: "otp" });
    expect(input.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      selector: expect.any(String),
      scope: 0,
      kind: "text",
      value: "19990101",
      id: "birthday",
      name: "birthday",
      type: "text",
    });
    expect(click).toHaveBeenCalledOnce();
  });

  it("官方頁面切換時重試讀取，不把瀏覽器內部錯誤丟給使用者", async () => {
    const { browser, frame, click } = loginBrowser();
    const navigation = new Error(
      "Execution context was destroyed, most likely because of a navigation.",
    );
    let clicked = false;
    let failures = 2;
    // Right after the click the page is still navigating to the next step.
    click.mockImplementation(async () => {
      clicked = true;
    });
    vi.mocked(frame.evaluate).mockImplementation(async () => {
      if (!clicked) return birthdayForm;
      if (failures-- > 0) throw navigation;
      return otpForm;
    });
    expect(
      await submitSinotradeVerification(browser, "newweb", {
        action: "submit_birthday",
        values: { birthday: "19990101" },
      }),
    ).toMatchObject({ step: "otp" });
    expect(failures).toBe(-1);
    vi.mocked(frame.evaluate).mockRejectedValue(navigation);
    expect(await readSinotradeVerification(browser, "newweb")).toMatchObject({
      step: "blocked",
    });
    vi.mocked(frame.evaluate).mockRejectedValue(new Error("unexpected"));
    await expect(readSinotradeVerification(browser, "newweb")).rejects.toThrow(
      "unexpected",
    );
  });

  it("依官方憑證頁逐步完成：選收取方式、寄送、輸入驗證碼、同意條款，且每個送出都由使用者動作觸發", async () => {
    const site = certificateSite();
    try {
      const { browser, counters, doc } = site;
      const submit = (
        action: Parameters<typeof submitSinotradeVerification>[2]["action"],
        values: Record<string, string>,
      ) => submitSinotradeVerification(browser, "newweb", { action, values });
      expect(await readSinotradeVerification(browser, "newweb")).toMatchObject({
        step: "birthday",
        actions: ["submit_birthday"],
      });
      expect(
        await submit("submit_birthday", { birthday: "19990101" }),
      ).toMatchObject({
        step: "otp",
        fields: [{ key: "otpChannel" }],
        actions: ["request_otp"],
      });
      expect(counters.birthday).toBe("19990101");
      expect(await readSinotradeVerification(browser, "newweb")).toMatchObject({
        step: "otp",
      });
      expect(counters.sent).toBe(0);
      await expect(submit("request_otp", {})).rejects.toThrow(/選擇/);
      await expect(submit("verify_otp", { otp: "123456" })).rejects.toThrow(
        /步驟已變更/,
      );
      // A second choice appears after Email is picked: ask first, send nothing yet.
      expect(await submit("request_otp", { otpChannel: "1" })).toMatchObject({
        step: "otp",
        fields: [
          { key: "otpChannel", value: "1" },
          { key: "otpTarget", value: "0" },
        ],
        actions: ["request_otp"],
      });
      expect(counters.sent).toBe(0);
      expect(
        await submit("request_otp", { otpChannel: "1", otpTarget: "1" }),
      ).toMatchObject({
        step: "otp",
        fields: [{ key: "otp", action: "verify_otp", maxLength: 6 }],
        actions: ["verify_otp"],
      });
      expect(counters.sent).toBe(1);
      expect(
        (doc.querySelector("#emailList") as unknown as HTMLSelectElement).value,
      ).toBe("e2");
      await expect(submit("verify_otp", {})).rejects.toThrow(/驗證碼/);
      expect(counters.verified).toBe(0);
      expect(await submit("verify_otp", { otp: "123456" })).toMatchObject({
        step: "terms",
        fields: [{ key: "agreement", type: "checkbox" }],
        actions: ["accept_terms"],
        document: {
          title: "憑證作業條款",
          text: "憑證作業條款\n一、本公司使用臺灣網路認證股份有限公司核發之電子憑證。\n二、用戶應妥善保管憑證。",
        },
      });
      expect(counters.verified).toBe(1);
      await expect(submit("accept_terms", {})).rejects.toThrow(/同意/);
      expect(counters.agreed).toBe(0);
      expect(await submit("accept_terms", { agreement: "true" })).toMatchObject(
        { step: "ready" },
      );
      expect(counters.agreed).toBe(1);
      expect(counters.sent).toBe(1);
    } finally {
      site.close();
    }
  });

  it("只在憑證頁以已知欄位與按鈕對應，其他頁面不套用整頁規則", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
    });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      top: 0,
      left: 0,
      bottom: 10,
      right: 10,
      toJSON: () => ({}),
    });
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal(
      "getComputedStyle",
      dom.window.getComputedStyle.bind(dom.window),
    );
    vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
    let url = LOGIN_URL;
    const { browser, frame } = loginBrowser();
    (frame as unknown as { url: () => string }).url = () => url;
    let observed: SinotradeLoginForm | undefined;
    vi.mocked(frame.evaluate).mockImplementation(
      async (fn: unknown, ...args: unknown[]) => {
        observed = (fn as (...pageArgs: unknown[]) => SinotradeLoginForm)(
          ...args,
        );
        return observed;
      },
    );
    const page = (html: string) => {
      dom.window.document.body.innerHTML = html;
    };
    page(
      "<button>是</button>" +
        '<div role="dialog">憑證系統：是否載入憑證？<button>否</button></div>',
    );
    expect(
      (await readSinotradeVerification(browser, "newweb")).actions,
    ).toEqual([]);
    page(
      "<button>是</button>" +
        '<div class="ant-modal-wrap" role="dialog"><div role="document" class="ant-modal ant-modal-confirm ant-modal-confirm-confirm">' +
        "憑證系統：是否載入憑證？<button>否</button><button>是</button></div></div>",
    );
    expect(await readSinotradeVerification(browser, "newweb")).toMatchObject({
      step: "certificate",
      actions: ["confirm_certificate"],
    });
    expect(describeSinotradeLoginForm(observed!).scope).toBe(2);
    expect(
      describeSinotradeLoginForm(observed!).buttons.confirm_certificate,
    ).toMatchObject({ index: 2, label: "是" });
    page(
      '<button>下一步</button><form><input name="otp" maxlength="6"><button>驗證</button></form>',
    );
    expect(await readSinotradeVerification(browser, "newweb")).toMatchObject({
      step: "otp",
      actions: ["verify_otp"],
    });
    expect(describeSinotradeLoginForm(observed!).buttons.verify_otp).toEqual({
      index: 1,
      label: "驗證",
      disabled: false,
    });

    // On the certificate origin one page is one flow, but unknown controls still block.
    url = CA_URL;
    const birthday =
      '<div id="backgroundDiv" class="card-body"><form id="formBirth">' +
      '<input id="birthday" name="Birthday" maxlength="8" placeholder="8碼西元出生年月日 如 19890101">' +
      '</form><button id="btnOK">確定</button><button id="btnCancel">取消</button></div>';
    page(birthday);
    const challenge = await readSinotradeVerification(browser, "newweb");
    expect(challenge).toEqual({
      step: "birthday",
      fields: [
        {
          key: "birthday",
          label: "生日",
          action: "submit_birthday",
          hint: "西元 YYYYMMDD",
          maxLength: 8,
        },
      ],
      actions: ["submit_birthday"],
    });
    expect(JSON.stringify(challenge)).not.toMatch(/JSON|diagnostic|parents/i);
    for (const [reason, html] of [
      ["另一個確定按鈕", birthday + "<button>確認</button>"],
      [
        "未知輸入欄位",
        birthday.replace("</form>", '<input name="newPassword"></form>'),
      ],
      [
        "生日欄位沒有 id 與 name",
        birthday.replace('id="birthday" name="Birthday"', ""),
      ],
    ]) {
      page(html!);
      expect(
        await readSinotradeVerification(browser, "newweb"),
        reason,
      ).toMatchObject({ step: "blocked", fields: [], actions: [] });
    }
    dom.window.close();
  });

  it.each([
    "https://www.sinotrade.com.tw/newweb/tradingAccount/StockV3/",
    "https://aiinvest.sinotrade.com.tw/Account/Asset",
    "https://ca.sinotrade.com.tw.evil.invalid/WebCA/WebCA",
  ])("不對非登入頁 %s 讀取表單、填欄位或提交", async (url) => {
    const { browser, frame, input, click } = loginBrowser(url);
    await expect(
      submitSinotradeVerification(browser, "newweb", {
        action: "submit_birthday",
        values: { birthday: "19990101" },
      }),
    ).rejects.toThrow(/步驟已變更/);
    expect(frame.evaluate).not.toHaveBeenCalled();
    expect(input.evaluate).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it.each([undefined, new Date(0).toISOString()])(
    "缺少或過期的 pending reference 不得重新連到 Browser",
    async (browserSessionExpiresAt) => {
      await expect(
        verifySinotradeLogin(
          { fetch: vi.fn() },
          {
            browserSessionId: "fixture-browser",
            loginPlatform: "newweb",
            browserSessionExpiresAt,
          },
          { action: "submit_birthday", values: { birthday: "19990101" } },
        ),
      ).rejects.toThrow(/逾時/);
      expect(mocked.connect).not.toHaveBeenCalled();
    },
  );

  it("官方頁面的對話框不會凍結流程：提示確認、提問取消，並且每個視窗只監聽一次", async () => {
    const handlers: Array<(dialog: unknown) => void> = [];
    const pageWithHandlers = (store: Array<(dialog: unknown) => void>) => ({
      on: vi.fn((event: string, handler: (dialog: unknown) => void) => {
        if (event === "dialog") store.push(handler);
      }),
    });
    const page = pageWithHandlers(handlers);
    const popupHandlers: Array<(dialog: unknown) => void> = [];
    const popup = pageWithHandlers(popupHandlers);
    const target = (opened: unknown) => ({ page: async () => opened });
    let created: ((target: unknown) => void) | undefined;
    const browser = {
      targets: () => [target(page)],
      on: vi.fn((event: string, handler: (target: unknown) => void) => {
        if (event === "targetcreated") created = handler;
      }),
    } as unknown as Browser;
    acknowledgeOfficialDialogs(browser);
    await vi.waitFor(() => expect(handlers).toHaveLength(1));
    const dialog = (type: string) => ({
      type: () => type,
      accept: vi.fn().mockResolvedValue(undefined),
      dismiss: vi.fn().mockResolvedValue(undefined),
    });
    for (const [type, accepted] of [
      ["alert", true],
      ["beforeunload", true],
      ["confirm", false],
      ["prompt", false],
    ] as const) {
      const opened = dialog(type);
      handlers[0]!(opened);
      expect(opened.accept, type).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(opened.dismiss, type).toHaveBeenCalledTimes(accepted ? 0 : 1);
    }
    // Another connection may answer first; that must not surface as an error.
    const raced = {
      ...dialog("alert"),
      accept: vi.fn().mockRejectedValue(new Error("No dialog is showing")),
    };
    expect(() => handlers[0]!(raced)).not.toThrow();
    created!(target(popup));
    created!(target(popup));
    await vi.waitFor(() => expect(popupHandlers).toHaveLength(1));
    expect(popup.on).toHaveBeenCalledOnce();
  });

  it("沒有回應的頁面回報原因並停止等待", async () => {
    vi.useFakeTimers();
    try {
      const { browser, frame } = loginBrowser();
      vi.mocked(frame.evaluate).mockImplementation(
        () => new Promise(() => undefined),
      );
      const reading = readSinotradeVerification(browser, "newweb");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await reading).toMatchObject({
        step: "blocked",
        message: expect.stringContaining("沒有回應"),
      });
      const submitting = submitSinotradeVerification(browser, "newweb", {
        action: "submit_birthday",
        values: { birthday: "19990101" },
      });
      const rejected = expect(submitting).rejects.toThrow(/沒有回應/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["憑證視窗關閉且已匯入", true, 0],
    ["憑證視窗一直沒有關閉", false, 0],
    ["憑證視窗關閉但官方暫時查無憑證，稍後重新登入成功", true, 2],
    ["憑證視窗關閉但官方一直查無憑證", true, 99],
  ])("同意條款後 %s", async (_name, closes, missing) => {
    vi.useFakeTimers();
    try {
      const store: Record<string, string> = {};
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => store[key] ?? null,
      });
      const empty: SinotradeLoginForm = {
        scope: 0,
        certificatePrompt: false,
        recaptchaVisible: false,
        inputs: [],
        buttons: [],
      };
      let importing = false;
      let polls = 0;
      const checkbox = {
        evaluate: vi.fn().mockResolvedValue(true),
        dispose: vi.fn(),
      };
      const confirm = {
        evaluate: vi.fn().mockResolvedValue(true),
        click: vi.fn(async () => {
          importing = true;
        }),
        dispose: vi.fn(),
      };
      const certificateFrame = {
        url: () => CA_URL,
        evaluate: vi.fn(async () => (importing ? empty : termsForm)),
        $$: vi.fn(async (selector: string) =>
          selector === "input,select" ? [checkbox] : [confirm, confirm],
        ),
      } as unknown as Frame;
      const typed: string[] = [];
      const field = {
        click: vi.fn(),
        press: vi.fn(),
        type: vi.fn(async (value: string) => {
          typed.push(value);
        }),
        dispose: vi.fn(),
      };
      const submitted: string[] = [];
      // The official RA may not know the new certificate yet: sign-ins are refused with a dialog.
      let recordDialog = false;
      let dismissed = 0;
      const loginFrame = {
        url: () => LOGIN_URL,
        evaluate: vi.fn(async (_fn: unknown, ...args: unknown[]) => {
          // Reading the form passes selectors; dismissing the dialog passes nothing.
          if (args.length)
            return {
              ...empty,
              scope: null,
              ...(recordDialog ? { certificateRecordMissing: true } : {}),
            };
          dismissed++;
          recordDialog = false;
          return true;
        }),
        waitForSelector: vi.fn(),
        $: vi.fn(async () => field),
        click: vi.fn(async (selector: string) => {
          submitted.push(selector);
          if (submitted.length <= missing) {
            recordDialog = true;
            return;
          }
          store.newweb_token = "token";
          store.acnts = "[]";
        }),
      } as unknown as Frame;
      const rootTarget = { opener: () => null };
      const root = {
        url: () => LOGIN_URL,
        frames: () => [loginFrame],
        target: () => rootTarget,
        mainFrame: () => loginFrame,
        evaluate: async (fn: () => unknown) => fn(),
      };
      const popup = {
        url: () => CA_URL,
        frames: () => [certificateFrame],
        target: () => ({ opener: () => rootTarget }),
      };
      const browser = {
        pages: vi.fn(async () => {
          if (importing) polls++;
          // The certificate window closes after a few polls and the page has stored the certificate.
          if (closes && polls >= 6) {
            store.TWCACertIdxRef = "{}";
            return [root];
          }
          return [root, popup];
        }),
      } as unknown as Browser;
      const submitting = submitSinotradeVerification(browser, "newweb", {
        action: "accept_terms",
        values: { agreement: "true" },
      });
      await vi.runAllTimersAsync();
      const result = await submitting;
      expect(confirm.click).toHaveBeenCalledOnce();
      if (closes && missing === 99) {
        // Waits a few times, then stops and says why instead of looping forever.
        expect(result).toMatchObject({
          step: "blocked",
          message: expect.stringContaining("8040"),
        });
        expect(submitted).toHaveLength(6);
        expect(dismissed).toBe(5);
      } else if (closes) {
        expect(result).toMatchObject({ step: "ready" });
        expect(typed).toEqual(
          Array(missing + 1)
            .fill(["A000000000", "fixture-password"])
            .flat(),
        );
        expect(submitted).toEqual(
          Array(missing + 1).fill('form#complex-form button[type="submit"]'),
        );
        expect(dismissed).toBe(missing);
      } else {
        // Never sign in while the official windows are still working, and never guess.
        expect(result).toMatchObject({ step: "blocked" });
        expect(typed).toEqual([]);
        expect(submitted).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
