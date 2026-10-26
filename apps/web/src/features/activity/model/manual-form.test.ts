import { describe, expect, it } from "vitest";
import { buildManualActivityInput, fxToTwd } from "./manual-form";

const form = {
  kind: "expense" as const,
  categoryId: "food",
  name: " 範例午餐 ",
  date: "2026-10-05",
  twdText: "1,200",
  fxCurrency: "",
  fxAmountText: "",
  fxRateText: "",
};

describe("manual activity form", () => {
  it("台幣金額入帳，外幣只留原值與匯率", () => {
    expect(fxToTwd(4, 30.4)).toBe(122);
    expect(buildManualActivityInput(form).input).toMatchObject({
      name: "範例午餐",
      amount: 1200,
      fx: null,
    });
    expect(
      buildManualActivityInput({
        ...form,
        twdText: "122",
        fxCurrency: "USD",
        fxAmountText: "4",
        fxRateText: "30.4",
      }).input,
    ).toMatchObject({
      amount: 122,
      fx: { currency: "USD", amount: 4, rate: 30.4 },
    });
  });

  it("金額為零或匯率缺漏時不送出", () => {
    expect(
      buildManualActivityInput({ ...form, twdText: "0" }).error,
    ).toBeTruthy();
    expect(
      buildManualActivityInput({
        ...form,
        fxCurrency: "USD",
        fxAmountText: "4",
        fxRateText: "",
      }).error,
    ).toBeTruthy();
  });
});
