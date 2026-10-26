import { taipeiDateKey } from "@taiwan-fin-hub/shared";

/** 依機構彙整今天到期的定存；推播只寫機構與筆數，不含金額與帳號。 */
export interface MaturityReminder {
  institution: string;
  count: number;
}

export type MaturingTimeDepositRow = {
  id: string;
  institutionName: string | null;
  maturityDate: string | null;
  inactiveAt: string | null;
};

/**
 * 整理台北時間今天到期的定存。到期當天銀行可能已解約入帳，同步會先將帳戶標為失效，
 * 因此當天才失效的定存仍提醒；到期前就失效的（提前解約）不提醒。
 * 自動續存的定存若在到期當天已換成下一期到期日，就不會提醒。
 */
export function collectMaturityReminders(
  rows: MaturingTimeDepositRow[],
  now = new Date(),
): MaturityReminder[] {
  const today = taipeiDateKey(now);
  const groups = new Map<string, MaturityReminder>();
  for (const row of rows) {
    if (row.maturityDate !== today) continue;
    if (row.inactiveAt) {
      const inactiveTime = new Date(row.inactiveAt);
      if (
        !Number.isFinite(inactiveTime.getTime()) ||
        taipeiDateKey(inactiveTime) < today
      )
        continue;
    }
    const institution = row.institutionName ?? "";
    const group = groups.get(institution);
    if (group) group.count += 1;
    else groups.set(institution, { institution, count: 1 });
  }
  return [...groups.values()].sort((a, b) =>
    a.institution.localeCompare(b.institution),
  );
}
