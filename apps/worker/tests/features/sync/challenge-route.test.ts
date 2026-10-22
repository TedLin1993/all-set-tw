import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/shared";
import {
  NeedsUserActionError,
  SyncAlreadyRunningError,
} from "../../../src/features/sync/errors";
import type { Env } from "../../../src/platform/env";
import { BrowserRunCapacityError } from "../../../src/sources/browser";
import {
  FeibBrowserCapacityError,
  FeibConnectionError,
  FeibVerificationRequiredError,
} from "../../../src/sources/feib/connector";
import {
  FirstbankBrowserCapacityError,
  FirstbankConnectionError,
  FirstbankVerificationRequiredError,
} from "../../../src/sources/firstbank/connector";
import {
  FubonBrowserCapacityError,
  FubonConnectionError,
  FubonVerificationRequiredError,
} from "../../../src/sources/fubon/connector";
import {
  HncbBrowserCapacityError,
  HncbConnectionError,
  HncbVerificationRequiredError,
} from "../../../src/sources/hncb/connector";
import {
  KgibankBrowserCapacityError,
  KgibankConnectionError,
  KgibankVerificationRequiredError,
} from "../../../src/sources/kgibank/connector";
import {
  MegabankConnectionError,
  MegabankProtocolError,
  MegabankVerificationRequiredError,
} from "../../../src/sources/megabank/mobile-api";
import {
  ObankConnectionError,
  ObankProtocolError,
  ObankVerificationRequiredError,
} from "../../../src/sources/obank/mobile-api";
import {
  RakutenBrowserCapacityError,
  RakutenConnectionError,
  RakutenVerificationRequiredError,
} from "../../../src/sources/rakuten/connector";
import { SinopacBrowserCapacityError } from "../../../src/sources/sinopac/connector";
import { SinopacVerificationRequiredError } from "../../../src/sources/sinopac/verification-error";
import {
  TaishinBrowserCapacityError,
  TaishinConnectionError,
  TaishinVerificationRequiredError,
} from "../../../src/sources/taishin/connector";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));

vi.mock("../../../src/features/sync/registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/features/sync/registry")
  >()),
  prepareConnectorChallenge: mocks.prepare,
}));

import { syncRoutes } from "../../../src/features/sync/route";

type Expected = { status: number; code: string; retryAfter?: string };

async function prepareFails(connectorId: string, error: unknown) {
  mocks.prepare.mockRejectedValueOnce(error);
  const response = await syncRoutes.request(
    `/connectors/${connectorId}/captcha`,
    { method: "POST" },
    {} as Env,
  );
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  return {
    status: response.status,
    code: body.error.code,
    message: body.error.message,
    retryAfter: response.headers.get("Retry-After") ?? undefined,
  };
}

const userAction = { status: 400, code: "USER_ACTION_REQUIRED" };
const browserBusy = { status: 429, code: "BROWSER_BUSY", retryAfter: "20" };
const busy = (code: string) => ({ status: 429, code, retryAfter: "3" });
const failed = (code: string) => ({ status: 502, code });

