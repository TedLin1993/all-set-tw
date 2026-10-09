// Pure DOM extraction and validation for Cathay's loan overview page.
// Diagnostics intentionally contain counts/statuses only, never loan values.
// Enable temporarily when debugging Cathay loan page changes.
const CATHAY_LOAN_DIAGNOSTICS_ENABLED = false;

export type CathayLoanRecord = {
  accountNumber: string;
  loanCategory?: "housing" | "other";
  interestRate?: number;
  currentPaymentAmount: number;
  paymentDueDate?: string;
  paymentStatus?: "scheduled" | "collection_incomplete";
  balance: number;
  installmentsPaid?: number;
  installmentsTotal?: number;
  currency: string;
};

export type CathayLoanOverviewParseResult = {
  loanRecords: CathayLoanRecord[];
  complete: boolean;
};

export type CathayLoanOverviewExtraction = {
  overviewRecognized: boolean;
  pageState:
    | "ready"
    | "empty"
    | "loading"
    | "maintenance"
    | "incomplete"
    | "unrecognized";
  currency: string | null;
  loanTotalBalanceMatches: boolean | null;
  diagnostics: CathayLoanDomDiagnostics;
  loanAccounts: Array<{
    category: string | null;
    accountNumber: string | null;
    interestRate: string | null;
    paymentAmount: string | null;
    paymentDueOrStatus: string | null;
    balance: string | null;
    installments: string | null;
    hasPaymentAmountLabel: boolean;
    hasPaymentDueLabel: boolean;
    hasBalanceLabel: boolean;
    requiredLabelOrder: boolean;
  }>;
};

type CathayLoanDomDiagnostics = {
  headingCount: number;
  visibleOverviewHeadingFound: boolean;
  totalSectionFound: boolean;
  loanTotalAmountLast3: string | null;
  loanTotalAmountDigitCount: number;
  loanTotalAmountSuffixStatus: "available" | "withheld_short" | "missing";
  accountLikeContentCount: number;
  referenceSelectorMatchCount: number;
  loanPathLinkCount: number;
  accountParameterLinkCount: number;
  extractedLinkLabelCount: number;
  representedLinkLabelCount: number;
  recognizedLoanCardCount: number;
};

type CathayLoanDiagnosticStage =
  | "navigation"
  | "query_wait"
  | "dom_extraction"
  | "parse"
  | "record_mapping"
  | "history_rebuild"
  | "page_content"
  | "total_section"
  | "account_links"
  | "loan_cards"
  | "field_validation"
  | "persistence";

type CathayLoanDiagnosticOutcome =
  | "started"
  | "complete"
  | "failed"
  | "timeout"
  | "incomplete"
  | "found"
  | "missing"
  | "empty"
  | "success";

type CathayLoanDiagnosticFields = {
  navigation: {
    navigationCompleted: boolean;
    logoutDetected: boolean;
  };
  query_wait: {
    waitResolved?: boolean;
    timeoutReached?: boolean;
  };
  dom_extraction: {
    extractionReturned?: boolean;
    overviewRecognized?: boolean;
    extractedCardCount?: number;
  };
  parse: {
    detectedCardCount: number;
    parsedCardCount?: number;
    overviewComplete?: boolean;
  };
  record_mapping: {
    parsedAccountCount: number;
    mappedAccountCount?: number;
    mappedSnapshotCount?: number;
  };
  history_rebuild: {
    snapshotCount: number;
  };
  page_content: {
    headingWaitSatisfied: boolean;
    overviewHeadingFound: boolean;
    visibleOverviewHeadingFound: boolean;
    headingCount: number;
    accountLikeContentFound: boolean;
    accountLikeContentCount: number;
  };
  total_section: {
    sectionFound: boolean;
    loanTotalAmountDigitCount: number;
    loanTotalAmountSuffixStatus: "available" | "withheld_short" | "missing";
  };
  account_links: {
    referenceSelectorMatchCount: number;
    loanPathLinkCount: number;
    accountParameterLinkCount: number;
    extractedLinkLabelCount: number;
    representedLinkLabelCount: number;
    allLinkLabelsRepresented: boolean;
  };
  loan_cards: {
    recognizedLoanCardCount: number;
    extractedCardCount: number;
  };
  field_validation: {
    extractedCardCount: number;
    validatedCardCount: number;
    fieldFailureCount: number;
    optionalFieldMissingCount: number;
    optionalFieldInvalidCount: number;
  };
  persistence: {
    returnedLoanAccountCount: number;
    submittedLoanAccountCount: number;
    submittedLoanSnapshotCount: number;
    databaseLoanAccountCountAvailable?: boolean;
    databaseLoanAccountCount?: number;
  };
};

const CATHAY_LOAN_DIAGNOSTIC_FIELD_KEYS: Record<
  CathayLoanDiagnosticStage,
  readonly string[]
> = {
  navigation: ["navigationCompleted", "logoutDetected"],
  query_wait: ["waitResolved", "timeoutReached"],
  dom_extraction: [
    "extractionReturned",
    "overviewRecognized",
    "extractedCardCount",
  ],
  parse: ["detectedCardCount", "parsedCardCount", "overviewComplete"],
  record_mapping: [
    "parsedAccountCount",
    "mappedAccountCount",
    "mappedSnapshotCount",
  ],
  history_rebuild: ["snapshotCount"],
  page_content: [
    "headingWaitSatisfied",
    "overviewHeadingFound",
    "visibleOverviewHeadingFound",
    "headingCount",
    "accountLikeContentFound",
    "accountLikeContentCount",
  ],
  total_section: [
    "sectionFound",
    "loanTotalAmountDigitCount",
    "loanTotalAmountSuffixStatus",
  ],
  account_links: [
    "referenceSelectorMatchCount",
    "loanPathLinkCount",
    "accountParameterLinkCount",
    "extractedLinkLabelCount",
    "representedLinkLabelCount",
    "allLinkLabelsRepresented",
  ],
  loan_cards: ["recognizedLoanCardCount", "extractedCardCount"],
  field_validation: [
    "extractedCardCount",
    "validatedCardCount",
    "fieldFailureCount",
    "optionalFieldMissingCount",
    "optionalFieldInvalidCount",
  ],
  persistence: [
    "returnedLoanAccountCount",
    "submittedLoanAccountCount",
    "submittedLoanSnapshotCount",
    "databaseLoanAccountCountAvailable",
    "databaseLoanAccountCount",
  ],
};

