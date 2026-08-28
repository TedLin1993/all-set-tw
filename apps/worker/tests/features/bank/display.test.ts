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
      accountName: "末四碼 2345",
    });
  });
});

describe("SKBank bank display", () => {
  it("derives bank code 103 and only the account suffix", () => {
    const sourceId = "bank:skbank:4321:0123456789abcdef";

    expect(deriveBankMatchKey("skbank", sourceId)).toEqual({
      bankCode: "103",
      last4: "4321",
    });
    expect(
      normalizeBankAccountDisplay({
        connectorId: "skbank",
        sourceId,
        institutionName: null,
        accountName: null,
        accountType: "savings",
      }),
    ).toMatchObject({
      institutionName: "新光銀行",
      accountName: "末四碼 4321",
    });
  });
});

describe("O-Bank bank display", () => {
  it("derives bank code 048 and only the account suffix from a hashed source id", () => {
    const sourceId = "bank:obank:savings:1234:0123456789abcdef:TWD";

    expect(deriveBankMatchKey("obank", sourceId)).toEqual({
      bankCode: "048",
      last4: "1234",
    });
    expect(
      normalizeBankAccountDisplay({
        connectorId: "obank",
        sourceId,
        institutionName: null,
        accountName: null,
        accountType: "savings",
      }),
    ).toMatchObject({
      institutionName: "王道銀行",
      accountName: "末四碼 1234",
    });
  });

  it("preserves the time-deposit product name and appends only the account suffix", () => {
    expect(
      normalizeBankAccountDisplay({
        connectorId: "obank",
        sourceId: "bank:obank:time-deposit:0500:0123456789abcdef:TWD",
        institutionName: "王道銀行",
        accountName: "一年期定期存款",
        accountType: "time_deposit",
      }),
    ).toMatchObject({
      institutionName: "王道銀行",
      accountName: "一年期定期存款 · 末四碼 0500",
    });
  });
});

describe("HNCB bank display", () => {
  it("derives bank code 008 from deposit accounts and ignores credit cards", () => {
    expect(deriveBankMatchKey("hncb", "bank:hncb:777201604933:TWD")).toEqual({
      bankCode: "008",
      last4: "4933",
    });
    expect(deriveBankMatchKey("hncb", "credit:hncb:8103")).toEqual({
      bankCode: null,
      last4: null,
    });
  });
});

describe("First Bank display", () => {
  it("derives bank code 007 and only the account suffix", () => {
    const sourceId = "bank:firstbank:1234:0123456789abcdef";

    expect(deriveBankMatchKey("firstbank", sourceId)).toEqual({
      bankCode: "007",
      last4: "1234",
    });
    expect(
      normalizeBankAccountDisplay({
        connectorId: "firstbank",
        sourceId,
        institutionName: null,
        accountName: null,
        accountType: "savings",
      }),
    ).toMatchObject({
      institutionName: "第一銀行",
      accountName: "末四碼 1234",
    });
  });
});
