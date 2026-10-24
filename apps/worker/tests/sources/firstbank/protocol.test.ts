import { describe, expect, it } from "vitest";
import { parseFirstbankData } from "../../../src/sources/firstbank/protocol";

const NOW = new Date("2026-10-03T03:00:00Z");
const ILEO_ACCOUNT = "112233445566";
const MAIN_ACCOUNT = "665544332211";

const depositOverviewHtml = `
  <table>
    <tr class="ResultHeader">
      <td>分行</td><td>帳戶<br>類別</td><td>帳號<br>與暱稱</td>
      <td>幣別</td><td>帳面<br>餘額</td><td>可用<br>餘額</td><td>其他功能</td>
    </tr>
    <tr class="ResultContent">
      <td>合成分行</td><td>iLEO 帳戶</td><td>${ILEO_ACCOUNT}</td>
      <td>新臺幣</td><td>3,000</td><td>3,000</td><td>-</td>
    </tr>
    <tr class="ResultContent">
      <td>合成分行</td><td>金如意</td><td>${MAIN_ACCOUNT}</td>
      <td>新臺幣</td><td>60,000</td><td>60,000</td><td>-</td>
    </tr>
  </table>
`;

/**
 * 版面取自 Worker 實際送進 parser 的 010103 內容：Worker 只保留 <table>，交易時間
 * 說明與「帳號」都在表格內，且說明排在帳號前面；帳號與金額為合成資料。
 */
function transactionPage(accountNumber: string, deposit: string) {
  return `
    <table>
      <tr><td>交易明細起迄日 自115/9/10起，帳戶交易明細查詢提供交易時間資訊。</td></tr>
      <tr><td>帳號 ${accountNumber}</td></tr>
    </table>
    <table>
      <tr class="ResultHeader">
        <td>交易<br>日期</td><td>交易類別</td><td>支出<br>金額</td>
        <td>存入<br>金額</td><td>餘額</td><td>狀態</td><td>備註</td><td>摘要</td>
      </tr>
      <tr class="ResultContent">
        <td>2026/09/30 10:20:30</td><td>轉帳存入</td><td>0</td><td>${deposit}</td>
        <td>9,999</td><td>正常</td><td>合成匯款</td><td>存入</td>
      </tr>
    </table>
  `;
}

function accountIdFor(
  result: ReturnType<typeof parseFirstbankData>,
  accountNumber: string,
) {
  return result.bankAccounts.find((account) =>
    account.sourceId.includes(`:${accountNumber.slice(-4)}:`),
  )?.sourceId;
}

describe("第一銀行交易明細", () => {
  it("說明文字排在帳號前面時，多個存款帳戶仍依頁面帳號對應明細", () => {
    const result = parseFirstbankData(
      {
        depositOverviewHtml,
        transactionHistoryHtml: transactionPage(ILEO_ACCOUNT, "5"),
      },
      NOW,
    );
    expect(result.bankTransactions).toHaveLength(1);
    expect(result.bankTransactions[0]).toMatchObject({
      accountId: accountIdFor(result, ILEO_ACCOUNT),
      amount: 5,
    });
  });

  it("逐帳號查詢的明細頁各自寫入對應的存款帳戶", () => {
    const result = parseFirstbankData(
      {
        depositOverviewHtml,
        transactionHistoryHtml: [
          transactionPage(ILEO_ACCOUNT, "5"),
          transactionPage(MAIN_ACCOUNT, "72,000"),
        ],
      },
      NOW,
    );
    expect(
      result.bankTransactions.map(({ accountId, amount }) => ({
        accountId,
        amount,
      })),
    ).toEqual([
      { accountId: accountIdFor(result, ILEO_ACCOUNT), amount: 5 },
      { accountId: accountIdFor(result, MAIN_ACCOUNT), amount: 72000 },
    ]);
  });

  it("明細頁沒有回顯帳號時，依每次查詢選取的帳號歸戶", () => {
    const result = parseFirstbankData(
      {
        depositOverviewHtml,
        transactionHistoryHtml: [
          transactionPage("", "5"),
          transactionPage("", "72,000"),
        ],
        transactionAccounts: [
          { label: `iLEO ${ILEO_ACCOUNT}`, value: "opaque-option-1" },
          { label: "主要帳戶", value: MAIN_ACCOUNT },
        ],
      },
      NOW,
    );
    expect(
      result.bankTransactions.map(({ accountId, amount }) => ({
        accountId,
        amount,
      })),
    ).toEqual([
      { accountId: accountIdFor(result, ILEO_ACCOUNT), amount: 5 },
      { accountId: accountIdFor(result, MAIN_ACCOUNT), amount: 72000 },
    ]);
    expect(JSON.stringify(result)).not.toContain(ILEO_ACCOUNT);
    expect(JSON.stringify(result)).not.toContain(MAIN_ACCOUNT);
  });

  it("多帳戶且頁面與查詢皆無帳號識別時，不猜測交易歸戶", () => {
    expect(() =>
      parseFirstbankData(
        {
          depositOverviewHtml,
          transactionHistoryHtml: transactionPage("", "5"),
        },
        NOW,
      ),
    ).toThrow("第一銀行交易明細找不到對應的存款帳戶。");
  });
});