export function logCathayLoanStage<T extends CathayLoanDiagnosticStage>(
  stage: T,
  outcome: CathayLoanDiagnosticOutcome,
  fields: CathayLoanDiagnosticFields[T],
) {
  if (!CATHAY_LOAN_DIAGNOSTICS_ENABLED) return;

  const allowedKeys = CATHAY_LOAN_DIAGNOSTIC_FIELD_KEYS[stage];
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        allowedKeys.includes(key) &&
        (typeof value === "boolean" ||
          (typeof value === "number" && Number.isInteger(value)) ||
          (key === "loanTotalAmountSuffixStatus" &&
            (value === "available" ||
              value === "withheld_short" ||
              value === "missing"))),
    ),
  );
  console.log(
    JSON.stringify({
      event: "cathaybk_loan_stage",
      stage,
      outcome,
      ...safeFields,
    }),
  );
}

export function isCathayLoanOverviewQuerySettled(
  root: Document = document,
): boolean {
  const normalizeText = (value: string | null | undefined) =>
    value?.replace(/\s+/g, " ").trim() ?? "";
  const bodyText = normalizeText(
    root.body?.innerText ?? root.body?.textContent,
  );
  if (
    /系統維護中|維護作業|暫停服務|服務暫停|目前無法提供服務|系統忙碌/.test(
      bodyText,
    )
  )
    return true;

  const isVisible = (element: Element) => {
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      if (
        current.hasAttribute("hidden") ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      const style = root.defaultView?.getComputedStyle(current);
      if (style?.display === "none" || style?.visibility === "hidden") {
        return false;
      }
    }
    return true;
  };
  const loadingIndicatorFound = Array.from(
    root.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], [class*="loading"], [class*="spinner"]',
    ),
  ).some(
    (element) =>
      isVisible(element) &&
      (!element.matches('[role="progressbar"]') ||
        !element.closest("table, ul")),
  );
  if (
    loadingIndicatorFound ||
    /載入中|讀取中|查詢中|資料處理中|請稍候/.test(bodyText)
  ) {
    return false;
  }

  const hasOverviewHeading = Array.from(
    root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"),
  ).some((heading) =>
    normalizeText(heading.textContent).includes("貸款帳戶總覽"),
  );
  if (!hasOverviewHeading) return false;

  const hasLoanDetailLink = Array.from(
    root.querySelectorAll("a[href], a[data-evt]"),
  ).some((anchor) => {
    const href = anchor.getAttribute("href") ?? "";
    return (
      /L0101_LoanInqDetail|\/loan\/detail/i.test(href) &&
      /[?&]account=/i.test(href)
    );
  });
  const hasLabeledLoanList = Array.from(root.querySelectorAll("ul")).some(
    (list) => {
      const labels = Array.from(list.querySelectorAll("*"))
        .map((element) => normalizeText(element.textContent))
        .filter(Boolean);
      return (
        labels.includes("貸款帳號") &&
        (labels.includes("貸款餘額") || labels.includes("本期應繳金額"))
      );
    },
  );
  const hasLoanTableRow = Array.from(root.querySelectorAll("table")).some(
    (table) => {
      const headers = Array.from(table.querySelectorAll("thead > tr > th"))
        .map((header) => normalizeText(header.textContent))
        .join(" ");
      const hasLoanHeaders =
        headers.includes("貸款帳號") &&
        headers.includes("本期應繳金額") &&
        headers.includes("貸款餘額");
      return (
        hasLoanHeaders &&
        Array.from(table.querySelectorAll("tbody > tr")).some(
          (row) => row.children.length >= 3,
        )
      );
    },
  );
  if (hasLoanDetailLink || hasLabeledLoanList || hasLoanTableRow) return true;

  const emptyMessagePattern = /目前無貸款資料/;
  return Array.from(root.querySelectorAll("*")).some((element) => {
    const text = normalizeText(element.textContent);
    if (
      !emptyMessagePattern.test(text) ||
      !isVisible(element) ||
      element.closest("footer, [role='contentinfo'], nav")
    ) {
      return false;
    }
    return !Array.from(element.children).some((child) =>
      emptyMessagePattern.test(normalizeText(child.textContent)),
    );
  });
}

