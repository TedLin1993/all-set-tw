import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  clearConnectorCursor: vi.fn(),
  findConnectorSettings: vi.fn(),
  saveConnectorSettings: vi.fn(),
}));

vi.mock("@taiwan-fin-hub/db", () => ({
  clearConnectorCursor: mocks.clearConnectorCursor,
}));

vi.mock("../../../src/features/connectors/repository", () => ({
  findConnectorSettings: mocks.findConnectorSettings,
  saveConnectorSettings: mocks.saveConnectorSettings,
}));

vi.mock("../../../src/platform/config", () => ({
  configEncryptionKey: () => "test-key",
}));

vi.mock("../../../src/platform/crypto", () => ({
  decryptJson: async <T>(value: string) => JSON.parse(value) as T,
  encryptJson: async (value: unknown) => JSON.stringify(value),
}));

import {
  ConnectorConfigMissingError,
  getConnectorSettingsView,
  updateConnectorSettings,
} from "../../../src/features/connectors/service";

const env = { DB: {} as D1Database } as Env;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findConnectorSettings.mockResolvedValue(null);
  mocks.saveConnectorSettings.mockResolvedValue(undefined);
  mocks.clearConnectorCursor.mockResolvedValue(undefined);
});

describe("connector settings state boundaries", () => {
  it("ignores the retired invoice detail preference", async () => {
    await updateConnectorSettings(env, "einvoice", {
      mobile: "0912345678",
      password: "password",
      fetchDetails: false,
    });

    expect(mocks.saveConnectorSettings).toHaveBeenCalledOnce();
    const saved = mocks.saveConnectorSettings.mock.calls[0]![1];
    expect(JSON.parse(saved.encryptedConfig)).toMatchObject({
      mobile: "0912345678",
      password: "password",
    });
    expect(JSON.parse(saved.encryptedConfig)).not.toHaveProperty(
      "fetchDetails",
    );
    expect(saved.publicConfig).toBeNull();
  });

  it("removes retired lookback settings while preserving credentials", async () => {
    await updateConnectorSettings(env, "esun", {
      userId: "A123456789",
      account: "user",
      password: "password",
      lookbackMonths: 6,
    });

    expect(mocks.saveConnectorSettings).toHaveBeenCalledOnce();
    const saved = mocks.saveConnectorSettings.mock.calls[0]![1];
    expect(JSON.parse(saved.encryptedConfig)).toEqual({
      userId: "A123456789",
      account: "user",
      password: "password",
    });
    expect(saved.publicConfig).toBeNull();
  });

  it("does not create a connector from a retired lookback-only payload", async () => {
    await expect(
      updateConnectorSettings(env, "esun", { lookbackMonths: 12 }),
    ).rejects.toBeInstanceOf(ConnectorConfigMissingError);
    expect(mocks.saveConnectorSettings).not.toHaveBeenCalled();
  });

  it("clears derived session state and cursor when credentials change", async () => {
    mocks.findConnectorSettings.mockResolvedValue({
      id: "esun-settings",
      connector_id: "esun",
      encrypted_config: JSON.stringify({
        userId: "A123456789",
        account: "old-user",
        password: "old-password",
        sessionCookies: "old-cookie",
        sessionExpiresAt: "2026-07-29T12:00:00.000Z",
      }),
      public_config: JSON.stringify({ lookbackMonths: 3 }),
      sync_cursor: JSON.stringify({ syncedAt: "2026-07-29T10:00:00.000Z" }),
      created_at: "2026-07-29T09:00:00.000Z",
      updated_at: "2026-07-29T09:00:00.000Z",
    });

    await updateConnectorSettings(env, "esun", { account: "new-user" });

    const saved = mocks.saveConnectorSettings.mock.calls[0]![1];
    expect(JSON.parse(saved.encryptedConfig)).toEqual({
      userId: "A123456789",
      account: "new-user",
      password: "old-password",
    });
    expect(saved.publicConfig).toBeNull();
    expect(mocks.clearConnectorCursor).toHaveBeenCalledWith(
      env.DB,
      "esun",
      expect.any(String),
    );
  });

  it("drops retired lookback values from an existing setting", async () => {
    mocks.findConnectorSettings.mockResolvedValue({
      id: "esun-settings",
      connector_id: "esun",
      encrypted_config: JSON.stringify({
        userId: "A123456789",
        account: "user",
        password: "password",
        sessionCookies: "current-cookie",
        sessionExpiresAt: "2026-07-29T12:00:00.000Z",
      }),
      public_config: JSON.stringify({ lookbackMonths: 3 }),
      sync_cursor: JSON.stringify({ syncedAt: "2026-07-29T10:00:00.000Z" }),
      created_at: "2026-07-29T09:00:00.000Z",
      updated_at: "2026-07-29T09:00:00.000Z",
    });

    await updateConnectorSettings(env, "esun", { lookbackMonths: 12 });

    const saved = mocks.saveConnectorSettings.mock.calls[0]![1];
    expect(JSON.parse(saved.encryptedConfig)).toMatchObject({
      sessionCookies: "current-cookie",
      sessionExpiresAt: "2026-07-29T12:00:00.000Z",
    });
    expect(JSON.parse(saved.encryptedConfig)).not.toHaveProperty(
      "lookbackMonths",
    );
    expect(saved.publicConfig).toBeNull();
    expect(mocks.clearConnectorCursor).not.toHaveBeenCalled();
  });

  it("reports HNCB session availability from encrypted cookies", async () => {
    mocks.findConnectorSettings.mockResolvedValue({
      id: "hncb-settings",
      connector_id: "hncb",
      encrypted_config: JSON.stringify({
        userId: "A123456789",
        account: "user",
        password: "password",
        sessionCookies: "hncb-cookie",
        sessionCreatedAt: "2026-08-19T08:00:00.000Z",
      }),
      public_config: null,
      sync_cursor: JSON.stringify({ syncedAt: "2026-08-19T08:00:00.000Z" }),
      created_at: "2026-08-19T07:00:00.000Z",
      updated_at: "2026-08-19T08:00:00.000Z",
    });

    await expect(getConnectorSettingsView(env, "hncb")).resolves.toMatchObject({
      connectorId: "hncb",
      credentialsComplete: true,
      sessionAvailable: true,
    });
  });

  it("clears HNCB session state when credentials change", async () => {
    mocks.findConnectorSettings.mockResolvedValue({
      id: "hncb-settings",
      connector_id: "hncb",
      encrypted_config: JSON.stringify({
        userId: "A123456789",
        account: "old-user",
        password: "old-password",
        sessionCookies: "old-cookie",
        sessionCreatedAt: "2026-08-19T08:00:00.000Z",
        browserSessionId: "pending-session",
      }),
      public_config: null,
      sync_cursor: JSON.stringify({ syncedAt: "2026-08-19T08:00:00.000Z" }),
      created_at: "2026-08-19T07:00:00.000Z",
      updated_at: "2026-08-19T08:00:00.000Z",
    });

    await updateConnectorSettings(env, "hncb", { account: "new-user" });

    const saved = mocks.saveConnectorSettings.mock.calls[0]![1];
    expect(JSON.parse(saved.encryptedConfig)).toEqual({
      userId: "A123456789",
      account: "new-user",
      password: "old-password",
    });
    expect(mocks.clearConnectorCursor).toHaveBeenCalledWith(
      env.DB,
      "hncb",
      expect.any(String),
    );
  });
});
