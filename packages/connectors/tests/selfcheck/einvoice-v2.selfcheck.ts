// Run with: npx tsx packages/connectors/tests/selfcheck/einvoice-v2.selfcheck.ts
// Uses only synthetic session data and a local fake fetch implementation.
import assert from "node:assert/strict";
import {
  decryptLoginData,
  encryptLoginData,
  EInvoiceV2Client,
} from "../../src/tw-einvoice-v2";
import {
  EINVOICE_SYNC_PERIODS,
  einvoiceConnector,
  parseInvoiceConfig,
} from "../../src/index";

const requests: Array<{ url: string; init: RequestInit }> = [];
const syntheticSession = {
  sid: "123456789012345678",
  token: "t".repeat(64),
  skey: "synthetic-skey",
  iv: "synthetic-iv",
  ltoken: "synthetic-ltoken",
  hkey: "synthetic-hkey",
  carrier_code: "/ABCD123456",
  liat: 1_783_947_541,
  ssme: "synthetic-signing-secret",
  appid: "synthetic-app-id",
};
const syntheticServerNow = Math.floor(Date.now() / 1000) + 123;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const requestInit = init ?? {};
  requests.push({ url, init: requestInit });

  if (url.endsWith("/mid/v1/login")) {
    const body = JSON.parse(String(requestInit.body ?? "{}")) as {
      ldata?: string;
    };
    assert.equal(typeof body.ldata, "string");
    const login = await decryptLoginData(body.ldata!);
    assert.equal(login.type, 0);
    assert.equal(login.account, "0912345678");
    assert.equal(login.password, "synthetic-password");
    assert.equal(login.carrier_code, "");
    assert.equal(login.pdid, "a:synthetic-android-id");
    const device = login.device as Record<string, unknown>;
    assert.equal(typeof login.ckey, "string");
    assert.equal((login.ckey as string).length, 8);
    assert.equal(device.os, "a");
    assert.equal(device.os_version, "15");
    assert.equal(device.pdid, "a:synthetic-android-id");
    assert.equal(device.appver, "6.800.2");
    assert.equal(device.lang, "zh");
    assert.equal(device.ccs, "tw");
    return json({
      result: 0,
      payload: await encryptLoginData({
        ...syntheticSession,
        now: syntheticServerNow,
      }),
    });
  }

  if (url.endsWith("/einvoice/carriers/query-invoices-header")) {
    const claims = readJwtClaims(requestInit);
    assert.equal(claims.comms.appid, syntheticSession.appid);
    assert.equal(claims.comms.liat, syntheticSession.liat);
    assert.equal(claims.comms.keyType, "2");
    assert.equal(claims.reqdata.action, "carrierInvChk");
    assert.equal(claims.reqdata.cardNo, syntheticSession.carrier_code);
    assert.equal(claims.reqdata.onlyWinningInv, "A");
    return json({
      result: 0,
      payload: {
        data: [
          {
            invNum: "AA-12345678",
            invDate: {
              year: "115",
              month: "7",
              date: "1",
              time: String(Date.parse("2026-07-01T04:34:56.000Z")),
            },
            amount: "120",
            sellerName: "測試商店",
          },
        ],
      },
    });
  }

  if (url.endsWith("/einvoice/carriers/query-invoices-details")) {
    const claims = readJwtClaims(requestInit);
    assert.equal(claims.reqdata.action, "carrierInvDetail");
    assert.equal(claims.reqdata.invNum, "AA-12345678");
    assert.equal(claims.reqdata.invDate, "2026/07/01");
    return json({
      result: 0,
      payload: {
        details: [
          {
            rowNum: "1",
            itemName: "測試品項",
            quantity: "2",
            unitPrice: "60",
            amount: "120",
          },
        ],
      },
    });
  }

  throw new Error(`unexpected fake URL: ${url}`);
};

async function main() {
  const client = new EInvoiceV2Client({
    middleHost: "https://fake-middle.test",
    bigHost: "https://fake-big.test",
    androidId: "synthetic-android-id",
    fetchImpl: fakeFetch,
  });

  const loginStartedAt = Date.now() / 1000;
  const session = await client.login({
    mobile: "0912345678",
    password: "synthetic-password",
    androidId: "synthetic-android-id",
  });
  const loginFinishedAt = Date.now() / 1000;
  assert.equal(session.sid, syntheticSession.sid);
  assert.equal(session.loginAppId, syntheticSession.appid);
  assert.equal(session.loginSsMe, syntheticSession.ssme);
  assert.equal(session.carrierCode, syntheticSession.carrier_code);
  const serverTimeOffset = session.serverTimeOffset ?? 0;
  assert.ok(
    serverTimeOffset >= Math.trunc(syntheticServerNow - loginFinishedAt) &&
      serverTimeOffset <= Math.trunc(syntheticServerNow - loginStartedAt),
  );

  await client.queryCarrierInvoices(session, "2026-07-01", "2026-07-31");
  await client.queryCarrierInvoiceDetail(session, "AA-12345678", "2026/07/01");
  assert.equal(requests.length, 3);

  const loginHeaders = new Headers(requests[0].init.headers);
  assert.equal(
    loginHeaders.get("Content-Type"),
    "application/json; charset=utf-8",
  );
  assert.equal(loginHeaders.get("appver"), "6.800.2");
  const invoiceHeaders = new Headers(requests[1].init.headers);
  assert.equal(
    invoiceHeaders.get("Content-Type"),
    "application/x-www-form-urlencoded; charset=utf-8",
  );
  assert.equal(
    new URL(requests[2].url).pathname,
    "/einvoice/carriers/query-invoices-details",
  );

  (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch;
  const requestsBeforeSync = requests.length;
  const connectorConfig = parseInvoiceConfig({
    protocol: "v2",
    mobile: "0912345678",
    password: "synthetic-password",
    androidId: "synthetic-android-id",
    fetchDetails: true,
  });
  const syncResult = await einvoiceConnector.sync(connectorConfig);
  assert.equal(syncResult.records.length, 1);
  assert.equal(syncResult.invoiceLineItems?.length, 1);
  assert.equal(connectorConfig.sid, syntheticSession.sid);
  assert.equal(connectorConfig.loginAppId, syntheticSession.appid);
  assert.equal(typeof connectorConfig.loginClientCode, "string");
  assert.equal(connectorConfig.loginClientCode?.length, 8);
  assert.equal(
    requests
      .slice(requestsBeforeSync)
      .filter((request) =>
        request.url.endsWith("/einvoice/carriers/query-invoices-header"),
      ).length,
    EINVOICE_SYNC_PERIODS,
  );
  console.log("einvoice-v2.selfcheck: ok");
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function readJwtClaims(init: RequestInit) {
  const form = new URLSearchParams(String(init.body ?? ""));
  const token = form.get("einvoiceJwt");
  assert.ok(token);
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(header, { alg: "HS256", typ: "JWT", ver: "1.0" });
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
    comms: Record<string, unknown>;
    reqdata: Record<string, unknown>;
  };
}

main();
