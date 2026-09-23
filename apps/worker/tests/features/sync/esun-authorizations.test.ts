import { describe, expect, it } from "vitest";
import {
  matchEsunAuthorizations,
  type EsunCardRow,
} from "../../../src/features/sync/esun-authorizations";

const row = (
  id: string,
  feed: "realtime" | "history" | undefined,
  overrides: Partial<EsunCardRow> = {},
): EsunCardRow => ({
  id,
  account_id: "card-1204",
  source_id: `2026-09-20T00:00:00.000Z:credit:esun:1204:${id}:330:TWD:1`,
  status: "pending",
  authorized_at:
    feed === "realtime" ? "2026-09-20T19:07:00+08:00" : "2026-09-20",
  amount: -330,
  currency: "TWD",
  raw_payload: JSON.stringify(feed ? { esunFeed: feed } : {}),
  matched_transaction_id: null,
  ...overrides,
});

describe("E.SUN realtime authorization matching", () => {
  it("links a realtime record to the history copy despite a different merchant name", () => {
    expect(
      matchEsunAuthorizations([
        row("linepay", "realtime"),
        row("store", "history"),
      ]),
    ).toEqual([
      {
        id: "linepay",
        posted: "store",
        authorizedAt: "2026-09-20T19:07:00+08:00",
      },
    ]);
  });

  it("pairs repeated equal purchases one-to-one and leaves extras visible", () => {
    const links = matchEsunAuthorizations([
      row("rt-a", "realtime"),
      row("rt-b", "realtime", { authorized_at: "2026-09-20T20:00:00+08:00" }),
      row("history-a", "history"),
    ]);
    expect(links).toEqual([
      expect.objectContaining({ id: "rt-a", posted: "history-a" }),
    ]);
  });

  it("requires the same card, day, currency and amount", () => {
    expect(
      matchEsunAuthorizations([
        row("rt", "realtime"),
        row("other-card", "history", { account_id: "card-9999" }),
        row("other-day", "history", { authorized_at: "2026-09-21" }),
        row("other-amount", "history", { amount: -331 }),
        row("other-currency", "history", { currency: "USD" }),
      ]),
    ).toEqual([]);
  });

  it("keeps saved links and does not reuse their targets", () => {
    expect(
      matchEsunAuthorizations([
        row("rt-old", "realtime", { matched_transaction_id: "history" }),
        row("rt-new", "realtime"),
        row("history", "history", { status: "posted" }),
      ]),
    ).toEqual([]);
  });

  it("treats legacy timed pending rows without a feed marker as authorizations", () => {
    expect(
      matchEsunAuthorizations([
        row("legacy-rt", undefined, {
          authorized_at: "2026-09-20T19:07:00+08:00",
        }),
        row("legacy-history", undefined),
      ]),
    ).toEqual([
      expect.objectContaining({ id: "legacy-rt", posted: "legacy-history" }),
    ]);
  });
});