export function extractCathayLoanOverviewDom(
  root: Document = document,
): CathayLoanOverviewExtraction {
  const labels = [
    "貸款類別",
    "貸款帳號",
    "利率",
    "本期應繳金額",
    "扣款日",
    "貸款餘額",
    "期數",
  ];
  const normalizeText = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const labelElements = (container: Element, label?: string) =>
    Array.from(container.querySelectorAll("*"))
      .filter((element) => {
        const text = normalizeText(element);
        return label ? text === label : labels.includes(text);
      })
      .filter(
        (element) =>
          !Array.from(element.children).some(
            (child) => normalizeText(child) === normalizeText(element),
          ),
      );
  const rowsForList = (list: HTMLUListElement) =>
    Array.from(list.querySelectorAll("li")).filter(
      (row) => row.closest("ul") === list,
    );
  const loanAnchorForList = (list: HTMLUListElement) => {
    for (const anchor of Array.from(
      list.querySelectorAll("a"),
    ) as HTMLAnchorElement[]) {
      if (anchor.closest("ul") !== list) continue;

      const event = anchor.getAttribute("data-evt")?.trim() ?? "";
      const text = normalizeText(anchor);
      let accountNumber = "";
      try {
        accountNumber =
          new URL(
            anchor.getAttribute("href") ?? anchor.href,
            "https://www.cathaybk.com.tw",
          ).searchParams
            .get("account")
            ?.trim() ?? "";
      } catch {
        // Fall back to the account link's visible text below.
      }

      if (accountNumber || event || /^\d[\d\s-]{7,}$/.test(text)) {
        return { accountNumber: accountNumber || text, event };
      }
    }
    return null;
  };
  const listHasLoanIdentity = (list: HTMLUListElement) => {
    const found = new Set(
      rowsForList(list).flatMap((row) =>
        labels.filter((label) => labelElements(row, label).length > 0),
      ),
    );
    return (
      found.has("貸款帳號") &&
      (found.has("本期應繳金額") || found.has("貸款餘額"))
    );
  };
  const loanLists = (
    Array.from(root.querySelectorAll("ul")) as HTMLUListElement[]
  ).filter(
    (list) => loanAnchorForList(list) !== null || listHasLoanIdentity(list),
  );
  const loanAccountLists = loanLists.filter(
    (list) =>
      !loanLists.some((nested) => nested !== list && list.contains(nested)),
  );
  const isHeading = (element: Element) =>
    /^H[1-6]$/.test(element.tagName) ||
    element.getAttribute("role") === "heading";
  const headingElements = Array.from(root.querySelectorAll("*"));
  const valueFromLastChild = (row: Element, labelElement: Element) => {
    const rowLabels = labelElements(row).filter(
      (element) => element.closest("li") === row,
    );
    const valueIndex = rowLabels.indexOf(labelElement);
    const valueBox = row.lastElementChild;
    if (valueIndex < 0 || !valueBox) return null;

    const valueUnits = Array.from(
      valueBox.querySelectorAll("p, dd, dt, output, a"),
    ).filter((element) => {
      const parentUnit = element.parentElement?.closest("p, dd, dt, output, a");
      return !parentUnit || !valueBox.contains(parentUnit);
    });
    const values = valueUnits
      .map(normalizeText)
      .filter((value) => value && !labels.includes(value));
    if (values[valueIndex]) return values[valueIndex]!;
    if (values.length === 1) return values[0]!;

    const textLeaves = Array.from(valueBox.querySelectorAll("*"))
      .filter(
        (element) =>
          normalizeText(element) &&
          !Array.from(element.children).some((child) => normalizeText(child)),
      )
      .map(normalizeText)
      .filter((value) => !labels.includes(value));
    return (
      textLeaves[valueIndex] ??
      (textLeaves.length === 1 ? textLeaves[0]! : null)
    );
  };
  const valueForLabel = (list: HTMLUListElement, label: string) => {
    const labelElement = labelElements(list, label).find(
      (element) => element.closest("ul") === list,
    );
    const row = labelElement?.closest("li");
    if (!labelElement || !row || row.closest("ul") !== list) return null;

    let labelGroup: Element = labelElement;
    while (labelGroup.parentElement && labelGroup.parentElement !== row) {
      labelGroup = labelGroup.parentElement;
    }
    if (labelGroup.parentElement !== row) {
      return valueFromLastChild(row, labelElement);
    }

    const rowGroups = Array.from(row.children);
    const labelGroupIndex = rowGroups.indexOf(labelGroup);
    if (labelGroupIndex < 0) return valueFromLastChild(row, labelElement);
    const labelsInGroup = labelElements(labelGroup);
    const valueIndex = labelsInGroup.indexOf(labelElement);
    if (valueIndex < 0) return valueFromLastChild(row, labelElement);

    const valueGroup = rowGroups
      .slice(labelGroupIndex + 1)
      .find(
        (group) => normalizeText(group) && labelElements(group).length === 0,
      );
    if (!valueGroup) return valueFromLastChild(row, labelElement);

    const valueUnits = Array.from(
      valueGroup.querySelectorAll("p, dd, dt, output, a"),
    ).filter((element) => {
      const parentUnit = element.parentElement?.closest("p, dd, dt, output, a");
      return !parentUnit || !valueGroup.contains(parentUnit);
    });
    const values = valueUnits.map(normalizeText).filter(Boolean);
    if (values.length > 0) {
      return values[valueIndex] ?? valueFromLastChild(row, labelElement);
    }

    const textLeaves = Array.from(valueGroup.querySelectorAll("*"))
      .filter(
        (element) =>
          normalizeText(element) &&
          !Array.from(element.children).some((child) => normalizeText(child)),
      )
      .map(normalizeText);
    return textLeaves[valueIndex] ?? valueFromLastChild(row, labelElement);
  };
  const labelOrderIsValid = (list: HTMLUListElement) => {
    const loanAccountLabels = labelElements(list).filter(
      (element) => element.closest("ul") === list,
    );
    const paymentIndex = loanAccountLabels.findIndex(
      (element) => normalizeText(element) === "本期應繳金額",
    );
    const dueIndex = loanAccountLabels.findIndex(
      (element) => normalizeText(element) === "扣款日",
    );
    return paymentIndex >= 0 && dueIndex === paymentIndex + 1;
  };

  const headings = headingElements.filter(isHeading);
  const overviewRecognized = headings.some((heading) =>
    normalizeText(heading).includes("貸款帳戶總覽"),
  );
  const recognizedLoanTables = Array.from(root.querySelectorAll("table"))
    .map((table) => {
      const headers = Array.from(table.querySelectorAll("thead > tr > th")).map(
        normalizeText,
      );
      const accountColumn = headers.findIndex((header) =>
        header.includes("貸款帳號"),
      );
      const interestColumn = headers.findIndex((header) =>
        header.includes("利率"),
      );
      const paymentColumn = headers.findIndex(
        (header) =>
          header.includes("本期應繳金額") && header.includes("扣款日"),
      );
      const balanceColumn = headers.findIndex((header) =>
        header.includes("貸款餘額"),
      );

      if (
        headers.length !== 4 ||
        accountColumn < 0 ||
        paymentColumn < 0 ||
        balanceColumn < 0
      ) {
        return null;
      }

      let headingContext = "";
      for (const heading of headings) {
        if (heading.compareDocumentPosition(table) & 4) {
          headingContext = normalizeText(heading);
        }
      }
      const category =
        headingContext === "房屋貸款" || headingContext === "其他貸款"
          ? headingContext
          : null;
      const rows = Array.from(table.querySelectorAll("tbody > tr"))
        .map(
          (row) =>
            Array.from(row.children).filter(
              (cell) => cell.tagName === "TD",
            ) as HTMLTableCellElement[],
        )
        .filter((cells) => cells.length === headers.length);
      const valueParagraphs = (cell: HTMLTableCellElement) =>
        Array.from(cell.querySelectorAll("p"))
          .map(normalizeText)
          .filter(Boolean);

      const loanAccounts: CathayLoanOverviewExtraction["loanAccounts"] =
        rows.map((cells) => {
          const accountAnchor = cells[accountColumn]!.querySelector("a");
          let accountNumber: string | null = null;
          if (accountAnchor) {
            try {
              accountNumber =
                new URL(
                  accountAnchor.getAttribute("href") ?? accountAnchor.href,
                  "https://www.cathaybk.com.tw",
                ).searchParams
                  .get("account")
                  ?.trim() ?? null;
            } catch {
              // Fall back to visible text; this parser never follows the link.
            }
            accountNumber ||= normalizeText(accountAnchor) || null;
          }

          const paymentHeader = headers[paymentColumn]!;
          const paymentValues = valueParagraphs(cells[paymentColumn]!);
          const balanceValues = valueParagraphs(cells[balanceColumn]!);
          return {
            category,
            accountNumber,
            interestRate:
              interestColumn >= 0
                ? (valueParagraphs(cells[interestColumn]!)[0] ?? null)
                : null,
            paymentAmount: paymentValues[0] ?? null,
            paymentDueOrStatus: paymentValues[1] ?? null,
            balance: balanceValues[0] ?? null,
            installments: balanceValues[1] ?? null,
            hasPaymentAmountLabel: paymentHeader.includes("本期應繳金額"),
            hasPaymentDueLabel: paymentHeader.includes("扣款日"),
            hasBalanceLabel: headers[balanceColumn]!.includes("貸款餘額"),
            requiredLabelOrder:
              paymentHeader.indexOf("本期應繳金額") <
              paymentHeader.indexOf("扣款日"),
          };
        });
      return { loanAccounts };
    })
    .filter(
      (
        table,
      ): table is {
        loanAccounts: CathayLoanOverviewExtraction["loanAccounts"];
      } => table !== null,
    );
  const visibleBodyText = root.body?.innerText ?? root.body?.textContent ?? "";
  const totalLabelElement = headingElements.find((element) =>
    /^貸款總餘額(?:[：:]|$)/.test(normalizeText(element)),
  );
  const totalLabelSiblings = Array.from(
    totalLabelElement?.parentElement?.children ?? [],
  );
  const totalLabelIndex = totalLabelElement
    ? totalLabelSiblings.indexOf(totalLabelElement)
    : -1;
  const inlineTotalAmountText = totalLabelElement
    ? normalizeText(totalLabelElement).replace(/^貸款總餘額[：:]?\s*/, "")
    : "";
  const siblingTotalAmountText =
    totalLabelIndex >= 0
      ? (totalLabelSiblings
          .slice(totalLabelIndex + 1)
          .map(
            (element) =>
              (element as HTMLElement).innerText ?? element.textContent ?? "",
          )
          .find((text) => /\d/.test(text)) ?? "")
      : "";
  const totalAmountText = /\d/.test(inlineTotalAmountText)
    ? inlineTotalAmountText
    : siblingTotalAmountText;
  const totalAmountMatch = totalAmountText
    .replace(/[+-]/g, "")
    .match(/(?:TWD\s*)?\$?\s*([\d,]+)(?:\.\d+)?/i);
  const totalAmountDigits = totalAmountMatch?.[1]?.replace(/\D/g, "") ?? "";
  const totalAmountDigitCount = totalAmountDigits.length;
  const totalAmountSuffixStatus =
    totalAmountDigitCount === 0
      ? "missing"
      : totalAmountDigitCount < 4
        ? "withheld_short"
        : "available";
  const loanPathAnchors = (
    Array.from(root.querySelectorAll("a")) as HTMLAnchorElement[]
  ).filter((anchor) => {
    try {
      return new URL(
        anchor.getAttribute("href") ?? anchor.href,
        "https://www.cathaybk.com.tw",
      ).pathname
        .toLowerCase()
        .includes("/l0101_loaninqdetail");
    } catch {
      return false;
    }
  });
  const accountParameterLinkCount = loanPathAnchors.filter((anchor) => {
    try {
      return new URL(
        anchor.getAttribute("href") ?? anchor.href,
        "https://www.cathaybk.com.tw",
      ).searchParams.has("account");
    } catch {
      return false;
    }
  }).length;
  const extractedLinkLabels = loanPathAnchors
    .map((anchor) => (anchor.innerText ?? anchor.textContent ?? "").trim())
    .filter(Boolean);
  const accountLikeContentCount =
    visibleBodyText.match(/(?<!\d)\d{8,20}(?!\d)/g)?.length ?? 0;
  const currency =
    headingElements
      .map(
        (element) =>
          normalizeText(element).match(/^幣別[：:]\s*([A-Z]{3})$/)?.[1],
      )
      .find(Boolean) ?? null;
  const tableLoanAccounts = recognizedLoanTables.flatMap(
    ({ loanAccounts }) => loanAccounts,
  );
  const loanAccounts =
    recognizedLoanTables.length > 0
      ? tableLoanAccounts
      : loanAccountLists.map((list) => {
          const loanAnchor = loanAnchorForList(list);
          return {
            category: valueForLabel(list, "貸款類別"),
            accountNumber:
              valueForLabel(list, "貸款帳號") ??
              loanAnchor?.accountNumber ??
              null,
            interestRate: valueForLabel(list, "利率"),
            paymentAmount: valueForLabel(list, "本期應繳金額"),
            paymentDueOrStatus: valueForLabel(list, "扣款日"),
            balance: valueForLabel(list, "貸款餘額"),
            installments: valueForLabel(list, "期數"),
            hasPaymentAmountLabel:
              labelElements(list, "本期應繳金額").length > 0,
            hasPaymentDueLabel: labelElements(list, "扣款日").length > 0,
            hasBalanceLabel: labelElements(list, "貸款餘額").length > 0,
            requiredLabelOrder: labelOrderIsValid(list),
          };
        });

  type ExactAmount = { wholeDigits: string; fractionDigits: string };
  const parseExactAmount = (value: string | null): ExactAmount | null => {
    const match = value
      ?.replace(/[+-]/g, "")
      .match(/(?:TWD\s*|NT\s*)?\$?\s*([\d,]+)(?:\.(\d+))?/i);
    const wholeDigits = match?.[1]?.replace(/,/g, "") ?? "";
    const fractionDigits = match?.[2] ?? "";
    return /^\d+$/.test(wholeDigits) && fractionDigits.length <= 6
      ? { wholeDigits, fractionDigits }
      : null;
  };
  const loanTotalAmount = parseExactAmount(totalAmountText);
  const loanBalanceAmounts = loanAccounts.map((loan) =>
    parseExactAmount(loan.balance),
  );
  let loanTotalBalanceMatches: boolean | null = null;
  if (loanAccounts.length > 0) {
    const exactAmounts = [loanTotalAmount, ...loanBalanceAmounts];
    if (exactAmounts.every((amount) => amount !== null)) {
      const amounts = exactAmounts as ExactAmount[];
      const precision = Math.max(
        ...amounts.map((amount) => amount.fractionDigits.length),
      );
      const scale = 10n ** BigInt(precision);
      const toMinorUnits = (amount: ExactAmount) =>
        BigInt(amount.wholeDigits) * scale +
        BigInt(amount.fractionDigits.padEnd(precision, "0") || "0");
      loanTotalBalanceMatches =
        amounts
          .slice(1)
          .reduce((sum, amount) => sum + toMinorUnits(amount), 0n) ===
        toMinorUnits(amounts[0]!);
    } else {
      loanTotalBalanceMatches = false;
    }
  }

  const normalizedBodyText = visibleBodyText.replace(/\s+/g, " ").trim();
  const maintenanceMessageFound =
    /系統維護中|維護作業|暫停服務|服務暫停|目前無法提供服務|系統忙碌/.test(
      normalizedBodyText,
    );
  const isVisible = (element: Element) => {
    for (
      let current: Element | null = element;
      current;
      current = current.parentElement
    ) {
      if (
        current.hasAttribute("hidden") ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }
      const style = root.defaultView?.getComputedStyle(current);
      if (style?.display === "none" || style?.visibility === "hidden") {
        return false;
      }
    }
    return true;
  };
  const loadingIndicatorFound = Array.from(
    root.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], [class*="loading"], [class*="spinner"]',
    ),
  ).some(
    (element) =>
      isVisible(element) &&
      (!element.matches('[role="progressbar"]') ||
        !element.closest("table, ul")),
  );
  const loadingTextFound = /載入中|讀取中|查詢中|資料處理中|請稍候/.test(
    normalizedBodyText,
  );
  const emptyMessagePattern = /目前無貸款資料/;
  const explicitEmptyMessage = Array.from(root.querySelectorAll("*")).some(
    (element) => {
      const text = normalizeText(element);
      if (
        !emptyMessagePattern.test(text) ||
        !isVisible(element) ||
        element.closest("footer, [role='contentinfo'], nav")
      ) {
        return false;
      }
      return !Array.from(element.children).some((child) =>
        emptyMessagePattern.test(normalizeText(child)),
      );
    },
  );
  const pageState = maintenanceMessageFound
    ? "maintenance"
    : loadingIndicatorFound || loadingTextFound
      ? "loading"
      : !overviewRecognized
        ? "unrecognized"
        : loanAccounts.length > 0
          ? loanTotalBalanceMatches === true
            ? "ready"
            : "incomplete"
          : explicitEmptyMessage
            ? "empty"
            : "incomplete";

  return {
    overviewRecognized,
    pageState,
    currency,
    loanTotalBalanceMatches,
    diagnostics: {
      headingCount: headings.length,
      visibleOverviewHeadingFound: visibleBodyText.includes("貸款帳戶總覽"),
      totalSectionFound: visibleBodyText.includes("貸款總餘額"),
      loanTotalAmountLast3:
        totalAmountDigitCount >= 4 ? totalAmountDigits.slice(-3) : null,
      loanTotalAmountDigitCount: totalAmountDigitCount,
      loanTotalAmountSuffixStatus: totalAmountSuffixStatus,
      accountLikeContentCount,
      referenceSelectorMatchCount: root.querySelectorAll(
        'a[href*="L0101_LoanInqDetail?account="]',
      ).length,
      loanPathLinkCount: loanPathAnchors.length,
      accountParameterLinkCount,
      extractedLinkLabelCount: extractedLinkLabels.length,
      representedLinkLabelCount: extractedLinkLabels.filter((label) =>
        visibleBodyText.includes(label),
      ).length,
      recognizedLoanCardCount: loanAccounts.length,
    },
    loanAccounts,
  };
}

