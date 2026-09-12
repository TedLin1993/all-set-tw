import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../testing/d1";
import {
  getConnectorSettings,
  upsertConnectorSettings,
  updateConnectorPublicConfig,
  updateConnectorCursor,
  clearConnectorCursor,
} from "../src/index";

const now = "2026-09-12T00:00:00.000Z";
const later = "2026-09-12T01:00:00.000Z";
const input = {
  id: "settings:one",
  connectorId: "test",
  encryptedConfig: "synthetic-encrypted",
  publicConfig: null,
  now,
};

describe("connector settings repository", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await harness.binding.batch([
      harness.binding.prepare("DROP TRIGGER IF EXISTS fail_settings"),
      harness.binding.prepare("DELETE FROM connector_settings"),
    ]);
  });

  it("upserts by connector while retaining the original identity, creation time and cursor", async () => {
    const db = harness.binding;
    await expect(getConnectorSettings(db, "test")).resolves.toBeNull();
    await upsertConnectorSettings(db, input);
    await expect(getConnectorSettings(db, "test")).resolves.toMatchObject({
      public_config: null,
      sync_cursor: null,
    });
    await updateConnectorCursor(db, "test", "synthetic-cursor", now);
    await upsertConnectorSettings(db, {
      ...input,
      id: "replacement-id",
      encryptedConfig: "replacement-encrypted",
      publicConfig: '{"visible":true}',
      now: later,
    });
    await expect(getConnectorSettings(db, "test")).resolves.toEqual({
      id: input.id,
      connector_id: "test",
      encrypted_config: "replacement-encrypted",
      public_config: '{"visible":true}',
      sync_cursor: "synthetic-cursor",
      created_at: now,
      updated_at: later,
    });
  });

  it("updates public configuration and clears cursors without replacing credentials or other connectors", async () => {
    const db = harness.binding;
    await upsertConnectorSettings(db, input);
    await upsertConnectorSettings(db, {
      ...input,
      id: "settings:other",
      connectorId: "other",
    });
    await updateConnectorCursor(db, "test", "cursor", now);
    await updateConnectorPublicConfig(db, "test", "{}", later);
    await expect(getConnectorSettings(db, "test")).resolves.toMatchObject({
      encrypted_config: input.encryptedConfig,
      public_config: "{}",
      sync_cursor: "cursor",
    });
    await clearConnectorCursor(db, "test", later);
    await expect(getConnectorSettings(db, "test")).resolves.toMatchObject({
      encrypted_config: input.encryptedConfig,
      public_config: "{}",
      sync_cursor: null,
      updated_at: later,
    });
    await expect(getConnectorSettings(db, "other")).resolves.toMatchObject({
      public_config: null,
      sync_cursor: null,
      updated_at: now,
    });
  });

  it("removes bound settings and cursor values from database errors before callers can log or persist them", async () => {
    const db = harness.binding;
    await upsertConnectorSettings(db, input);
    await db
      .prepare(
        "CREATE TRIGGER fail_settings BEFORE UPDATE ON connector_settings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      )
      .run();
    const writes = [
      () =>
        upsertConnectorSettings(db, {
          ...input,
          encryptedConfig: "secret-bound-config",
        }),
      () =>
        updateConnectorPublicConfig(db, "test", "secret-bound-public", later),
      () => updateConnectorCursor(db, "test", "secret-bound-cursor", later),
      () => clearConnectorCursor(db, "test", later),
    ];
    for (const write of writes) {
      const error = await write().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Database query failed.");
      expect((error as Error).cause).toBeUndefined();
      expect(String((error as Error).stack)).not.toContain("secret-bound");
    }
    await expect(getConnectorSettings(db, "test")).resolves.toMatchObject({
      encrypted_config: input.encryptedConfig,
      sync_cursor: null,
      updated_at: now,
    });
  });
});
