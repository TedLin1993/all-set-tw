import { describe, expect, it } from "vitest";
import { parseHncbData } from "../../../src/sources/hncb/protocol";

// 去識別化的華南信用卡帳單頁（結構取自實際頁面，金額與編號為假資料）。
function billHtml(options: {
  period: string;
  totalDue?: string;
  minimum?: string;
  previousDue?: string;
  rows: Array<[string, string, string, string]>;
  currentTotal?: string;
}) {
  const header =
    options.totalDue === undefined
      ? ""
      : `<td class="Table_subjectBu_R">累積應繳金額：</td><td class="Table_contentBu_C">${options.totalDue}</td>`;
  const rows = options.rows
    .map(
      ([no, date, description, amount]) => `<tr class="Table_contentYe_C">
        <td class="text"><div align="center">${no}</div></td>
        <td align="center">${date}</td><td align="center">${date}</td>
        <td nowrap><div align="left">${description}</div></td>
        <td align="center"> </td><td align="center">TWD</td>
        <td align="right"></td><td align="right">${amount}</td>
        <td align="right">-</td><td align="right">-</td></tr>`,
    )
    .join("");
  return `<html><body>
    <table>
      <tr><td class="Table_subjectBu_R">帳單年月：</td><td>${options.period}</td>
        <td class="Table_subjectBu_R">信用額度：</td><td>100,000</td></tr>
      <tr><td class="Table_subjectBu_R">信用卡繳款編號：</td><td>0000000000000000</td>
        ${header}
        <td class="Table_subjectBu_R">最低應繳金額：</td><td>${options.minimum ?? "-"}</td></tr>
      <tr><td class="Table_subjectBu_R">帳單結帳日：</td><td>2026/09/23</td>
        <td class="Table_subjectBu_R">繳款截止日：</td><td>2026/10/13</td></tr>
    </table>
    <table>
      <tr><td>No.</td><td>消費日</td><td>入帳日</td><td>消費明細</td><td>國別</td><td>幣別</td><td>外幣<br>金額</td><td>新臺幣<br>金額</td><td>分期<br>未到期<br>金額</td><td>分期應付總費用年百分率</td></tr>
      <tr class="Table_contentYe_C"><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
        <td nowrap><div align="left">上期應繳總額</div></td><td>&nbsp;</td><td>&nbsp;</td>
        <td>&nbsp;</td><td align="right">${options.previousDue ?? "-"}</td><td>&nbsp;</td><td>&nbsp;</td></tr>
      ${rows}
      <tr class="Table_contentWt_R"><td colspan="7"><B>本期應繳總額：</B></td><td colspan="1">${options.currentTotal ?? options.totalDue ?? "-"}</td><td colspan="2">&nbsp;</td></tr>
    </table></body></html>`;
}

const now = new Date("2026-11-02T15:00:00Z");

describe("華南信用卡帳單解析", () => {
  it("應繳金額為「-」時視為無須繳款，不誤用上期應繳總額或繳款列", () => {
    const data = parseHncbData(
      {
        billsHtml: [
          billHtml({
            period: "202609",
            totalDue: "-",
            previousDue: "231",
            rows: [["1", "09/07", "您上期繳款已入帳－華銀自動扣繳", "-231"]],
          }),
        ],
      },
      now,
    );

    expect(data.creditCardBills).toEqual([
      expect.objectContaining({
        billingPeriod: "2026-09",
        statementAmount: 0,
        minimumPayment: 0,
      }),
    ]);
    expect(data.bankBalanceSnapshots).toEqual([
      expect.objectContaining({
        balance: 0,
        statementBalance: 0,
        noPaymentNeeded: true,
      }),
    ]);
    expect(data.bankTransactions.map((tx) => tx.amount)).toEqual([231]);
  });

  it("消費存為負數、退款存為正數，應繳金額取帳單欄位", () => {
    const data = parseHncbData(
      {
        billsHtml: [
          billHtml({
            period: "202610",
            totalDue: "1,300",
            minimum: "1,000",
            previousDue: "500",
            rows: [
              ["1", "10/01", "您上期繳款已入帳－華銀自動扣繳", "-500"],
              ["2", "10/05", "測試商店", "1,500"],
              ["3", "10/06", "測試商店退款", "-200"],
            ],
          }),
        ],
      },
      now,
    );

    expect(data.creditCardBills[0]).toMatchObject({
      statementAmount: 1300,
      minimumPayment: 1000,
    });
    expect(data.bankBalanceSnapshots[0]).toMatchObject({
      balance: -1300,
      noPaymentNeeded: false,
    });
    expect(data.bankTransactions.map((tx) => tx.amount)).toEqual([
      500, -1500, 200,
    ]);
  });

  it("缺少應繳欄位時以扣除繳款與退款後的淨消費推算", () => {
    const data = parseHncbData(
      {
        billsHtml: [
          billHtml({
            period: "202610",
            previousDue: "300",
            currentTotal: "",
            rows: [
              ["1", "10/01", "您上期繳款已入帳－華銀自動扣繳", "-300"],
              ["2", "10/05", "測試商店", "800"],
            ],
          }),
        ],
      },
      now,
    );

    expect(data.creditCardBills[0]?.statementAmount).toBe(500);
  });

  it("未出帳只有退款時仍產生 0 元快照", () => {
    const data = parseHncbData(
      {
        unbilledHtml: billHtml({
          period: "",
          rows: [["1", "10/20", "測試商店退款", "-300"]],
        }),
      },
      now,
    );

    expect(data.bankTransactions.map((tx) => tx.amount)).toEqual([300]);
    expect(data.bankBalanceSnapshots).toEqual([
      expect.objectContaining({ balance: 0, noPaymentNeeded: true }),
    ]);
  });

  it("無序號的同日等額消費與退款都保留，消費沿用原 sourceId", () => {
    const html = `<html><body><table>
      <tr><td>帳單年月：</td><td>202610</td><td>累積應繳金額：</td><td>0</td></tr>
      <tr><td>10/05</td><td>10/05</td><td>測試商店</td><td>500</td></tr>
      <tr><td>10/05</td><td>10/05</td><td>測試商店退款</td><td>-500</td></tr>
    </table></body></html>`;
    const data = parseHncbData({ billsHtml: [html] }, now);

    expect(data.bankTransactions.map((tx) => [tx.amount, tx.sourceId])).toEqual(
      [
        [-500, "hncb:card:tx:v2:main:2026-10-05:500:0"],
        [500, "hncb:card:tx:v2:main:2026-10-05:500:0:credit"],
      ],
    );
  });
});
