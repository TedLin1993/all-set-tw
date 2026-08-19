import assert from "node:assert/strict";
import { parseHncbConfig, parseHncbData } from "../../src/hncb";

assert.deepEqual(
  parseHncbConfig({
    userId: "A123456789",
    account: "user",
    password: "password",
  }),
  {
    userId: "A123456789",
    account: "user",
    password: "password",
  },
);

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
    depositOverviewHtml,
    billsHtml: [billHtml],
    unbilledHtml,
  },
  new Date("2026-08-18T00:00:00.000Z"),
);

assert.equal(result.bankAccounts.length, 3); // 2 deposit + 1 credit
assert.equal(
  result.bankAccounts.find((a) => a.accountType === "credit")?.creditLimit,
  70000,
);
assert.equal(result.creditCardBills.length, 1);
assert.equal(result.creditCardBills[0]?.statementAmount, 279);
assert.equal(result.bankBalanceSnapshots.length, 3); // 2 deposit snapshots + 1 credit card snapshot
assert.equal(result.bankTransactions.length, 3); // 2 posted + 1 pending
assert.equal(
  result.bankTransactions.find((t) => t.status === "pending")?.amount,
  -150,
);

console.log("HNCB connector self-check passed.");