export function logCathayLoanDomDiagnostics(
  extraction: CathayLoanOverviewExtraction,
  headingWaitSatisfied: boolean,
) {
  const { diagnostics } = extraction;
  logCathayLoanStage(
    "page_content",
    diagnostics.visibleOverviewHeadingFound ? "found" : "missing",
    {
      headingWaitSatisfied,
      overviewHeadingFound: extraction.overviewRecognized,
      visibleOverviewHeadingFound: diagnostics.visibleOverviewHeadingFound,
      headingCount: diagnostics.headingCount,
      accountLikeContentFound: diagnostics.accountLikeContentCount > 0,
      accountLikeContentCount: diagnostics.accountLikeContentCount,
    },
  );
  logCathayLoanStage(
    "total_section",
    diagnostics.totalSectionFound ? "found" : "missing",
    {
      sectionFound: diagnostics.totalSectionFound,
      loanTotalAmountDigitCount: diagnostics.loanTotalAmountDigitCount,
      loanTotalAmountSuffixStatus: diagnostics.loanTotalAmountSuffixStatus,
    },
  );
  logCathayLoanStage(
    "account_links",
    diagnostics.accountParameterLinkCount > 0 ? "found" : "missing",
    {
      referenceSelectorMatchCount: diagnostics.referenceSelectorMatchCount,
      loanPathLinkCount: diagnostics.loanPathLinkCount,
      accountParameterLinkCount: diagnostics.accountParameterLinkCount,
      extractedLinkLabelCount: diagnostics.extractedLinkLabelCount,
      representedLinkLabelCount: diagnostics.representedLinkLabelCount,
      allLinkLabelsRepresented:
        diagnostics.extractedLinkLabelCount > 0 &&
        diagnostics.extractedLinkLabelCount ===
          diagnostics.representedLinkLabelCount,
    },
  );
  logCathayLoanStage(
    "loan_cards",
    diagnostics.recognizedLoanCardCount > 0 ? "found" : "empty",
    {
      recognizedLoanCardCount: diagnostics.recognizedLoanCardCount,
      extractedCardCount: extraction.loanAccounts.length,
    },
  );
}

