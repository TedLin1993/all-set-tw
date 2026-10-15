/** Fixed schema positions only. Never treat arbitrary response keys as safe. */
type Fields = { readonly [key: string]: Fields };
const accountFields: Fields = {
  accountId: {},
  balance: {},
  availableBalance: {},
  acctType: {},
  accountNickName: {},
  actDigSvType: {},
};
const overviewFields: Fields = {
  rsData: {
    twdAcctSummaryResponse: {
      demDepBalSummaryResponse: { infoList: accountFields },
    },
    // Mobile names verified in the signed Android 5.2.26 fx-qu001 asset.
    fxAcctSummaryResponse: {
      demDepBalSummaryResponse: {
        rspCode: {},
        rspDesc: {},
        infoList: {
          accountId: {},
          accountNickName: {},
          curCode: {},
          curName: {},
          currentBal: {},
          currentBalTwd: {},
          digiSvType: {},
        },
      },
    },
    // Names verified in the public WEB fx-qu001 module (736fe289f4b7c58e).
    // This allowlist does not assert that the MOBILE overview contains them.
    ibFXAcctSummaryResponse: {
      fxAcctSummaryTotalAmount: {},
      ibFXDemDepBalSummaryResponse: {
        rspCode: {},
        rspDesc: {},
        totalAmount: {},
        infoList: {
          accountId: {},
          accountNickName: {},
          digiSvType: {},
          accountDtlList: { curCode: {}, curName: {}, amount: {} },
        },
      },
    },
    demRsFlag: {},
    termRsFlag: {},
  },
};
const cardItemFields: Fields = Object.fromEntries(
  [
    "purchaseDt",
    "postingDt",
    "clearingDt",
    "purchaseAmt",
    "ntAmt",
    "foreignAmt",
    "curCode",
    "description",
    "merchantChiName",
    "merchName",
    "cardNoSuffixFour",
    "cardNo",
    "fullCardNo",
    "sorting",
    "txnDate",
    "txnDateTime",
    "txnAmt",
    "txnType",
    "authCode",
  ].map((key) => [key, {}]),
);
const cardGroupFields: Fields = {
  summary: Object.fromEntries(
    [
      "billDt",
      "pmtExpDt",
      "billAmt",
      "minPmtAmt",
      "pmtAmt",
      "currPmtAmt",
      "adjust",
    ].map((key) => [key, {}]),
  ),
  bills: cardItemFields,
  allItems: cardItemFields,
  totalRow: {},
  pageCount: {},
  displayPaging: {},
  noMore: {},
};

export type CtbcDepositStructure = {
  fields: Array<{ path: string; type: string }>;
  limited: boolean;
};

/**
 * Local research only: values, array indices/counts and unknown key names are
 * never returned. An unknown subtree stays anonymous at every depth, even if
 * a dynamic key happens to equal a known field name. This is NOT an FX parser.
 */
export function inspectCtbcDepositStructure(
  value: unknown,
  stage:
    | "overview"
    | "initialization"
    | "transactions"
    | "card_overview"
    | "card_statement"
    | "card_unbilled_init"
    | "card_items" = "overview",
): CtbcDepositStructure {
  const fields = new Map<string, CtbcDepositStructure["fields"][number]>();
  let limited = false;
  function visit(
    value: unknown,
    path: string,
    schema: Fields | undefined,
    depth: number,
  ) {
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (fields.size >= 256) {
      limited = true;
      return;
    }
    fields.set(`${path}:${type}`, { path, type });
    if (depth >= 10) {
      if (value !== null && typeof value === "object") limited = true;
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 100) limited = true;
      for (const item of value.slice(0, 100))
        visit(item, `${path}[*]`, schema, depth + 1);
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > 100) limited = true;
      for (const [key, item] of entries.slice(0, 100)) {
        const known = schema && Object.hasOwn(schema, key);
        visit(
          item,
          known ? `${path}.${key}` : `${path}[*]`,
          known ? schema[key] : schema?.["*"],
          depth + 1,
        );
      }
    }
  }
  const schema: Fields =
    stage === "card_overview"
      ? {
          rsData: {
            billCycle: {},
            cardDataList: { cardNoSuffixFour: {}, cardName: {}, cardNo: {} },
            curDataList: { curCode: {}, curName: {} },
            billData: { "*": { "*": cardGroupFields } },
          },
        }
      : stage === "card_statement" || stage === "card_items"
        ? { rsData: cardGroupFields }
        : stage === "card_unbilled_init"
          ? {
              rsData: {
                curOptions: { curCode: {}, curName: {} },
                billCycle: {},
              },
            }
          : stage === "overview"
            ? overviewFields
            : stage === "initialization"
              ? {
                  rsData: {
                    infoList: {
                      accountId: {},
                      curCode: {},
                      currentBal: {},
                      avialBal: {},
                    },
                  },
                }
              : {
                  rsData: {
                    detailList: {
                      trnDtRaw: {},
                      actDtFull: {},
                      debitAmt: {},
                      creditAmt: {},
                      balAmt: {},
                      inOutAmt: {},
                      userMemo: {},
                      memo1: {},
                      memo2: {},
                      acctId: {},
                    },
                  },
                };
  visit(value, "$", schema, 0);
  return {
    fields: [...fields.values()].sort(
      (a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type),
    ),
    limited,
  };
}
