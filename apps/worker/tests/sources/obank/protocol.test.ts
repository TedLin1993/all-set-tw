import { describe, expect, it } from "vitest";
import { parseObankData } from "../../../src/sources/obank/protocol";

// 合成 fixture：帳號為虛構數字，只驗證名稱欄位帶完整帳號時不會外流。
const savingsNo = "90123456781234";
const timeDepositNo = "90876543215678";

describe("王道帳戶名稱不含完整帳號", () => {
  it("活存與定存名稱帶完整帳號時只保留名稱與末四碼", () => {
    const data = parseObankData({
      demandDeposits: {
        rsData: {
          userAccounts: [
            {
              accountNo: savingsNo,
              accountItems: [
                {
                  accountItemNo: "ITEM-1",
                  acctNo: savingsNo,
                  curr: "TWD",
                  actBal: 1000,
                  accountName: `數位帳戶 ${savingsNo}`,
                },
              ],
            },
          ],
        },
      },
      timeDeposits: {
        rsData: {
          repeats: [
            {
              tdAccountNumber: timeDepositNo,
              currency: "TWD",
              workingBalance: 50000,
              productName: `定期存款${timeDepositNo}`,
            },
          ],
        },
      },
    });

    expect(data.bankAccounts.map((account) => account.accountName)).toEqual([
      "數位帳戶 末四碼 1234",
      "定期存款 末四碼 5678",
    ]);
    const serialized = JSON.stringify(data.bankAccounts);
    expect(serialized).not.toContain(savingsNo);
    expect(serialized).not.toContain(timeDepositNo);
  });
});
