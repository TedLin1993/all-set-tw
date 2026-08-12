import { describe, expect, it } from "vitest";
import {
  parsePublicConnectorConfig,
  restoreConfiguredPublicFields,
  sensitiveConnectorConfig,
  serializePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../../src/features/sync/connector-state";

describe("connector state boundaries", () => {
  it("keeps retired public preferences out of encrypted config", () => {
    expect(
      sensitiveConnectorConfig("einvoice", {
        mobile: "0912345678",
        password: "secret",
        fetchDetails: false,
      }),
    ).toEqual({ mobile: "0912345678", password: "secret" });
    expect(
      serializePublicConnectorConfig("einvoice", {
        mobile: "0912345678",
        fetchDetails: false,
      }),
    ).toBeNull();
  });

  it("does not persist retired invoice preferences", () => {
    expect(
      sensitiveConnectorConfig(
        "einvoice",
        restoreConfiguredPublicFields(
          "einvoice",
          { fetchDetails: true, sid: "refreshed-session" },
          { fetchDetails: false },
        ),
      ),
    ).toEqual({ sid: "refreshed-session" });
  });

  it("filters retired public fields before parsing runtime config", () => {
    expect(
      parsePublicConnectorConfig(
        "esun",
        JSON.stringify({ lookbackMonths: 12 }),
      ),
    ).toEqual({});
    expect(
      parsePublicConnectorConfig(
        "einvoice",
        JSON.stringify({ periodsBack: 6, fetchDetails: false }),
      ),
    ).toEqual({});
  });

  it("removes reusable browser sessions from bank cursors", () => {
    expect(
      splitConnectorCursorState(
        "esun",
        JSON.stringify({
          sessionCookies: "sensitive-cookie",
          sessionExpiresAt: "2026-07-29T12:00:00.000Z",
          syncedAt: "2026-07-29T11:00:00.000Z",
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({ syncedAt: "2026-07-29T11:00:00.000Z" }),
      secretState: {
        sessionCookies: "sensitive-cookie",
        sessionExpiresAt: "2026-07-29T12:00:00.000Z",
      },
    });
  });

  it("keeps TDCC trade watermarks while encrypting device session state", () => {
    expect(
      splitConnectorCursorState(
        "tdcc",
        JSON.stringify({
          deviceId: "device-id",
          devType: "Android:14",
          devModel: "SM-G991B",
          session: { tokenId: "token", richUrl: null },
          tradeCursors: { account: { newest: "trade-1" } },
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({
        tradeCursors: { account: { newest: "trade-1" } },
      }),
      secretState: {
        deviceId: "device-id",
        devType: "Android:14",
        devModel: "SM-G991B",
        session: { tokenId: "token", richUrl: null },
      },
    });
  });
});
