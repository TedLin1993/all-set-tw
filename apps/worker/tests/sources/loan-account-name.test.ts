import { describe, expect, it } from "vitest";
import { loanAccountName } from "../../src/sources/loan-account-name";

describe("loanAccountName", () => {
  it("各銀行貸款統一以系統分類加末四碼命名", () => {
    expect(loanAccountName("personal", "1234-5678-9012")).toBe(
      "信用貸款 末四碼 9012",
    );
    expect(loanAccountName("housing", "000011112222")).toBe(
      "房屋貸款 末四碼 2222",
    );
    expect(loanAccountName("other", "LOAN-0001")).toBe("其他貸款 末四碼 0001");
  });

  it("缺末四碼時只顯示分類，分類未知時顯示「貸款」", () => {
    expect(loanAccountName("personal")).toBe("信用貸款");
    expect(loanAccountName(undefined, "12")).toBe("貸款");
  });
});
