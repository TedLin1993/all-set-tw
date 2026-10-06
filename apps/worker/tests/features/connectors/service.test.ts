import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { getConnectorSettings } from "../../../src/db";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  getConnectorSettingsView,
  updateConnectorSettings,
} from "../../../src/features/connectors/service";

const key = "synthetic-test-encryption-key";
const credentials = {
  userId: "A123456789",
  account: "synthetic-user",
  password: "synthetic-password",
};

describe("連線設定的憑證安全（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  // Zod 3 接受所有 8-4-4-4-12 十六進位裝置識別碼；升級不得拒絕既有設定。
  it("更新新光設定時保留舊版可接受的裝置識別碼與加密憑證", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    const config = {
      nationalId: credentials.userId,
      alias: credentials.account,
      password: credentials.password,
      deviceId: "00000000-0000-0000-0000-000000000001",
    };
    await updateConnectorSettings(env, "skbank", config);
    await updateConnectorSettings(env, "skbank", {});

    const stored = await getConnectorSettings(env.DB, "skbank");
    expect(await decryptJson(stored!.encrypted_config, key)).toEqual(config);
    expect(stored?.encrypted_config).not.toContain(config.password);
    expect(
      JSON.stringify(await getConnectorSettingsView(env, "skbank")),
    ).not.toContain(config.deviceId);
  });

  it("加密儲存且公開 view 不洩漏秘密，變更帳密後移除舊 session 與 cursor", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    await updateConnectorSettings(env, "sinopac", credentials);
    const encrypted = await encryptJson(
      {
        ...credentials,
        protocol: "sinopac-mobile-app-json-v1",
        sessionCookies: "synthetic-private-cookie",
        browserSessionId: "synthetic-private-challenge",
        captcha: "123456",
      },
      key,
    );
    await env.DB.prepare(
      "UPDATE connector_settings SET encrypted_config = ?, sync_cursor = 'old-cursor' WHERE connector_id = 'sinopac'",
    )
      .bind(encrypted)
      .run();
    const stored = await getConnectorSettings(env.DB, "sinopac");
    expect(stored?.encrypted_config).not.toContain(credentials.password);
    expect(stored?.encrypted_config).not.toContain("synthetic-private");
    await expect(decryptJson(encrypted, "incorrect-key")).rejects.toThrow();
    const view = await getConnectorSettingsView(env, "sinopac");
    expect(view).toMatchObject({
      configured: true,
      credentialsComplete: true,
      sessionAvailable: true,
      publicConfig: null,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /synthetic-|sessionCookies|password|captcha/,
    );

    await updateConnectorSettings(env, "sinopac", { account: "new-user" });
    const updated = await getConnectorSettings(env.DB, "sinopac");
    expect(await decryptJson(updated!.encrypted_config, key)).toEqual({
      ...credentials,
      account: "new-user",
    });
    expect(updated?.sync_cursor).toBeNull();
    expect(updated?.public_config).toBeNull();
    expect(updated?.id).toBe(stored?.id);
    expect(await getConnectorSettingsView(env, "sinopac")).toMatchObject({
      credentialsComplete: true,
      sessionAvailable: false,
    });
  });
});
