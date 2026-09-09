import { describe, expect, it } from "vitest";
import {
  matchSinopacAuthorizations,
  type SinopacMatchTransaction,
} from "../../../src/features/sync/sinopac-matching";
const row = (
  id: string,
  amount: number,
  currency: string,
  description = "UNAGISHIKISHIMA",
  day = "2026-09-04",
  card = "4303",
): SinopacMatchTransaction => ({
  id,
  sourceId: `sinopac:card:tx:v2:${currency}:${day}:${amount}:${card}:${id}`,
  authorizedAt: `${day}T18:57:25+08:00`,
  amount,
  currency,
  description,
});
describe("Sinopac authorization assignment", () => {
  it("matches cross currency merchants only within the same card and day, excluding fees", () => {
    const a = row("1", -1096, "TWD", "餐廳/UNAGISHIKISHIMA");
    const b = row("2", -5500, "JPY", "A- UNAGISHIKISHIMA OKINAWA JP");
    expect(
      matchSinopacAuthorizations(
        [a],
        [
          row("3", -5500, "JPY", b.description, "2026-09-05"),
          row("4", -5500, "JPY", b.description, "2026-09-04", "1234"),
          row("5", -83, "JPY", "UNAGISHIKISHIMA 國外交易服務費"),
          b,
        ],
        { JPY: 0.2 },
      ).map((m) => m.posted.id),
    ).toEqual(["2"]);
  });
  it("assigns repeated merchants one to one using amount proximity, independent of ordering", () => {
    const a = [
      row("1", -69, "TWD", "折扣商店/DONQUIJOTE MIYAKOJIMA"),
      row("2", -2216, "TWD", "折扣商店/DONQUIJOTE MIYAKOJIMA"),
    ];
    const b = [
      row("3", -11189, "JPY", "A- DONQUIJOTE MIYAKOJI JP"),
      row("4", -352, "JPY", "A- DONQUIJOTE MIYAKOJI JP"),
    ];
    const pairs = (aa = a, bb = b) =>
      matchSinopacAuthorizations(aa, bb, { JPY: 0.2 }).map((m) => [
        m.authorization.id,
        m.posted.id,
      ]);
    expect(pairs()).toEqual([
      ["2", "3"],
      ["1", "4"],
    ]);
    expect(pairs([...a].reverse(), [...b].reverse())).toEqual(pairs());
  });
  it("does not assign unrelated merchants, opposite signs or unknown cards", () => {
    expect(
      matchSinopacAuthorizations(
        [row("1", -100, "TWD")],
        [
          row("2", -500, "JPY", "ZZZZZ"),
          row("3", 500, "JPY"),
          row("4", -500, "JPY", "UNAGISHIKISHIMA", "2026-09-04", "unknown"),
        ],
        { JPY: 0.2 },
      ),
    ).toEqual([]);
  });
  it("matches a recognizable merchant without an available exchange rate", () => {
    expect(
      matchSinopacAuthorizations(
        [row("1", -1096, "TWD")],
        [row("2", -5500, "JPY")],
        {},
      ),
    ).toHaveLength(1);
  });
});
