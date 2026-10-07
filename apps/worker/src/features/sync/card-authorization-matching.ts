export type CardAuthorizationCandidate = {
  id: string;
  sourceId: string;
  accountId: string;
  cardId: string | undefined;
  authorizedAt: string | null;
  amount: number;
  currency: string;
};

export type CardAuthorizationLink = {
  id: string;
  posted: string;
  authorizedAt: string | null;
};

export function cardAuthorizationMatchKey(row: CardAuthorizationCandidate) {
  if (!row.accountId || !row.cardId || !row.authorizedAt || !row.currency)
    return undefined;
  return JSON.stringify([
    row.accountId,
    row.cardId,
    row.authorizedAt.slice(0, 10),
    row.currency,
    row.amount,
  ]);
}

// Callers exclude established links and normalize the source's card identity.
// Allocate each detail once; a partial group leaves the remaining rows visible.
export function matchCardAuthorizations(
  authorizations: readonly CardAuthorizationCandidate[],
  details: readonly CardAuthorizationCandidate[],
): CardAuthorizationLink[] {
  const available = new Map<string, CardAuthorizationCandidate[]>();
  for (const row of [...details].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  )) {
    const key = cardAuthorizationMatchKey(row);
    if (!key) continue;
    const group = available.get(key) ?? [];
    group.push(row);
    available.set(key, group);
  }
  return [...authorizations]
    .sort(
      (left, right) =>
        (left.authorizedAt ?? "").localeCompare(right.authorizedAt ?? "") ||
        left.sourceId.localeCompare(right.sourceId),
    )
    .flatMap((authorization) => {
      const key = cardAuthorizationMatchKey(authorization);
      const target = key ? available.get(key)?.shift() : undefined;
      return target
        ? [
            {
              id: authorization.id,
              posted: target.id,
              authorizedAt: authorization.authorizedAt,
            },
          ]
        : [];
    });
}