// 前端取得驗證碼失敗時顯示訊息；代碼與 status 需與同步端點的分類一致。
const cases: Array<[ConnectorId, string, unknown, Expected]> = [
  [
    "sinopac",
    "busy",
    new SinopacBrowserCapacityError("x", 3),
    busy("SINOPAC_BROWSER_BUSY"),
  ],
  [
    "sinopac",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "sinopac",
    "verification",
    new SinopacVerificationRequiredError("x"),
    userAction,
  ],
  ["sinopac", "unknown", new Error("boom"), failed("SINOPAC_CAPTCHA_FAILED")],
  [
    "taishin",
    "busy",
    new TaishinBrowserCapacityError("x", 3),
    busy("TAISHIN_BROWSER_BUSY"),
  ],
  [
    "taishin",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "taishin",
    "connection",
    new TaishinConnectionError("x"),
    failed("TAISHIN_CONNECTION_FAILED"),
  ],
  [
    "taishin",
    "verification",
    new TaishinVerificationRequiredError("x"),
    userAction,
  ],
  [
    "taishin",
    "unknown",
    new Error("boom"),
    failed("TAISHIN_CONNECTION_FAILED"),
  ],
  [
    "hncb",
    "busy",
    new HncbBrowserCapacityError("x", 3),
    busy("HNCB_BROWSER_BUSY"),
  ],
  [
    "hncb",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "hncb",
    "connection",
    new HncbConnectionError("x"),
    failed("HNCB_CONNECTION_FAILED"),
  ],
  ["hncb", "verification", new HncbVerificationRequiredError("x"), userAction],
  ["hncb", "unknown", new Error("boom"), failed("HNCB_CAPTCHA_FAILED")],
  [
    "rakuten",
    "busy",
    new RakutenBrowserCapacityError("x", 3),
    busy("RAKUTEN_BROWSER_BUSY"),
  ],
  [
    "rakuten",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "rakuten",
    "connection",
    new RakutenConnectionError("x"),
    failed("RAKUTEN_CONNECTION_FAILED"),
  ],
  [
    "rakuten",
    "verification",
    new RakutenVerificationRequiredError("x"),
    userAction,
  ],
  ["rakuten", "unknown", new Error("boom"), failed("RAKUTEN_CAPTCHA_FAILED")],
  [
    "kgibank",
    "busy",
    new KgibankBrowserCapacityError("x", 3),
    busy("KGIBANK_BROWSER_BUSY"),
  ],
  [
    "kgibank",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "kgibank",
    "connection",
    new KgibankConnectionError("x"),
    failed("KGIBANK_CONNECTION_FAILED"),
  ],
  [
    "kgibank",
    "verification",
    new KgibankVerificationRequiredError("x"),
    userAction,
  ],
  ["kgibank", "unknown", new Error("boom"), failed("KGIBANK_CAPTCHA_FAILED")],
  ["nextbank", "unknown", new Error("boom"), failed("NEXTBANK_CAPTCHA_FAILED")],
  [
    "obank",
    "connection",
    new ObankConnectionError("x"),
    failed("OBANK_CONNECTION_FAILED"),
  ],
  [
    "obank",
    "protocol",
    new ObankProtocolError("x"),
    failed("OBANK_CONNECTION_FAILED"),
  ],
  [
    "obank",
    "verification",
    new ObankVerificationRequiredError("x"),
    userAction,
  ],
  ["obank", "unknown", new Error("boom"), failed("OBANK_CAPTCHA_FAILED")],
  [
    "firstbank",
    "busy",
    new FirstbankBrowserCapacityError("x", 3),
    busy("FIRSTBANK_BROWSER_BUSY"),
  ],
  [
    "firstbank",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "firstbank",
    "connection",
    new FirstbankConnectionError("x"),
    failed("FIRSTBANK_CONNECTION_FAILED"),
  ],
  [
    "firstbank",
    "verification",
    new FirstbankVerificationRequiredError("x"),
    userAction,
  ],
  [
    "firstbank",
    "unknown",
    new Error("boom"),
    failed("FIRSTBANK_CAPTCHA_FAILED"),
  ],
  [
    "megabank",
    "connection",
    new MegabankConnectionError(),
    failed("MEGABANK_CONNECTION_FAILED"),
  ],
  [
    "megabank",
    "protocol",
    new MegabankProtocolError(),
    failed("MEGABANK_CONNECTION_FAILED"),
  ],
  [
    "megabank",
    "verification",
    new MegabankVerificationRequiredError("x"),
    userAction,
  ],
  ["megabank", "unknown", new Error("boom"), failed("MEGABANK_CAPTCHA_FAILED")],
  [
    "fubon",
    "busy",
    new FubonBrowserCapacityError("x", 3),
    busy("FUBON_BROWSER_BUSY"),
  ],
  [
    "fubon",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "fubon",
    "connection",
    new FubonConnectionError("x"),
    failed("FUBON_CONNECTION_FAILED"),
  ],
  [
    "fubon",
    "verification",
    new FubonVerificationRequiredError("x"),
    userAction,
  ],
  ["fubon", "unknown", new Error("boom"), failed("FUBON_CAPTCHA_FAILED")],
  [
    "feib",
    "busy",
    new FeibBrowserCapacityError("x", 3),
    busy("FEIB_BROWSER_BUSY"),
  ],
  [
    "feib",
    "browser run",
    new BrowserRunCapacityError("rate_limit", 20),
    browserBusy,
  ],
  [
    "feib",
    "connection",
    new FeibConnectionError("x"),
    failed("FEIB_CONNECTION_FAILED"),
  ],
  ["feib", "verification", new FeibVerificationRequiredError("x"), userAction],
  ["feib", "unknown", new Error("boom"), failed("FEIB_CAPTCHA_FAILED")],
];

const challengeConnectors: ConnectorId[] = [
  "sinopac",
  "taishin",
  "hncb",
  "rakuten",
  "kgibank",
  "nextbank",
  "obank",
  "firstbank",
  "megabank",
  "fubon",
  "feib",
];

describe("prepare challenge route errors", () => {
  beforeEach(() => mocks.prepare.mockReset());

  it.each(cases)("%s %s", async (connectorId, _label, error, expected) => {
    const { status, code, retryAfter } = await prepareFails(connectorId, error);
    expect({ status, code, retryAfter }).toEqual(expected);
  });

  it.each(challengeConnectors)(
    "%s maps busy locks and user actions",
    async (connectorId) => {
      expect(
        await prepareFails(
          connectorId,
          new SyncAlreadyRunningError(connectorId),
        ),
      ).toMatchObject({
        status: 409,
        code: "SYNC_ALREADY_RUNNING",
        message: `${connectorCatalog[connectorId].title}已有驗證或同步作業正在進行。`,
      });
      expect(
        await prepareFails(
          connectorId,
          new NeedsUserActionError("請先儲存帳密。"),
        ),
      ).toMatchObject({ ...userAction, message: "請先儲存帳密。" });
    },
  );

  it("does not expose challenges for connectors without one", async () => {
    const response = await syncRoutes.request(
      "/connectors/esun/captcha",
      { method: "POST" },
      {} as Env,
    );
    expect(response.status).toBe(404);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
