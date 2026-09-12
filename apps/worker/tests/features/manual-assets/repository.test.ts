import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createManualAsset,
  deleteManualAsset,
  listLatestManualAssetValues,
  listManualAssetHistory,
  listManualAssets,
  updateManualAsset,
} from "../../../src/features/manual-assets/repository";
import { createTestD1 } from "../../../../../packages/db/testing/d1";

describe("manual asset repository", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;

  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    await harness.binding.batch([
      harness.binding.prepare(
        "DELETE FROM net_worth_history WHERE source = 'manual'",
      ),
      harness.binding.prepare("DELETE FROM manual_assets"),
    ]);
  });

  it("lists valuation history from oldest to newest", async () => {
    await createManualAsset(harness.binding, {
      id: "manual:stock",
      name: "股票",
      category: "investment",
      note: null,
      currency: "TWD",
      value: 3031,
      date: "2025-03-03",
      now: "2025-03-03T00:00:00.000Z",
    });
    await updateManualAsset(
      harness.binding,
      "manual:stock",
      { value: 4790, date: "2026-08-03" },
      "2026-08-03T00:00:00.000Z",
    );

    await expect(
      listManualAssetHistory(harness.binding, "manual:stock"),
    ).resolves.toEqual([
      { date: "2025-03-03", value: 3031 },
      { date: "2026-08-03", value: 4790 },
    ]);
  });

  it("creates an asset and its first valuation in one batch", async () => {
    await createManualAsset(harness.binding, {
      id: "manual:home",
      name: "房子",
      category: "real_estate",
      note: "備註",
      currency: "TWD",
      value: 100,
      date: "2026-08-01",
      now: "2026-08-01T00:00:00.000Z",
    });

    await expect(listManualAssets(harness.binding)).resolves.toEqual([
      {
        id: "manual:home",
        name: "房子",
        category: "real_estate",
        note: "備註",
        currency: "TWD",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    await expect(listLatestManualAssetValues(harness.binding)).resolves.toEqual(
      [{ assetId: "manual:home", value: 100, date: "2026-08-01" }],
    );
  });

  it("updates asset metadata and its current valuation atomically", async () => {
    await createManualAsset(harness.binding, {
      id: "manual:home",
      name: "舊名稱",
      category: "real_estate",
      note: "舊備註",
      currency: "TWD",
      value: 100,
      date: "2026-08-01",
      now: "2026-08-01T00:00:00.000Z",
    });

    await updateManualAsset(
      harness.binding,
      "manual:home",
      {
        name: "新名稱",
        note: null,
        currency: "USD",
        value: 125,
        date: "2026-08-03",
      },
      "2026-08-03T12:00:00.000Z",
    );

    await expect(listManualAssets(harness.binding)).resolves.toEqual([
      {
        id: "manual:home",
        name: "新名稱",
        category: "real_estate",
        note: null,
        currency: "USD",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    await expect(listLatestManualAssetValues(harness.binding)).resolves.toEqual(
      [{ assetId: "manual:home", value: 125, date: "2026-08-03" }],
    );
    await expect(
      listManualAssetHistory(harness.binding, "manual:home"),
    ).resolves.toEqual([
      { date: "2026-08-01", value: 100 },
      { date: "2026-08-03", value: 125 },
    ]);
  });

  it("keeps the previous asset row when a later history insert in the update batch fails", async () => {
    await createManualAsset(harness.binding, {
      id: "manual:home",
      name: "舊名稱",
      category: "real_estate",
      note: "舊備註",
      currency: "TWD",
      value: 100,
      date: "2026-08-01",
      now: "2026-08-01T00:00:00.000Z",
    });
    await harness.binding
      .prepare(
        `INSERT INTO net_worth_history
           (id, date, net_worth, asset_type, source, snapshotted_at)
         VALUES
           ('manual:manual:home:2026-08-03', '2020-01-01', 1, 'other', 'manual', '2020-01-01T00:00:00.000Z')`,
      )
      .run();

    await expect(
      updateManualAsset(
        harness.binding,
        "manual:home",
        {
          name: "新名稱",
          note: null,
          value: 125,
          date: "2026-08-03",
        },
        "2026-08-03T12:00:00.000Z",
      ),
    ).rejects.toThrow();

    await expect(listManualAssets(harness.binding)).resolves.toEqual([
      {
        id: "manual:home",
        name: "舊名稱",
        category: "real_estate",
        note: "舊備註",
        currency: "TWD",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("deletes an asset and all of its valuations together", async () => {
    await createManualAsset(harness.binding, {
      id: "manual:home",
      name: "房子",
      category: "real_estate",
      note: null,
      currency: "TWD",
      value: 100,
      date: "2026-08-01",
      now: "2026-08-01T00:00:00.000Z",
    });
    await updateManualAsset(
      harness.binding,
      "manual:home",
      { value: 125, date: "2026-08-03" },
      "2026-08-03T00:00:00.000Z",
    );

    await deleteManualAsset(harness.binding, "manual:home");

    await expect(listManualAssets(harness.binding)).resolves.toEqual([]);
    await expect(listLatestManualAssetValues(harness.binding)).resolves.toEqual(
      [],
    );
    await expect(
      listManualAssetHistory(harness.binding, "manual:home"),
    ).resolves.toEqual([]);
  });
});
