import type { AutopayAccountHint } from "../financial-types";

export const CATHAY_LOAN_DETAIL_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInqDetail";

export type CathayLoanDetailExtraction = {
  /** 「貸款帳號：」列的數字，用於確認頁面顯示的是要查的那筆貸款。 */
  loanAccountDigits: string | null;
  /** 扣款行庫與扣款帳號欄位是否都出現。 */
  autopayRowFound: boolean;
  bankText: string | null;
  /** 扣款帳號只在頁面內取末四碼，完整帳號不回傳。 */
  accountLast4: string | null;
  /** 扣款帳號欄沒有數字時的原文（例如「無」），用於判斷明確未設定。 */
  accountPlainText: string | null;
  /** 欄位來源：桌面表格、窄版 li 清單，或未取得。 */
  fieldSource: "table" | "list" | "none";
};

/**
 * 在貸款明細頁（L0101_LoanInqDetail）讀取「貸款內容」的扣款行庫與扣款帳號。
 * 桌面寬度為表格：`thead th` 放一或多個標籤 `p`，`tbody` 第一列對應欄位的
 * `td` 放相同數量的值 `p`。窄版為 `li > div(標籤 p…) + div(值 p…)`，單一欄位
 * 則是 `li > div(標籤) + div(值)`。兩者皆依順序對應標籤與值。此函式在瀏覽器
 * 內執行，不可引用外部變數。
 */
export function extractCathayLoanDetailDom(
  root: Document = document,
): CathayLoanDetailExtraction {
  const clean = (value: string | null | undefined) =>
    (value ?? "").replace(/[\s\u00a0\u3000]+/g, " ").trim();
  const accountParagraph = Array.from(root.querySelectorAll("p")).find((p) =>
    /^貸款帳號[：:]/.test(clean(p.textContent)),
  );
  const loanAccountDigits =
    clean(accountParagraph?.textContent)
      .replace(/^貸款帳號[：:]/, "")
      .match(/\d{6,}/)?.[0] ?? null;

  const cells = (element: Element | undefined) => {
    if (!element) return [];
    const paragraphs = Array.from(element.querySelectorAll("p"));
    return paragraphs.length > 0
      ? paragraphs.map((p) => clean(p.textContent))
      : [clean(element.textContent)];
  };
  const fields = new Map<string, string>();
  const addFields = (labels: string[], values: string[]) => {
    if (labels.length === 0 || labels.length !== values.length) return;
    labels.forEach((label, index) => {
      if (label && !fields.has(label)) fields.set(label, values[index]);
    });
  };
  const hasAutopayFields = () =>
    fields.has("扣款行庫") && fields.has("扣款帳號");

  let fieldSource: CathayLoanDetailExtraction["fieldSource"] = "none";
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const headers = Array.from(table.querySelectorAll("thead tr th"));
    const firstRow = table.querySelector("tbody tr");
    if (headers.length === 0 || !firstRow) continue;
    const dataCells = Array.from(firstRow.children).filter((cell) =>
      /^T[DH]$/.test(cell.tagName),
    );
    if (dataCells.length !== headers.length) continue;
    headers.forEach((header, index) =>
      addFields(cells(header), cells(dataCells[index])),
    );
  }
  if (hasAutopayFields()) {
    fieldSource = "table";
  } else {
    for (const item of Array.from(root.querySelectorAll("li"))) {
      const columns = Array.from(item.children);
      if (columns.length === 2) addFields(cells(columns[0]), cells(columns[1]));
    }
    if (hasAutopayFields()) fieldSource = "list";
  }

  const bankText = fields.get("扣款行庫");
  const accountText = fields.get("扣款帳號");
  const accountDigits = (accountText ?? "").replace(/\D/g, "");
  return {
    loanAccountDigits,
    autopayRowFound: bankText !== undefined && accountText !== undefined,
    bankText: bankText ?? null,
    accountLast4: accountDigits.length >= 4 ? accountDigits.slice(-4) : null,
    accountPlainText:
      accountText !== undefined && accountDigits.length === 0
        ? accountText
        : null,
    fieldSource,
  };
}

