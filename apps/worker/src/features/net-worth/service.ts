import {
  calculateBankDepositValue,
  findBankHistoryDateBounds,
  listNetWorthChartHistory,
  listTaiwanStockChartHistory,
  loadStockCostInputs,
  listNetWorthHistory,
  upsertBankDepositHistory,
  type NetWorthPageCursor,
} from "./repository";

// 刪除資料來源時，存款歷史的重算須與刪除位於同一個 batch，因此提供 statements 給呼叫端組合。
export { bankDepositHistoryRebuildStatements } from "./repository";

type StockCostInputs = Awaited<ReturnType<typeof loadStockCostInputs>>;

/**
 * 投入成本中市值還沒進入走勢的部分（台幣），也就是回補的海外成本。前端算未實現損益時從成本扣除，
 * 只比較市值線涵蓋的持股；前端 `apps/web/src/features/overview/model/net-worth-chart.ts` 依同一個值讀取。
 */
export const STOCK_COST_UNVALUED_ASSET_TYPE = "stock_cost_unvalued";

/**
 * 海外市值進入走勢以前的海外成本（台幣，以目前匯率換算）：依海外成交累加買進金額，每個成交日一點；
 * 第一筆買進以前沒有點，視為 0。成交要能完整解釋海外市值第一個點的成本（容許 1% 內的四捨五入與
 * 手續費差距）才回補；海外賣出沒有原始成本、缺金額或匯率，或有成交以外取得的持股時回傳空陣列，
 * 維持從海外市值進入走勢那天起計入，不猜測買進時間。
 */
function backfillForeignCost(
  start: [string, number] | undefined,
  trades: StockCostInputs["foreignTrades"],
  ratesToTwd: StockCostInputs["ratesToTwd"],
): Array<[string, number]> {
  if (!start) return [];
  const [startDate, startCost] = start;
  const buys: Array<[string, number]> = [];
  for (const trade of trades) {
    if (trade.date > startDate) continue;
    const rate = trade.currency === "TWD" ? 1 : ratesToTwd[trade.currency];
    if (trade.code !== "B" || trade.amount === null || rate === undefined)
      return [];
    buys.push([trade.date, Math.abs(trade.amount) * rate]);
  }
  buys.sort(([a], [b]) => a.localeCompare(b));
  const byDate = new Map<string, number>();
  let cost = 0;
  for (const [date, amount] of buys) {
    cost += amount;
    // 第一個點當天的成交已含在快照成本裡，只回補之前的日期。
    if (date < startDate) byDate.set(date, cost);
  }
  if (Math.abs(startCost - cost) > Math.max(1, startCost * 0.01)) return [];
  return [...byDate];
}

/**
 * 股票投入成本走勢（台幣），供走勢圖與股票市值比較，差距即未實現損益。
 * 台股以最新券商快照的成本為基準，依成交往回推：扣掉之後的買進金額、加回之後賣出部位的原始成本；
 * 輸出為階梯序列（每個成交日一點），最早一筆成交之前沿用回推到的成本（涵蓋查詢年限以前的持股）。
 * 賣出缺少原始成本（缺漏或 0）時不再往前推。海外成本取快照日的來源成本，以目前匯率換算，從海外
 * 市值進入走勢那天起計入；更早的日期依海外成交回推到買進日（`backfillForeignCost`），並另外輸出
 * 其中尚無市值的海外成本（`STOCK_COST_UNVALUED_ASSET_TYPE`）。成本無法與市值線對應時回傳空陣列，不畫出誤導的差距：
 * 集保有不屬於直接券商的持股、最新快照有缺成本的持倉，或外幣缺少匯率。
 */
