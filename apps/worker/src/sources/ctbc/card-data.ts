import { BANK_SYNC_MONTHS } from "../sync-window";
type Json = Record<string, unknown>;
type Request = (resource: string, data: Json) => Promise<Json>;
const invalid = () => new Error("中國信託信用卡明細或分頁完整性無法確認。");
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
function rows(value: unknown): Json[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        item === null || typeof item !== "object" || Array.isArray(item),
    )
  )
    throw invalid();
  return value;
}

async function query(
  request: Request,
  resource: string,
  data: Json,
  emptyUnbilled = false,
): Promise<Json> {
  let response: Json;
  try {
    response = await request(resource, data);
  } catch {
    throw new Error("中國信託信用卡明細查詢未完成。");
  }
  const body = record(response.rsData);
  // qu006's official error handler explicitly treats 8888 as no unbilled data.
  if (emptyUnbilled && response.code === "8888") {
    if (
      body.allItems != null &&
      (!Array.isArray(body.allItems) || body.allItems.length)
    )
      throw invalid();
    if (body.totalRow != null && Number(body.totalRow) !== 0) throw invalid();
    return { allItems: [] };
  }
  if (
    (response.code != null && response.code !== "0000") ||
    (response.statusCode != null && response.statusCode !== "0000") ||
    response.success === false
  )
    throw invalid();
  return body;
}

function pagination(
  data: Json,
  length: number,
  mode: "statement" | "unbilled" | "realtime",
) {
  if (
    mode === "realtime" &&
    data.noMore != null &&
    typeof data.noMore !== "boolean"
  )
    throw invalid();
  const paging =
    mode === "realtime"
      ? data.noMore === false
      : data.displayPaging === true || data.displayPaging === "Y";
  const pageSize =
    data.pageCount == null || data.pageCount === ""
      ? 100
      : Number(data.pageCount);
  const total = data.totalRow == null ? length : Number(data.totalRow);
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    !Number.isInteger(total) ||
    total < 0 ||
    total < length
  )
    throw invalid();
  if (paging && data.totalRow == null) throw invalid();
  const pages = paging ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  // A protective limit must fail explicitly, never silently truncate data.
  if (pages > 20 || (!paging && total !== length)) throw invalid();
  return { pages, total };
}

/** Mobile 5.2.26 qu002: statement details are lazy-loaded per currency/month. */
export async function fetchCtbcCardStatements(
  request: Request,
  overview: Json,
) {
  const data = record(overview.rsData);
  const months = BANK_SYNC_MONTHS;
  if (
    !Number.isInteger(months) ||
    months < 1 ||
    months > 6 ||
    !data.billData ||
    typeof data.billData !== "object" ||
    Array.isArray(data.billData)
  )
    throw invalid();
  const billData: Json = {};
  for (const [currency, values] of Object.entries(record(data.billData))) {
    if (!/^[A-Z]{3}$/.test(currency)) throw invalid();
    const periods = Object.entries(record(values)).filter(
      ([, group]) => record(group).summary !== null,
    );
    if (periods.some(([period]) => !/^\d{4}[/-](0[1-9]|1[0-2])$/.test(period)))
      throw invalid();
    const selected: Json = {};
    for (const [month, groupValue] of periods
      .sort(([a], [b]) =>
        b.replace("/", "-").localeCompare(a.replace("/", "-")),
      )
      .slice(0, months)) {
      const original = record(groupValue);
      const detail = await query(request, "/twrbm-card/qu002/011", {
        curCode: currency,
        month,
        billCycle: data.billCycle,
      });
      const bills = [...rows(detail.bills)];
      const { pages, total } = pagination(detail, bills.length, "statement");
      for (let pageNum = 2; pageNum <= pages; pageNum++) {
        const page = await query(request, "/twrbm-card/qu002/016", {
          curCode: currency,
          month,
          pageNum,
        });
        bills.push(...rows(page.bills));
      }
      if (bills.length !== total) throw invalid();
      selected[month] = {
        ...original,
        ...detail,
        summary: detail.summary ?? original.summary,
        bills,
      };
    }
    billData[currency] = selected;
  }
  return { ...overview, rsData: { ...data, billData } };
}

export async function fetchCtbcPagedCardItems(
  request: Request,
  initialResource: string,
  pageResource: string,
  data: Json,
  mode: "unbilled" | "realtime",
) {
  const initial = await query(
    request,
    initialResource,
    data,
    mode === "unbilled",
  );
  const allItems = [...rows(initial.allItems)];
  const { pages, total } = pagination(initial, allItems.length, mode);
  for (let pageNum = 2; pageNum <= pages; pageNum++) {
    const page = await query(request, pageResource, { pageNum });
    allItems.push(...rows(page.allItems));
  }
  if (allItems.length !== total) throw invalid();
  return { rsData: { ...initial, allItems } };
}
