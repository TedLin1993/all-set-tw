import type { BankAccountRow } from "./types";

function groupBy(
  accounts: BankAccountRow[],
  keyOf: (account: BankAccountRow) => string,
) {
  const groups = new Map<string, BankAccountRow[]>();
  for (const account of accounts) {
    const key = keyOf(account);
    const group = groups.get(key);
    if (group) group.push(account);
    else groups.set(key, [account]);
  }
  return [...groups.values()];
}

/**
 * 依實體帳戶分組存款：同一資料來源、末四碼相同的幣別子帳戶
 * （例如同一外幣帳號的 USD 與 JPY）為一組；定存與沒有末四碼的帳戶各自一組。
 * 同一組已有相同幣別時視為末四碼碰巧相同的另一個帳戶，另開一組。
 * 分組順序與組內順序沿用輸入順序。
 */
export function groupDepositAccounts(deposits: BankAccountRow[]) {
  const groups: BankAccountRow[][] = [];
  const byKey = new Map<string, BankAccountRow[][]>();
  for (const account of deposits) {
    const key =
      account.accountType !== "time_deposit" && account.accountLast4
        ? `${account.connectorId}:${account.accountLast4}`
        : `id:${account.id}`;
    const candidates = byKey.get(key) ?? [];
    const group = candidates.find((members) =>
      members.every((member) => member.currency !== account.currency),
    );
    if (group) {
      group.push(account);
      continue;
    }
    const created = [account];
    groups.push(created);
    byKey.set(key, [...candidates, created]);
  }
  return groups;
}

/** 存款帳戶數，以實體帳戶計算，與銀行的帳戶數一致。 */
export function depositAccountCount(deposits: BankAccountRow[]) {
  return groupDepositAccounts(deposits).length;
}

/**
 * 依信用卡帳戶分組。永豐、中信等來源以「帳戶＋幣別」建立信用卡資料，
 * sourceId 以幣別結尾；去掉幣別後相同的視為同一個信用卡帳戶。
 * 分組順序沿用輸入順序，組內台幣排第一。
 */
export function groupCardAccounts(cards: BankAccountRow[]) {
  return groupBy(
    cards,
    (card) =>
      `${card.connectorId}:${card.sourceId.replace(
        new RegExp(`:${card.currency}$`, "i"),
        "",
      )}`,
  ).map((members) =>
    [...members].sort(
      (a, b) => Number(b.currency === "TWD") - Number(a.currency === "TWD"),
    ),
  );
}

/** 信用卡帳戶數；同一帳戶的不同幣別只算一個。 */
export function cardAccountCount(cards: BankAccountRow[]) {
  return groupCardAccounts(cards).length;
}
