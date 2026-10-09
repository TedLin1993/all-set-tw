export type CardAuthorizationCandidate = {
  id: string;
  sourceId: string;
  accountId: string;
  cardId: string | undefined;
  authorizedAt: string | null;
  amount: number;
  currency: string;
  authorizationId?: string;
};

export type CardAuthorizationLink = {
  id: string;
  posted: string;
  authorizedAt: string | null;
};

export function cardPurchaseDay(value: string | null) {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value
      ? value
      : undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : undefined;
}

export function cardAuthorizationMatchKey(row: CardAuthorizationCandidate) {
  const day = cardPurchaseDay(row.authorizedAt);
  if (
    !row.accountId ||
    !row.cardId ||
    !day ||
    !row.currency ||
    !Number.isFinite(row.amount) ||
    row.amount === 0
  )
    return undefined;
  return JSON.stringify([
    row.accountId,
    row.cardId,
    day,
    row.currency,
    row.amount,
  ]);
}

// Callers exclude established links and normalize the source's card identity.
// Allocate each detail once; a partial group leaves the remaining rows visible.
export function matchCardAuthorizations<T extends CardAuthorizationCandidate>(
  authorizations: readonly T[],
  details: readonly T[],
  options: {
    matchesReference?: (authorization: T, detail: T) => boolean;
  } = {},
): CardAuthorizationLink[] {
  const orderedDetails = [...details].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
  const orderedAuthorizations = [...authorizations].sort(
    (left, right) =>
      (Date.parse(
        left.authorizedAt?.length === 10
          ? `${left.authorizedAt}T00:00:00+08:00`
          : (left.authorizedAt ?? ""),
      ) || 0) -
        (Date.parse(
          right.authorizedAt?.length === 10
            ? `${right.authorizedAt}T00:00:00+08:00`
            : (right.authorizedAt ?? ""),
        ) || 0) || left.sourceId.localeCompare(right.sourceId),
  );
  const usedAuthorizations = new Set<string>();
  const usedDetails = new Set<string>();
  const links: CardAuthorizationLink[] = [];
  const compatible = (authorization: T, detail: T) =>
    !authorization.authorizationId ||
    !detail.authorizationId ||
    authorization.authorizationId === detail.authorizationId;
  const link = (authorization: T, detail: T) => {
    usedAuthorizations.add(authorization.id);
    usedDetails.add(detail.id);
    links.push({
      id: authorization.id,
      posted: detail.id,
      authorizedAt: authorization.authorizedAt,
    });
  };

  // A bank's reliable reference takes precedence over amount-based allocation.
  // A non-unique reference alone cannot establish the identity of a purchase.
  if (options.matchesReference) {
    const candidates = orderedAuthorizations.map((authorization) =>
      orderedDetails.filter(
        (detail) =>
          compatible(authorization, detail) &&
          options.matchesReference!(authorization, detail),
      ),
    );
    orderedAuthorizations.forEach((authorization, index) => {
      const matches = candidates[index]!;
      if (matches.length !== 1) return;
      const detail = matches[0]!;
      if (candidates.filter((group) => group.includes(detail)).length === 1)
        link(authorization, detail);
    });
  }

  const available = new Map<string, T[]>();
  for (const row of orderedDetails) {
    if (usedDetails.has(row.id)) continue;
    const key = cardAuthorizationMatchKey(row);
    if (!key) continue;
    const group = available.get(key) ?? [];
    group.push(row);
    available.set(key, group);
  }
  for (const authorization of orderedAuthorizations) {
    if (usedAuthorizations.has(authorization.id)) continue;
    const key = cardAuthorizationMatchKey(authorization);
    const group = key ? available.get(key) : undefined;
    const index =
      group?.findIndex(
        (detail) =>
          !usedDetails.has(detail.id) && compatible(authorization, detail),
      ) ?? -1;
    if (group && index >= 0) link(authorization, group.splice(index, 1)[0]!);
  }
  return links;
}
