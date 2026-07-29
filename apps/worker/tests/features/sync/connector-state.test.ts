import { describe, expect, it } from "vitest";
import {
  restoreConfiguredPublicFields,
  sensitiveConnectorConfig,
  serializePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../../src/features/sync/connector-state";

describe("connector state boundaries", () => {
  it("keeps public preferences out of encrypted config", () => {
    expect(
      sensitiveConnectorConfig("esun", {
        userId: "A123456789",
        password: "secret",
        lookbackMonths: 6,
      }),
    ).toEqual({ userId: "A123456789", password: "secret" });
    expect(
      serializePublicConnectorConfig("esun", {
        userId: "A123456789",
        lookbackMonths: 12,
      }),
    ).toBe(JSON.stringify({ lookbackMonths: 12 }));
  });

  it("does not persist one-time sync overrides as public preferences", () => {
    expect(
      restoreConfiguredPublicFields(
        "einvoice",
        { periodsBack: 6, fetchDetails: true, sid: "refreshed-session" },
        { periodsBack: 6, fetchDetails: false },
      ),
    ).toEqual({
      periodsBack: 6,
      fetchDetails: false,
      sid: "refreshed-session",
    });
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
