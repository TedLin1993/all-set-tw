import { describe, expect, it } from "vitest";
import {
  serializePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../../src/features/sync/connector-state";

describe("connector state boundaries", () => {
  it("keeps securities certificates, cookies and handoff references out of public config and cursor", () => {
    const state = {
      userId: "A000000000",
      password: "synthetic-password",
      webState: {
        newweb: {
          cookies: [{ name: "ASP.NET_SessionId", value: "synthetic-cookie" }],
          localStorage: { TWCA123: "synthetic-certificate" },
        },
      },
      browserSessionId: "synthetic-browser",
      browserSessionExpiresAt: "2027-01-01T00:00:00.000Z",
      loginPlatform: "newweb",
    };
    expect(serializePublicConnectorConfig("sinotrade", state)).toBeNull();
    expect(
      splitConnectorCursorState(
        "sinotrade",
        JSON.stringify({ ...state, syncedAt: "fixture-date" }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({ syncedAt: "fixture-date" }),
      secretState: state,
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

  it("keeps Mega Bank CAPTCHA sessions out of the cursor", () => {
    expect(
      splitConnectorCursorState(
        "megabank",
        JSON.stringify({
          pendingSession: "synthetic-token",
          pendingSessionExpiresAt: "2026-09-25T08:02:00.000Z",
          captcha: "12345",
          otp: "654321",
          deviceCode: "synthetic-device-code",
          deviceUKey: "synthetic-device-key",
          deviceSeed: "synthetic-device-seed",
          syncedAt: "2026-09-25T08:01:00.000Z",
        }),
      ),
    ).toEqual({
      safeCursor: JSON.stringify({ syncedAt: "2026-09-25T08:01:00.000Z" }),
      secretState: {
        pendingSession: "synthetic-token",
        pendingSessionExpiresAt: "2026-09-25T08:02:00.000Z",
        captcha: "12345",
        otp: "654321",
        deviceCode: "synthetic-device-code",
        deviceUKey: "synthetic-device-key",
        deviceSeed: "synthetic-device-seed",
      },
    });
    expect(
      serializePublicConnectorConfig("megabank", {
        pendingSession: "synthetic-token",
        deviceCode: "synthetic-device-code",
        deviceUKey: "synthetic-device-key",
        deviceSeed: "synthetic-device-seed",
      }),
    ).toBeNull();
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