/**
 * 將明細頁擷取結果轉為 `autopayAccount`：明確顯示扣款行庫代碼與帳號時回傳
 * 銀行代碼＋末四碼；兩欄皆空白或標示無／未設定／未約定時為 null；頁面不是
 * 該筆貸款、欄位缺漏或格式不明時為 undefined，保留既有資料。
 */
export function parseCathayLoanAutopayAccount(
  extraction: CathayLoanDetailExtraction,
  loanAccountNumber: string,
): AutopayAccountHint | null | undefined {
  if (extraction.loanAccountDigits !== loanAccountNumber) return undefined;
  if (!extraction.autopayRowFound) return undefined;
  const bankText = (extraction.bankText ?? "").trim();
  const isUnset = (text: string) =>
    text === "" ||
    text === "-" ||
    text === "無" ||
    /^未(?:約定|設定|申請)/.test(text);
  if (
    extraction.accountLast4 === null &&
    isUnset((extraction.accountPlainText ?? "").trim()) &&
    isUnset(bankText)
  )
    return null;
  const bankCode = bankText.match(/^[(（](\d{3})[)）]/)?.[1];
  const last4 = extraction.accountLast4;
  return bankCode && last4 && /^\d{4}$/.test(last4)
    ? { bankCode, last4 }
    : undefined;
}

export type CathayLoanAutopayApiLoanResult = {
  index: number;
  result: "found" | "unset" | "unknown";
  /** found 時為銀行代碼＋末四碼，unset 時為 null；unknown 不帶此欄。 */
  autopayAccount?: { bankCode: string; last4: string } | null;
  /** 回應的 returnCode（截短），或 no_response／invalid／skipped（超過整體時間預算未送出）。 */
  returnCode: string;
  /** 回應為 success 且 returnCode 0000，並含字串 deductionAccount。 */
  usable: boolean;
  /** 此筆 API 呼叫耗時（毫秒，含重試與重試前等待）。 */
  elapsedMs: number;
  /** 實際送出的請求次數：1 或 2（無回應時重試一次）；未送出（skipped）為 0。 */
  attempts: number;
};

export type CathayLoanAutopayApiResult = {
  idTypeSent: boolean;
  loans: CathayLoanAutopayApiLoanResult[];
};

/**
 * 頁面內 API 呼叫所需的憑證。只在 page.evaluate 之間傳遞，不可寫入 log 或保存。
 */
export type CathayApiSession = {
  token: string;
  customerId: string;
  idType: string | null;
};

/** 取得 session 的診斷資訊，只有代碼、狀態與布林，不含身分資料。 */
export type CathayApiSessionDiagnostics = {
  jwtAvailable: boolean;
  /** G_COMM_Q_UserProfile 的 returnCode（截短）；GetJWT 已有 idType 時為 not_called。 */
  userProfileReturnCode: string;
};

export type CathayApiSessionResult = {
  session: CathayApiSession | null;
  diagnostics: CathayApiSessionDiagnostics;
};

/**
 * 在已登入的 cathaybk.com.tw OnlineBanking 頁面內取得 API session：先呼叫
 * GetJWT 取得 token 與 customerId；GetJWT 沒有 IdType 時，依官方前端
 * （userIdTypeAtom = userProfile.data?.idType）改呼叫
 * `Common/Api/ClientCommon/G_COMM_Q_UserProfile` 取 `content.idType`。
 * 此函式在瀏覽器內執行，不可引用外部變數；回傳的 session 不可寫入 log。
 */
