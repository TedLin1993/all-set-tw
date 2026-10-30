import { describe, expect, it } from "vitest";
import { connectorCatalog } from "@taiwan-fin-hub/shared";
import { buildCredentialConfig, selectDisplayValue } from "./credential-fields";

const fubonFields = connectorCatalog.fubon.credentialFields;
const loginMode = fubonFields[0];

describe("credential select 欄位", () => {
  it("富邦第一個憑證欄位是帶選項的 select", () => {
    expect(loginMode.key).toBe("loginMode");
    expect(loginMode.type).toBe("select");
    expect(loginMode.options?.map((o) => o.value)).toEqual([
      "general",
      "card_member",
    ]);
  });

  it("選擇的值會與其他憑證一起放進儲存 payload", () => {
    const config = buildCredentialConfig(fubonFields, {
      loginMode: "card_member",
      userId: "A123456789",
      account: "qiaoling",
      password: "fake-pass",
    });
    expect(config).toEqual({
      loginMode: "card_member",
      userId: "A123456789",
      account: "qiaoling",
      password: "fake-pass",
    });
  });

  it("未動過的 select 不進 payload，也不阻擋其他欄位", () => {
    expect(
      buildCredentialConfig(fubonFields, { password: "fake-pass" }),
    ).toEqual({ password: "fake-pass" });
  });

  it("未儲存時顯示第一個選項，已儲存且未改時顯示維持目前設定", () => {
    expect(selectDisplayValue(loginMode, undefined, false)).toBe("general");
    expect(selectDisplayValue(loginMode, undefined, true)).toBe("");
    expect(selectDisplayValue(loginMode, "card_member", true)).toBe(
      "card_member",
    );
  });
});
