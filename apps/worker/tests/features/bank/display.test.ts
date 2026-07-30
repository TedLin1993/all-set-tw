import { describe, expect, it } from "vitest";
import {
  deriveBankMatchKey,
  normalizeBankAccountDisplay,
} from "../../../src/features/bank/display";

describe("CTBC bank display", () => {
  it("derives bank code 822 and the account suffix from a CTBC source id", () => {
    expect(deriveBankMatchKey("ctbc", "bank:ctbc:2345:abcd1234")).toEqual({
      bankCode: "822",
      last4: "2345",
    });
  });

  it("normalizes a CTBC deposit account without exposing more than its suffix", () => {
    expect(
      normalizeBankAccountDisplay({
        connectorId: "ctbc",
        sourceId: "bank:ctbc:2345:abcd1234",
        institutionName: null,
        accountName: null,
        accountType: "savings",
      }),
    ).toMatchObject({
      institutionName: "中國信託銀行",
      accountName: "末五碼 2345",
    });
  });
});
