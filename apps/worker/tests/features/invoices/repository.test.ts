import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import * as repository from "../../../src/features/invoices/repository";

const now = "2026-09-12T00:00:00.000Z";

describe("invoice repository", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await harness.binding.batch([
      harness.binding.prepare("DELETE FROM invoice_line_items"),
      harness.binding.prepare("DELETE FROM invoices"),
    ]);
  });

  async function invoice(input: {
    id: string;
    sourceId: string;
    invoiceDate: string;
    amount?: number;
    sellerName?: string | null;
    invoiceNumber?: string | null;
    updatedAt?: string;
  }) {
    await harness.binding
      .prepare(
        `INSERT INTO invoices (
          id, connector_id, source_id, invoice_number, invoice_date,
          seller_name, amount, created_at, updated_at
        ) VALUES (?, 'einvoice', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.sourceId,
        input.invoiceNumber ?? null,
        input.invoiceDate,
        input.sellerName ?? null,
        input.amount ?? 100,
        now,
        input.updatedAt ?? now,
      )
      .run();
  }

  it("pages by invoice_date, updated_at and id and finds a detail row", async () => {
    const db = harness.binding;
    await invoice({
      id: "c",
      sourceId: "c",
      invoiceDate: "2026-09-01",
      updatedAt: "2026-09-01T01:00:00.000Z",
    });
    await invoice({
      id: "b",
      sourceId: "b",
      invoiceDate: "2026-09-01",
      updatedAt: "2026-09-01T02:00:00.000Z",
    });
    await invoice({
      id: "a",
      sourceId: "a",
      invoiceDate: "2026-09-02",
    });
    await expect(repository.findInvoice(db, "missing")).resolves.toBeNull();
    await expect(repository.findInvoice(db, "a")).resolves.toMatchObject({
      id: "a",
      connectorId: "einvoice",
      sourceId: "a",
      invoiceNumber: null,
      sellerName: null,
      amount: 100,
    });
    expect(await repository.findInvoice(db, "a")).not.toHaveProperty(
      "updatedAt",
    );
    const first = await repository.listInvoices(db, 2);
    expect(first.map((row) => row.id)).toEqual(["a", "b"]);
    const next = await repository.listInvoices(db, 2, {
      invoiceDate: first[1].invoiceDate,
      updatedAt: first[1].updatedAt,
      id: first[1].id,
    });
    expect(next.map((row) => row.id)).toEqual(["c"]);
  });

  it("uses Taipei calendar days for precise timestamps at month boundaries", async () => {
    const db = harness.binding;
    await invoice({
      id: "sep",
      sourceId: "sep",
      invoiceDate: "2026-08-31T16:30:00.000Z",
    });
    await invoice({
      id: "aug",
      sourceId: "aug",
      invoiceDate: "2026-08-31T15:59:00.000Z",
    });
    await invoice({
      id: "date",
      sourceId: "date",
      invoiceDate: "2026-09-01",
    });
    const range = { from: "2026-09-01", to: "2026-10-01" };
    expect(
      (await repository.listInvoicesInRange(db, range))
        .map((row) => row.id)
        .sort(),
    ).toEqual(["date", "sep"]);
    expect(
      (await repository.listInvoicesInRange(db, range, ["2026-09-01"]))
        .map((row) => row.id)
        .sort(),
    ).toEqual(["date", "sep"]);
  });

  it("lists line items in invoice, line and source order", async () => {
    const db = harness.binding;
    await invoice({
      id: "inv-b",
      sourceId: "inv-b",
      invoiceDate: "2026-09-01",
    });
    await invoice({
      id: "inv-a",
      sourceId: "inv-a",
      invoiceDate: "2026-09-01",
    });
    await db
      .prepare(
        `INSERT INTO invoice_line_items (
          id, invoice_id, connector_id, invoice_source_id, source_id,
          line_number, description, quantity, unit_price, amount,
          created_at, updated_at
        ) VALUES
          ('b2', 'inv-b', 'einvoice', 'inv-b', 'b2', 1, '後', NULL, NULL, 2, ?, ?),
          ('a2', 'inv-a', 'einvoice', 'inv-a', 'a2', 2, '二', 1, 20, 20, ?, ?),
          ('a1', 'inv-a', 'einvoice', 'inv-a', 'a1', 1, '一', 2, 10, 20, ?, ?)`,
      )
      .bind(now, now, now, now, now, now)
      .run();
    await expect(repository.listInvoiceItems(db, [])).resolves.toEqual([]);
    expect(
      (await repository.listInvoiceItems(db, ["inv-a", "inv-b"])).map(
        (row) => row.id,
      ),
    ).toEqual(["a1", "a2", "b2"]);
  });
});
