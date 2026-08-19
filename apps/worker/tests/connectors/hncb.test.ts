import { describe, expect, it } from "vitest";
import { parseHncbData } from "@taiwan-fin-hub/connectors";

describe("HNCB connector parser", () => {
  it("parses deposit accounts and balance snapshots correctly", () => {
    const depositOverviewHtml = `
      <table>
        <tr>
          <td>211201117010</td>
          <td>活儲</td>
          <td>新台幣</td>
          <td>0.00</td>
          <td>0.00</td>
        </tr>
        <tr>
          <td>777201604933</td>
          <td>活儲</td>
          <td>新台幣</td>
          <td>100,000.00</td>
          <td>100,000.00</td>
        </tr>
      </table>
    `;

    const result = parseHncbData(
      { depositOverviewHtml },
      new Date("2026-08-18T00:00:00.000Z"),
    );

    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankAccounts[1]).toMatchObject({
      sourceId: "bank:hncb:777201604933:TWD",
      institutionName: "華南銀行",
      accountType: "savings",
      currency: "TWD",
    });

    expect(result.bankBalanceSnapshots).toHaveLength(2);
    expect(result.bankBalanceSnapshots[1]).toMatchObject({
      accountId: "bank:hncb:777201604933:TWD",
      balance: 100000,
      availableBalance: 100000,
      currency: "TWD",
    });
  });

  it("parses credit card bills, unbilled items, and posted transactions", () => {
    const billHtml = `
      <table>
        <tr><td>帳單年月：202608</td><td>信用額度：70,000</td><td>累積應繳金額：279</td><td>最低應繳金額：279</td><td>帳單結帳日：2026/08/17</td><td>繳款截止日：2026/09/01</td></tr>
        <tr><td colspan="10">ｉ網購生活卡************8103</td></tr>
        <tr><td>1</td><td>07/22</td><td>07/27</td><td>ｉ－連加＊餓肆ＴＷＯＦＯＵ</td><td>TW</td><td>TWD</td><td></td><td>230</td><td>-</td><td>-</td></tr>
        <tr><td>2</td><td>07/22</td><td>07/27</td><td>ｉ－連支＊迪卡儂北屯店</td><td>TW</td><td>TWD</td><td></td><td>49</td><td>-</td><td>-</td></tr>
        <tr><td colspan="7">本期應繳總額：</td><td>279</td></tr>
      </table>
    `;

    const unbilledHtml = `
      <table>
        <tr><td>帳單年月：</td><td>信用額度：70,000</td></tr>
        <tr><td colspan="10">ｉ網購生活卡************8103</td></tr>
        <tr><td>1</td><td>08/10</td><td></td><td>測試待入帳消費</td><td>TW</td><td>TWD</td><td></td><td>150</td><td>VS08/10</td></tr>
      </table>
    `;

    const result = parseHncbData(
      {
        billsHtml: [billHtml],
        unbilledHtml,
      },
      new Date("2026-08-18T00:00:00.000Z"),
    );

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankAccounts[0]).toMatchObject({
      sourceId: "credit:hncb:8103",
      accountType: "credit",
      creditLimit: 70000,
    });

    expect(result.creditCardBills).toHaveLength(1);
    expect(result.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-08",
      statementAmount: 279,
      statementClosingDate: "2026-08-17",
      paymentDueDate: "2026-09-01",
    });

    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      accountId: "credit:hncb:8103",
      balance: -429,
      statementBalance: 279,
    });

    expect(result.bankTransactions).toHaveLength(3);
    const pendingTx = result.bankTransactions.find(
      (t) => t.status === "pending",
    );
    const postedTx = result.bankTransactions.filter(
      (t) => t.status === "posted",
    );

    expect(pendingTx).toMatchObject({
      amount: -150,
      description: "測試待入帳消費",
      status: "pending",
      sourceId: "hncb:card:tx:v2:8103:2026-08-10:150:1",
    });
    expect(postedTx).toHaveLength(2);
    expect(postedTx[0]).toMatchObject({
      sourceId: "hncb:card:tx:v2:8103:2026-07-22:230:1",
    });
  });

  it("parses split bill headers and derives card debt from unbilled charges", () => {
    const billHtml = `
      <table>
        <tr><td>帳單年月：</td><td>2026/08</td><td>信用額度：</td><td>70,000</td></tr>
        <tr><td>累積應繳金額：</td><td>279</td><td>最低應繳金額：</td><td>279</td></tr>
        <tr><td colspan="10">ｉ網購生活卡************8103</td></tr>
        <tr><td>1</td><td>07/22</td><td>07/27</td><td>超商</td><td>TW</td><td>TWD</td><td></td><td>279</td></tr>
      </table>
    `;
    const unbilledOnly = `
      <table>
        <tr><td>信用額度：70,000</td></tr>
        <tr><td colspan="10">ｉ網購生活卡************8103</td></tr>
        <tr><td>1</td><td>08/10</td><td></td><td>未出帳</td><td>TW</td><td>TWD</td><td></td><td>150</td></tr>
      </table>
    `;

    const billed = parseHncbData(
      { billsHtml: [billHtml] },
      new Date("2026-08-18T00:00:00.000Z"),
    );
    expect(billed.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-08",
      statementAmount: 279,
    });

    const unbilled = parseHncbData(
      { unbilledHtml: unbilledOnly },
      new Date("2026-08-18T00:00:00.000Z"),
    );
    expect(unbilled.bankAccounts[0]).toMatchObject({
      sourceId: "credit:hncb:8103",
      accountType: "credit",
    });
    expect(unbilled.bankBalanceSnapshots[0]).toMatchObject({
      accountId: "credit:hncb:8103",
      balance: -150,
    });
  });

  it("rolls transaction years back when a bill spans new year", () => {
    const billHtml = `
      <table>
        <tr><td>帳單年月：202601</td><td>信用額度：70,000</td><td>累積應繳金額：500</td></tr>
        <tr><td colspan="10">ｉ網購生活卡************8103</td></tr>
        <tr><td>1</td><td>12/28</td><td>12/30</td><td>跨年消費</td><td>TW</td><td>TWD</td><td></td><td>300</td></tr>
        <tr><td>2</td><td>01/03</td><td>01/05</td><td>本年消費</td><td>TW</td><td>TWD</td><td></td><td>200</td></tr>
      </table>
    `;

    const result = parseHncbData(
      { billsHtml: [billHtml] },
      new Date("2026-01-20T00:00:00.000Z"),
    );

    expect(
      result.bankTransactions.map((tx) => ({
        authorizedAt: tx.authorizedAt,
        postedDate: tx.postedDate,
        sourceId: tx.sourceId,
      })),
    ).toEqual([
      {
        authorizedAt: "2025-12-28",
        postedDate: "2025-12-30",
        sourceId: "hncb:card:tx:v2:8103:2025-12-28:300:1",
      },
      {
        authorizedAt: "2026-01-03",
        postedDate: "2026-01-05",
        sourceId: "hncb:card:tx:v2:8103:2026-01-03:200:2",
      },
    ]);
  });
});
