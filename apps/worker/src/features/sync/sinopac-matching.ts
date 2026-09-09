export interface SinopacMatchTransaction {
  id: string;
  sourceId: string;
  authorizedAt: string;
  amount: number;
  currency: string;
  description: string;
}

function identity(sourceId: string) {
  const match =
    /^sinopac:card:tx:v2:[^:]+:(\d{4}-\d{2}-\d{2}):[^:]+:(\d{4}):\d+$/.exec(
      sourceId,
    );
  return match ? `${match[2]}:${match[1]}` : undefined;
}

function merchant(value: string) {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/^[^/]+\//, "")
    .replace(/^A\s*-\s*/, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function similarity(left: string, right: string) {
  const a = merchant(left),
    b = merchant(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)))
    return 0.95;
  const grams = (s: string) =>
    new Set(
      Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) =>
        s.slice(i, i + 2),
      ),
    );
  const x = grams(a),
    y = grams(b);
  if (!x.size || !y.size) return 0;
  return (2 * [...x].filter((g) => y.has(g)).length) / (x.size + y.size);
}

function score(
  a: SinopacMatchTransaction,
  b: SinopacMatchTransaction,
  rates: Record<string, number>,
) {
  if (!identity(a.sourceId) || identity(a.sourceId) !== identity(b.sourceId))
    return 0;
  if (Math.sign(a.amount) !== Math.sign(b.amount) || !a.amount || !b.amount)
    return 0;
  if (/手續費|服務費|FEE/i.test(`${a.description} ${b.description}`)) return 0;
  if (a.sourceId === b.sourceId) return 10000;
  const exact = a.currency === b.currency && a.amount === b.amount;
  const name = similarity(a.description, b.description);
  if (!exact && name < 0.3) return 0;
  const rate = (currency: string) => (currency === "TWD" ? 1 : rates[currency]);
  const ar = rate(a.currency),
    br = rate(b.currency);
  const av = Math.abs(a.amount * ar!),
    bv = Math.abs(b.amount * br!);
  const proximity =
    ar > 0 && br > 0 && Number.isFinite(av + bv)
      ? Math.min(av, bv) / Math.max(av, bv)
      : 0;
  return (exact ? 2000 : 0) + 1000 * name + 100 * proximity;
}

// Hungarian assignment: dummy columns leave unsupported candidates unmatched.
// Sorting identities makes tied scores stable across API ordering changes.
export function matchSinopacAuthorizations(
  authorizations: SinopacMatchTransaction[],
  posted: SinopacMatchTransaction[],
  rates: Record<string, number>,
) {
  const a = [...authorizations].sort((x, y) =>
    x.sourceId.localeCompare(y.sourceId),
  );
  const b = [...posted].sort((x, y) => x.id.localeCompare(y.id));
  const groups = new Map<string, SinopacMatchTransaction[]>();
  for (const row of a) {
    const key = identity(row.sourceId);
    if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const matches: Array<{
    authorization: SinopacMatchTransaction;
    posted: SinopacMatchTransaction;
  }> = [];
  for (const [key, rows] of groups) {
    const columns = b.filter((row) => identity(row.sourceId) === key);
    const weights = rows.map((row) => [
      ...columns.map((col) => score(row, col, rates)),
      ...rows.map(() => 0),
    ]);
    const n = rows.length,
      m = columns.length + n;
    const u = Array(n + 1).fill(0),
      v = Array(m + 1).fill(0);
    const p = Array(m + 1).fill(0),
      way = Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const min = Array(m + 1).fill(Infinity),
        used = Array(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity,
          j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = -weights[i0 - 1]![j - 1]! - u[i0] - v[j];
          if (cur < min[j]) {
            min[j] = cur;
            way[j] = j0;
          }
          if (min[j] < delta) {
            delta = min[j];
            j1 = j;
          }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) {
            u[p[j]] += delta;
            v[j] -= delta;
          } else min[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0 !== 0);
    }
    for (let j = 1; j <= columns.length; j++) {
      if (p[j] && weights[p[j] - 1]![j - 1]! > 0)
        matches.push({
          authorization: rows[p[j] - 1]!,
          posted: columns[j - 1]!,
        });
    }
  }
  return matches;
}