export async function getCathayApiSession(): Promise<CathayApiSessionResult> {
  const diagnostics: CathayApiSessionDiagnostics = {
    jwtAvailable: false,
    userProfileReturnCode: "not_called",
  };
  if (typeof XMLHttpRequest === "undefined") {
    return { session: null, diagnostics };
  }
  const post = (
    url: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.withCredentials = true;
        xhr.timeout = 15_000;
        for (const [name, value] of Object.entries(headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.onload = () => {
          try {
            resolve({ status: xhr.status, json: JSON.parse(xhr.responseText) });
          } catch {
            resolve({ status: xhr.status, json: null });
          }
        };
        xhr.onerror = () => resolve({ status: 0, json: null });
        xhr.ontimeout = () => resolve({ status: 0, json: null });
        xhr.send(body);
      } catch {
        resolve({ status: 0, json: null });
      }
    });
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const toIdType = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;

  const jwtResponse = (await post("/MyBank/Customized/GetJWT", {}, null)).json;
  const jwtData = isRecord(jwtResponse) ? jwtResponse.Data : null;
  const token =
    isRecord(jwtData) && typeof jwtData.JwtToken === "string"
      ? jwtData.JwtToken
      : "";
  const customerId =
    isRecord(jwtData) && typeof jwtData.CustomerId === "string"
      ? jwtData.CustomerId
      : "";
  if (!token || !customerId) {
    return { session: null, diagnostics };
  }
  diagnostics.jwtAvailable = true;
  let idType = isRecord(jwtData)
    ? toIdType(jwtData.IdType ?? jwtData.idType)
    : null;

  if (!idType) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const functionSeqNo = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${crypto.randomUUID()}`;
    const reply = await post(
      "/OnlineBankingApi/Common/Api/ClientCommon/G_COMM_Q_UserProfile",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      JSON.stringify({ functionSeqNo, content: { customerId } }),
    );
    const response = reply.json;
    const rawCode = isRecord(response) ? response.returnCode : undefined;
    diagnostics.userProfileReturnCode = !isRecord(response)
      ? "no_response"
      : typeof rawCode === "string" && /^[A-Za-z0-9_]{1,12}$/.test(rawCode)
        ? rawCode
        : "invalid";
    idType =
      isRecord(response) && isRecord(response.content)
        ? toIdType(response.content.idType)
        : null;
  }
  return { session: { token, customerId, idType }, diagnostics };
}

/**
 * 在已登入的 cathaybk.com.tw OnlineBanking 頁面內，以 `getCathayApiSession`
 * 取得的 session 依序（一次一筆、不並行）呼叫 `L_ACCT_Q_OverViewDetail` 查
 * 各筆貸款的扣款帳戶，不需開啟明細頁。單筆未收到回應（httpStatus 0）或回應
 * 非 JSON 時，等待約 300ms 後重試該筆一次；有 returnCode 的業務錯誤不重試。
 * 每筆請求逾時 15 秒，整體超過 45 秒後不再送新請求（returnCode skipped）。有 idType 時附在 content。扣款帳號只在頁面內取末四碼，
 * 完整帳號與金額不回傳 Worker。此函式在瀏覽器內執行，不可引用外部變數。
 *
 * 銀行代碼：`bankId` 為三碼數字時採用；缺少（循環型貸款常見）時，只有
 * `isOtherBankDeduct === false`（非他行扣款）才視為國泰世華 `013`，否則未知。
 * `deductionAccount` 為空字串時視為明確未設定（null）。
 */
export async function queryCathayLoanAutopayApi(input: {
  accounts: string[];
  session: CathayApiSession | null;
}): Promise<CathayLoanAutopayApiResult> {
  const empty: CathayLoanAutopayApiResult = { idTypeSent: false, loans: [] };
  if (
    !input ||
    !Array.isArray(input.accounts) ||
    typeof XMLHttpRequest === "undefined"
  ) {
    return empty;
  }
  const post = (
    url: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        xhr.withCredentials = true;
        xhr.timeout = 15_000;
        for (const [name, value] of Object.entries(headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.onload = () => {
          try {
            resolve({ status: xhr.status, json: JSON.parse(xhr.responseText) });
          } catch {
            resolve({ status: xhr.status, json: null });
          }
        };
        xhr.onerror = () => resolve({ status: 0, json: null });
        xhr.ontimeout = () => resolve({ status: 0, json: null });
        xhr.send(body);
      } catch {
        resolve({ status: 0, json: null });
      }
    });
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);

  const session = isRecord(input.session) ? input.session : null;
  const token =
    session && typeof session.token === "string" ? session.token : "";
  const customerId =
    session && typeof session.customerId === "string" ? session.customerId : "";
  const idType =
    session &&
    typeof session.idType === "string" &&
    session.idType.trim() !== ""
      ? session.idType.trim()
      : null;
  if (!token || !customerId) return empty;

  const pad = (n: number) => String(n).padStart(2, "0");
  // 每次請求（含重試）各自產生 functionSeqNo，避免重送被視為重複交易。
  const newFunctionSeqNo = () => {
    const now = new Date();
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${crypto.randomUUID()}`;
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  // 單筆請求逾時 15 秒、無回應時重試一次；整體預算避免 5 筆以上貸款在最差
  // 情況下累積到數分鐘，超過預算後不再送新請求，剩餘貸款維持 unknown。
  const totalBudgetMs = 45_000;
  const retryDelayMs = 300;
  const queryStartedAt = Date.now();
  const requestDetail = (account: string) =>
    post(
      "/OnlineBankingApi/ClientLoan/Api/ClientLoan/L_ACCT_Q_OverViewDetail",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      JSON.stringify({
        functionSeqNo: newFunctionSeqNo(),
        content: {
          customerId,
          ...(idType ? { idType } : {}),
          account: String(account).padStart(16, "0"),
        },
      }),
    );

  const loans: CathayLoanAutopayApiLoanResult[] = [];
  // 依序逐筆查詢（一次只送一個請求），不並行。
  for (const [index, account] of input.accounts.entries()) {
    if (Date.now() - queryStartedAt >= totalBudgetMs) {
      loans.push({
        index,
        result: "unknown",
        returnCode: "skipped",
        usable: false,
        elapsedMs: 0,
        attempts: 0,
      });
      continue;
    }
    const startedAt = Date.now();
    let attempts = 1;
    let reply = await requestDetail(account);
    // 只有未收到回應（httpStatus 0、網路錯誤或逾時）或回應不是 JSON 時重試
    // 一次；有明確 returnCode（含非 0000 業務錯誤）時不重試。
    if (
      !isRecord(reply.json) &&
      Date.now() - queryStartedAt + retryDelayMs < totalBudgetMs
    ) {
      await sleep(retryDelayMs);
      attempts = 2;
      reply = await requestDetail(account);
    }
    const elapsedMs = Date.now() - startedAt;
    const response = reply.json;
    const rawCode = isRecord(response) ? response.returnCode : undefined;
    const returnCode = !isRecord(response)
      ? "no_response"
      : typeof rawCode === "string" && /^[A-Za-z0-9_]{1,12}$/.test(rawCode)
        ? rawCode
        : "invalid";
    const content =
      isRecord(response) &&
      response.success === true &&
      rawCode === "0000" &&
      isRecord(response.content)
        ? response.content
        : null;
    // 明細欄位通常直接在 content；保守起見也接受單層包裝。
    const detail = !content
      ? null
      : "deductionAccount" in content
        ? content
        : ((Object.values(content).find(
            (value) => isRecord(value) && "deductionAccount" in value,
          ) as Record<string, unknown> | undefined) ?? null);
    const bankId =
      detail && typeof detail.bankId === "string" ? detail.bankId.trim() : "";
    const hasBankId = /^\d{3}$/.test(bankId);
    const deduction =
      detail && typeof detail.deductionAccount === "string"
        ? detail.deductionAccount.trim()
        : null;
    const base = {
      index,
      returnCode,
      usable: deduction !== null,
      elapsedMs,
      attempts,
    };
    if (deduction === null) {
      loans.push({ ...base, result: "unknown" });
      continue;
    }
    if (deduction === "") {
      loans.push({ ...base, result: "unset", autopayAccount: null });
      continue;
    }
    const digits = /^[\d\s-]+$/.test(deduction)
      ? deduction.replace(/\D/g, "")
      : "";
    const bankCode = hasBankId
      ? bankId
      : detail?.isOtherBankDeduct === false
        ? "013"
        : null;
    if (bankCode && digits.length >= 4) {
      loans.push({
        ...base,
        result: "found",
        autopayAccount: { bankCode, last4: digits.slice(-4) },
      });
    } else {
      loans.push({ ...base, result: "unknown" });
    }
  }
  return { idTypeSent: idType !== null, loans };
}
