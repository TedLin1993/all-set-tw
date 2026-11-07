import { describe, it, expect } from "vitest";
import { mergeSinotradeAccountHoldings } from "../../../src/sources/sinotrade/connector";
import type { SinotradeHolding } from "../../../src/sources/sinotrade/protocol";

const row: SinotradeHolding = {
  market: "US",
  currency: "USD",
  symbol: "TEST",
  name: "虛構公司",
  quantity: 0.375,
  marketValue: 39.123,
  costBasis: 37.545,
  unrealizedPnl: 1.578,
};
describe("同帳戶兩平台持倉完整性", () => {
  it("相同部位只計一次，來源範圍不一致時拒絕猜測相加", () => {
    expect(mergeSinotradeAccountHoldings([row], [row])).toEqual([row]);
    expect(mergeSinotradeAccountHoldings([], [row])).toEqual([row]);
    expect(() =>
      mergeSinotradeAccountHoldings([row], [{ ...row, quantity: 0.5 }]),
    ).toThrow(/數量不一致/);
    expect(() =>
      mergeSinotradeAccountHoldings([row], [{ ...row, costBasis: 100 }]),
    ).toThrow(/成本不一致/);
    expect(() =>
      mergeSinotradeAccountHoldings([row], [{ ...row, currency: "TWD" }]),
    ).toThrow(/幣別不一致/);
    expect(
      mergeSinotradeAccountHoldings([row], [{ ...row, symbol: "OTHR" }]),
    ).toHaveLength(2);
  });
});
