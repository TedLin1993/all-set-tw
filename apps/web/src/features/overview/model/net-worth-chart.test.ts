import { describe, expect, it } from "vitest";
import {
  buildNetWorthChartData,
  restoreIncludedNetWorthAssets,
} from "./net-worth-chart";

describe("淨資產走勢的加密貨幣系列", () => {
  it("Binance 與 MAX 各自沿用最新值後加總，並計入淨資產", () => {
    const rows = [
      {
        date: "2026-10-21",
        netWorth: 1000,
        assetType: "deposit",
        source: "bank",
      },
      {
        date: "2026-10-21",
        netWorth: 300,
        assetType: "crypto",
        source: "binance",
      },
      { date: "2026-10-22", netWorth: 200, assetType: "crypto", source: "max" },
      {
        date: "2026-10-23",
        netWorth: 500,
        assetType: "crypto",
        source: "binance",
      },
    ];
    const points = buildNetWorthChartData(
      rows,
      ["crypto", "deposit"],
      "ALL",
      new Date("2026-10-23T12:00:00+08:00"),
    );
    // 10/22：binance 沿用 300 + max 200 = 500；10/23：binance 500 + max 沿用 200 = 700
    expect(
      points.map(({ date, crypto, selectedTotal }) => ({
        date,
        crypto,
        selectedTotal,
      })),
    ).toEqual([
      { date: "2026-10-21", crypto: 300, selectedTotal: 1300 },
      { date: "2026-10-22", crypto: 500, selectedTotal: 1500 },
      { date: "2026-10-23", crypto: 700, selectedTotal: 1700 },
    ]);
  });

  it("舊版偏好自動補上新的預設類別，看過後取消的類別維持取消", () => {
    expect(restoreIncludedNetWorthAssets(["stock", "deposit"], null)).toEqual([
      "stock",
      "deposit",
      "crypto",
    ]);
    expect(
      restoreIncludedNetWorthAssets(
        ["stock", "deposit"],
        ["stock", "fund", "crypto", "deposit", "manual"],
      ),
    ).toEqual(["stock", "deposit"]);
    expect(restoreIncludedNetWorthAssets(["bogus"], null)).toBeNull();
    expect(restoreIncludedNetWorthAssets("x", null)).toBeNull();
  });
});
