import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { TimeoutError } from "@cloudflare/puppeteer";
import type { Page } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeLoans } from "../../../src/sources/cathaybk/connector";

const overviewUrl =
  "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInq";
const readFixture = (name: string) =>
  readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8");
const tableHtml = readFixture("cathay-loan-overview-table.html");
const emptyHtml = readFixture("cathay-loan-overview-empty.html");

function fakePage(document: Document) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn(() => overviewUrl),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (callback: (root: Document) => unknown) =>
      callback(document),
    ),
  } as unknown as Page;
}

afterEach(() => vi.restoreAllMocks());

describe("Cathay loan scraping completeness", () => {
  it("returns visible parseable loans without marking an unreconciled overview complete", async () => {
    const dom = new JSDOM(tableHtml, { url: overviewUrl });
    dom.window.document.querySelector("tbody > tr")?.remove();
    const page = fakePage(dom.window.document);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(result.loanOverviewComplete).toBe(false);
    expect(result.bankAccounts).toHaveLength(4);
    expect(result.bankBalanceSnapshots).toHaveLength(4);
    expect(
      result.bankAccounts.map((account) => account.sourceId),
    ).not.toContain("loan:cathaybk:0000000000000001");
  });

  it("marks a reconciled overview complete", async () => {
    const dom = new JSDOM(tableHtml, { url: overviewUrl });
    const page = fakePage(dom.window.document);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(result.loanOverviewComplete).toBe(true);
    expect(result.bankAccounts).toHaveLength(5);
    expect(result.bankBalanceSnapshots).toHaveLength(5);
    const serializedLogs = log.mock.calls
      .map(([message]) => String(message))
      .join("\n");
    expect(serializedLogs).not.toContain('"event":"cathaybk_loan_stage"');
    expect(serializedLogs).not.toContain(
      '"event":"cathaybk_loan_parse_success"',
    );
  });

  it("continues after a query wait timeout without loan diagnostics", async () => {
    const dom = new JSDOM(tableHtml, { url: overviewUrl });
    const page = fakePage(dom.window.document);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(page, "waitForFunction").mockRejectedValueOnce(
      new TimeoutError("PRIVATE_QUERY_WAIT_DETAILS"),
    );

    const result = await scrapeLoans(page);

    expect(result.bankAccounts).toHaveLength(5);
    const serializedLogs = log.mock.calls
      .map(([message]) => String(message))
      .join("\n");
    expect(serializedLogs).not.toContain('"event":"cathaybk_loan_stage"');
    expect(serializedLogs).not.toContain("PRIVATE_QUERY_WAIT_DETAILS");
  });

  it("marks DOM extraction failure without logging the error message", async () => {
    const dom = new JSDOM(tableHtml, { url: overviewUrl });
    const page = fakePage(dom.window.document);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(page, "evaluate").mockRejectedValueOnce(
      new Error("PRIVATE_PAGE_CONTENT_SENTINEL"),
    );

    await expect(scrapeLoans(page)).rejects.toThrow(
      "PRIVATE_PAGE_CONTENT_SENTINEL",
    );

    const serializedLogs = log.mock.calls
      .map(([message]) => String(message))
      .join("\n");
    expect(serializedLogs).toBe("");
    expect(serializedLogs).not.toContain("PRIVATE_PAGE_CONTENT_SENTINEL");
  });

  it("treats the official empty state as complete without a displayed total", async () => {
    const dom = new JSDOM(emptyHtml, { url: overviewUrl });
    const page = fakePage(dom.window.document);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(result.loanOverviewComplete).toBe(true);
    expect(result.bankAccounts).toEqual([]);
    expect(result.bankBalanceSnapshots).toEqual([]);
  });
});