export function buildStockCostHistory(inputs: StockCostInputs) {
  if (inputs.uncoveredTdccHoldings > 0) return [];
  const anchorDate = inputs.positions.at(-1)?.date;
  if (!anchorDate) return [];
  const anchor = inputs.positions.filter((row) => row.date === anchorDate);
  if (anchor.some((row) => row.missing > 0)) return [];

  const toTwd = (row: StockCostInputs["positions"][number]) => {
    if (row.currency === "TWD") return row.cost;
    const rate = inputs.ratesToTwd[row.currency];
    return rate === undefined ? (row.cost === 0 ? 0 : null) : row.cost * rate;
  };

  const taiwan: Array<[string, number]> = [];
  const taiwanAnchor = anchor.filter((row) => !row.foreign_market);
  let cost: number | undefined;
  for (const row of taiwanAnchor) {
    const value = toTwd(row);
    if (value === null) return [];
    cost = (cost ?? 0) + value;
  }
  if (cost !== undefined) {
    const byDate = new Map<string, { buys: number; sold: number | null }>();
    for (const trade of inputs.trades) {
      if (trade.date > anchorDate) continue;
      const day = byDate.get(trade.date) ?? { buys: 0, sold: 0 };
      if (trade.code === "B") {
        if (trade.amount === null) day.sold = null;
        else day.buys += Math.abs(trade.amount);
      } else if (
        // 券商查不到買進成本的賣出會回 0，與缺漏同樣視為未知。
        trade.realizedCost === null ||
        trade.realizedCost <= 0 ||
        day.sold === null
      ) {
        day.sold = null;
      } else {
        day.sold += trade.realizedCost;
      }
      byDate.set(trade.date, day);
    }
    taiwan.push([anchorDate, cost]);
    let complete = true;
    for (const [date, day] of [...byDate].sort(([a], [b]) =>
      b.localeCompare(a),
    )) {
      taiwan.push([date, cost]);
      if (day.sold === null) {
        complete = false;
        break;
      }
      cost = cost - day.buys + day.sold;
    }
    if (complete) taiwan.push(["1900-01-01", cost]);
    taiwan.reverse();
  }

  const foreign = new Map<string, number>();
  if (inputs.foreignStartDate) {
    for (const row of inputs.positions) {
      if (!row.foreign_market || row.date < inputs.foreignStartDate) continue;
      if (row.missing > 0) return [];
      const value = toTwd(row);
      if (value === null) return [];
      foreign.set(row.date, (foreign.get(row.date) ?? 0) + value);
    }
  }

  const latest = (series: Array<[string, number]>, date: string) => {
    let value: number | undefined;
    for (const [day, amount] of series) {
      if (day > date) break;
      value = amount;
    }
    return value;
  };
  const foreignSeries = [...foreign].sort(([a], [b]) => a.localeCompare(b));
  const foreignValueStart = foreignSeries[0]?.[0];
  const foreignBackfill = backfillForeignCost(
    foreignSeries[0],
    inputs.foreignTrades,
    inputs.ratesToTwd,
  );
  // 回補的日期都早於第一個海外點，接在前面仍依日期排序。
  const foreignCosts = [...foreignBackfill, ...foreignSeries];
  const dates = [
    ...new Set([...taiwan, ...foreignCosts].map(([date]) => date)),
  ].sort();
  return dates.flatMap((date) => {
    const taiwanCost = taiwan.length > 0 ? latest(taiwan, date) : 0;
    if (taiwanCost === undefined) return [];
    const foreignCost = latest(foreignCosts, date) ?? 0;
    const cost = {
      date,
      netWorth: Math.round(taiwanCost + foreignCost),
      assetType: "stock_cost",
      source: "cost",
    };
    if (foreignBackfill.length === 0 || foreignValueStart === undefined)
      return [cost];
    // 與成本同樣逐點輸出，海外市值進入走勢那天起為 0；前端依日期沿用前值。
    return [
      cost,
      {
        date,
        netWorth: date < foreignValueStart ? Math.round(foreignCost) : 0,
        assetType: STOCK_COST_UNVALUED_ASSET_TYPE,
        source: "cost",
      },
    ];
  });
}

export async function getNetWorthChartHistory(db: D1Database) {
  const [rows, taiwanStock, costInputs] = await Promise.all([
    listNetWorthChartHistory(db),
    listTaiwanStockChartHistory(db),
    loadStockCostInputs(db),
  ]);
  return [...rows, ...taiwanStock, ...buildStockCostHistory(costInputs)].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.source.localeCompare(b.source) ||
      a.assetType.localeCompare(b.assetType),
  );
}

export async function getNetWorthPage(
  db: D1Database,
  limit: number,
  cursor?: NetWorthPageCursor,
) {
  const rows = await listNetWorthHistory(db, limit + 1, cursor);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    hasMore,
    last,
    history: page.map(({ id: _id, ...row }) => row).reverse(),
  };
}

export function dateFromIso(iso: string) {
  return iso.slice(0, 10);
}

export async function rebuildBankDepositHistory(
  db: D1Database,
  dates: string[],
) {
  if (dates.length === 0) return;
  const points = [];
  for (const date of dates) {
    points.push({ date, netWorth: await calculateBankDepositValue(db, date) });
  }
  await upsertBankDepositHistory(db, points, new Date().toISOString());
}

export async function rebuildBankDepositHistoryRange(
  db: D1Database,
  from?: string,
  to?: string,
) {
  const bounds = await findBankHistoryDateBounds(db);
  if (!bounds?.minDate || !bounds.maxDate) return { dates: 0 };
  const resolvedFrom = from ?? bounds.minDate;
  const resolvedTo = to ?? bounds.maxDate;
  if (resolvedFrom > resolvedTo) return { dates: 0 };
  const dates = enumerateDates(resolvedFrom, resolvedTo);
  await rebuildBankDepositHistory(db, dates);
  return { dates: dates.length, from: resolvedFrom, to: resolvedTo };
}

function enumerateDates(from: string, to: string) {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