/** Validates extracted loan fields without receiving the page text or HTML. */
export function parseCathayLoanOverview(
  extraction: CathayLoanOverviewExtraction,
): CathayLoanRecord[] {
  const result = parseCathayLoanOverviewInternal(extraction, false);
  if (!result.complete) {
    throw new Error("Cathay loan overview query did not complete.");
  }
  return result.loanRecords;
}

/** Returns parseable visible loans while preserving whether the overview is complete. */
export function parseCathayLoanOverviewForSync(
  extraction: CathayLoanOverviewExtraction,
): CathayLoanOverviewParseResult {
  return parseCathayLoanOverviewInternal(extraction, true);
}

function parseCathayLoanOverviewInternal(
  extraction: CathayLoanOverviewExtraction,
  allowPartial: boolean,
): CathayLoanOverviewParseResult {
  type FieldStatus = "missing" | "invalid" | "valid";
  type LoanFieldSummary = {
    cardIndex: number;
    accountLast3Status: "available" | "invalid" | "missing";
    paymentAmountDigitCount: number;
    paymentAmountSuffixStatus:
      "available" | "invalid" | "withheld_short" | "missing";
    balanceDigitCount: number;
    balanceSuffixStatus: "available" | "invalid" | "withheld_short" | "missing";
    fields: {
      category: FieldStatus;
      accountNumber: FieldStatus;
      interestRate: FieldStatus;
      paymentAmount: FieldStatus;
      dueDateOrStatus: FieldStatus;
      balance: FieldStatus;
      installments: FieldStatus;
    };
  };
  const maxLoggedLoanStatuses = 20;

  const fieldStatus = (captured: boolean, valid: boolean): FieldStatus =>
    !captured ? "missing" : valid ? "valid" : "invalid";
  const logParseFailure = (
    detectedLoanAccountCount: number,
    loanIndex: number | null,
    reasonCodes: string[],
    checks?: Record<string, boolean>,
    loanFieldStatuses?: LoanFieldSummary[],
  ) => {
    if (!CATHAY_LOAN_DIAGNOSTICS_ENABLED) return;
    console.log(
      JSON.stringify({
        event: "cathaybk_loan_parse_failure",
        detectedCardCount: detectedLoanAccountCount,
        cardIndex: loanIndex,
        reasonCodes,
        ...(checks ? { checks } : {}),
        ...(loanFieldStatuses ? { cardFieldStatuses: loanFieldStatuses } : {}),
      }),
    );
  };

  if (extraction.pageState === "maintenance" && !allowPartial) {
    throw new Error("Cathay loan overview is under maintenance.");
  }
  if (extraction.pageState === "loading" && !allowPartial) {
    throw new Error("Cathay loan overview query is still loading.");
  }
  if (extraction.pageState === "incomplete" && !allowPartial) {
    throw new Error("Cathay loan overview query did not complete.");
  }
  if (extraction.pageState === "empty") {
    logCathayLoanStage("field_validation", "empty", {
      extractedCardCount: 0,
      validatedCardCount: 0,
      fieldFailureCount: 0,
      optionalFieldMissingCount: 0,
      optionalFieldInvalidCount: 0,
    });
    return { loanRecords: [], complete: true };
  }
  if (!extraction.overviewRecognized) {
    if (allowPartial) {
      return { loanRecords: [], complete: false };
    }
    logCathayLoanStage("field_validation", "failed", {
      extractedCardCount: extraction.loanAccounts.length,
      validatedCardCount: 0,
      fieldFailureCount: 0,
      optionalFieldMissingCount: 0,
      optionalFieldInvalidCount: 0,
    });
    logParseFailure(extraction.loanAccounts.length, null, [
      "overview_not_recognized",
    ]);
    throw new Error("Cathay loan overview page was not recognized.");
  }
  if (extraction.loanAccounts.length === 0) {
    if (allowPartial) {
      return { loanRecords: [], complete: false };
    }
    throw new Error("Cathay loan overview query did not complete.");
  }

  const parseAmount = (value: string | null) => {
    const amount = value?.match(/(?:TWD\s*)?\$?\s*([\d,]+)/i)?.[1];
    return amount ? Number(amount.replace(/,/g, "")) : null;
  };
  const integerAmountDigits = (value: string | null) => {
    const amount = value
      ?.replace(/[+-]/g, "")
      .match(/(?:TWD\s*)?\$?\s*([\d,]+)(?:\.\d+)?/i)?.[1];
    return amount?.replace(/\D/g, "") ?? "";
  };
  const suffixStatus = (
    digitCount: number,
    minimumDigits: number,
  ): "available" | "withheld_short" | "missing" =>
    digitCount === 0
      ? "missing"
      : digitCount < minimumDigits
        ? "withheld_short"
        : "available";
  const parseDate = (value: string | undefined) => {
    const match = value?.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    return match
      ? `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`
      : undefined;
  };

  const parsedLoanRecords = extraction.loanAccounts.map(
    (loanAccount, index) => {
      const accountNumber = loanAccount.accountNumber?.replace(/\s/g, "") ?? "";
      const paymentAmountDigits = integerAmountDigits(
        loanAccount.paymentAmount,
      );
      const balanceDigits = integerAmountDigits(loanAccount.balance);
      const loanCategory =
        loanAccount.category === "房屋貸款"
          ? "housing"
          : loanAccount.category === "其他貸款"
            ? "other"
            : undefined;
      const interestRateMatch = loanAccount.interestRate?.match(/([\d.]+)\s*%/);
      const parsedInterestRate = Number(interestRateMatch?.[1]);
      const interestRate =
        interestRateMatch && Number.isFinite(parsedInterestRate)
          ? parsedInterestRate
          : undefined;
      const currentPaymentAmount = parseAmount(loanAccount.paymentAmount);
      const balance = parseAmount(loanAccount.balance);
      const dueOrStatus = loanAccount.paymentDueOrStatus ?? undefined;
      const paymentDueDate = parseDate(dueOrStatus);
      const paymentStatus = dueOrStatus?.includes("未完成扣款")
        ? "collection_incomplete"
        : paymentDueDate
          ? "scheduled"
          : undefined;
      const installments = loanAccount.installments?.match(
        /已繳\s*([\d,]+)\s*期[，,]?\s*共\s*([\d,]+)\s*期/,
      );
      const parsedInstallmentsPaid = Number(
        installments?.[1]?.replace(/,/g, ""),
      );
      const parsedInstallmentsTotal = Number(
        installments?.[2]?.replace(/,/g, ""),
      );
      const hasValidInstallments =
        Boolean(installments) &&
        Number.isFinite(parsedInstallmentsPaid) &&
        Number.isFinite(parsedInstallmentsTotal);
      const installmentsPaid = hasValidInstallments
        ? parsedInstallmentsPaid
        : undefined;
      const installmentsTotal = hasValidInstallments
        ? parsedInstallmentsTotal
        : undefined;
      const dueDateOrStatusValid = Boolean(
        paymentDueDate || dueOrStatus?.includes("未完成扣款"),
      );

      const checks = {
        category: Boolean(loanCategory),
        accountFormat: /^\d{8,20}$/.test(accountNumber),
        rate: Boolean(interestRate),
        requiredLabels:
          loanAccount.hasPaymentAmountLabel &&
          loanAccount.hasPaymentDueLabel &&
          loanAccount.hasBalanceLabel,
        requiredLabelOrder: loanAccount.requiredLabelOrder,
        paymentAmountParse: currentPaymentAmount !== null,
        paymentDueOrStatusParse: dueDateOrStatusValid,
        balanceAmountParse: balance !== null,
        installmentFormat: hasValidInstallments,
      };
      const loanFieldStatus: LoanFieldSummary = {
        cardIndex: index + 1,
        accountLast3Status: !loanAccount.accountNumber?.trim()
          ? "missing"
          : checks.accountFormat
            ? "available"
            : "invalid",
        paymentAmountDigitCount: paymentAmountDigits.length,
        paymentAmountSuffixStatus: !loanAccount.paymentAmount?.trim()
          ? "missing"
          : !checks.paymentAmountParse
            ? "invalid"
            : suffixStatus(paymentAmountDigits.length, 4),
        balanceDigitCount: balanceDigits.length,
        balanceSuffixStatus: !loanAccount.balance?.trim()
          ? "missing"
          : !checks.balanceAmountParse
            ? "invalid"
            : suffixStatus(balanceDigits.length, 4),
        fields: {
          category: fieldStatus(
            Boolean(loanAccount.category?.trim()),
            checks.category,
          ),
          accountNumber: fieldStatus(
            Boolean(loanAccount.accountNumber?.trim()),
            checks.accountFormat,
          ),
          interestRate: fieldStatus(
            Boolean(loanAccount.interestRate?.trim()),
            checks.rate,
          ),
          paymentAmount: fieldStatus(
            Boolean(loanAccount.paymentAmount?.trim()) &&
              loanAccount.hasPaymentAmountLabel,
            checks.paymentAmountParse,
          ),
          dueDateOrStatus: fieldStatus(
            Boolean(dueOrStatus?.trim()) && loanAccount.hasPaymentDueLabel,
            dueDateOrStatusValid,
          ),
          balance: fieldStatus(
            Boolean(loanAccount.balance?.trim()) && loanAccount.hasBalanceLabel,
            checks.balanceAmountParse,
          ),
          installments: fieldStatus(
            Boolean(loanAccount.installments?.trim()),
            checks.installmentFormat,
          ),
        },
      };
      const requiredChecks = [
        "accountFormat",
        "requiredLabels",
        "paymentAmountParse",
        "paymentDueOrStatusParse",
        "balanceAmountParse",
      ] as const;
      const reasonCodes = requiredChecks.filter((check) => !checks[check]);

      return {
        loanRecord: {
          accountNumber,
          ...(loanCategory ? { loanCategory } : {}),
          ...(interestRate !== undefined ? { interestRate } : {}),
          currentPaymentAmount: currentPaymentAmount!,
          ...(paymentDueDate ? { paymentDueDate } : {}),
          ...(paymentStatus ? { paymentStatus } : {}),
          balance: balance!,
          ...(installmentsPaid !== undefined && installmentsTotal !== undefined
            ? { installmentsPaid, installmentsTotal }
            : {}),
          currency: extraction.currency ?? "TWD",
        } satisfies CathayLoanRecord,
        checks,
        reasonCodes,
        loanFieldStatus,
      };
    },
  );

  const loanFieldStatuses = parsedLoanRecords.map(
    ({ loanFieldStatus }) => loanFieldStatus,
  );
  const loggedLoanFieldStatuses = loanFieldStatuses.slice(
    0,
    maxLoggedLoanStatuses,
  );
  const omittedLoanStatusCount = Math.max(
    0,
    loanFieldStatuses.length - loggedLoanFieldStatuses.length,
  );
  const fieldFailureCount = loanFieldStatuses.reduce(
    (count, fieldSummary) =>
      count +
      [
        fieldSummary.fields.accountNumber,
        fieldSummary.fields.paymentAmount,
        fieldSummary.fields.dueDateOrStatus,
        fieldSummary.fields.balance,
      ].filter((status) => status !== "valid").length,
    0,
  );
  const optionalFieldStatuses = loanFieldStatuses.flatMap((fieldSummary) => [
    fieldSummary.fields.category,
    fieldSummary.fields.interestRate,
    fieldSummary.fields.installments,
  ]);
  const optionalFieldMissingCount = optionalFieldStatuses.filter(
    (status) => status === "missing",
  ).length;
  const optionalFieldInvalidCount = optionalFieldStatuses.filter(
    (status) => status === "invalid",
  ).length;
  const validatedLoanRecordCount =
    parsedLoanRecords.length -
    new Set(
      parsedLoanRecords
        .filter(({ reasonCodes }) => reasonCodes.length > 0)
        .map(({ loanFieldStatus }) => loanFieldStatus.cardIndex),
    ).size;
  const firstFailure = parsedLoanRecords.find(
    ({ reasonCodes }) => reasonCodes.length > 0,
  );

  if (firstFailure) {
    logCathayLoanStage("field_validation", "failed", {
      extractedCardCount: extraction.loanAccounts.length,
      validatedCardCount: validatedLoanRecordCount,
      fieldFailureCount,
      optionalFieldMissingCount,
      optionalFieldInvalidCount,
    });
    logParseFailure(
      extraction.loanAccounts.length,
      firstFailure.loanFieldStatus.cardIndex,
      firstFailure.reasonCodes,
      firstFailure.checks,
      loggedLoanFieldStatuses,
    );
    if (CATHAY_LOAN_DIAGNOSTICS_ENABLED && omittedLoanStatusCount > 0) {
      console.log(
        JSON.stringify({
          event: "cathaybk_loan_parse_failure_omitted",
          omittedCardStatusCount: omittedLoanStatusCount,
        }),
      );
    }
    if (!allowPartial) {
      throw new Error("Cathay loan overview card could not be parsed.");
    }
  }

  if (!firstFailure) {
    logCathayLoanStage(
      "field_validation",
      parsedLoanRecords.length > 0 ? "success" : "empty",
      {
        extractedCardCount: extraction.loanAccounts.length,
        validatedCardCount: validatedLoanRecordCount,
        fieldFailureCount,
        optionalFieldMissingCount,
        optionalFieldInvalidCount,
      },
    );

    if (CATHAY_LOAN_DIAGNOSTICS_ENABLED) {
      console.log(
        JSON.stringify({
          event: "cathaybk_loan_parse_success",
          detectedCardCount: extraction.loanAccounts.length,
          parsedCardCount: parsedLoanRecords.length,
          cardFieldStatuses: loggedLoanFieldStatuses,
          ...(omittedLoanStatusCount > 0
            ? { omittedCardStatusCount: omittedLoanStatusCount }
            : {}),
        }),
      );
    }
  }

  return {
    loanRecords: parsedLoanRecords
      .filter(({ reasonCodes }) => reasonCodes.length === 0)
      .map(({ loanRecord }) => loanRecord),
    complete:
      extraction.pageState === "ready" &&
      extraction.loanTotalBalanceMatches === true &&
      firstFailure === undefined,
  };
}
