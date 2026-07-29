// Run with: npx tsx packages/connectors/tests/selfcheck/einvoice.selfcheck.ts
// Exercises the private official App endpoint contract without sending credentials.
import assert from "node:assert/strict";
import forge from "node-forge";
import {
  EInvoiceClient,
  EInvoiceProtocolUnavailableError,
  RSA_PUBLIC_KEY,
} from "../../src/tw-einvoice-api";

const OUTDATED_PROTOCOL_VERSION = "6.800.2";
const REQUIRED_PROTOCOL_VERSION = "7.9000.40";
const requests: Array<{ url: string; init: RequestInit }> = [];

(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
  url: string,
  init: RequestInit,
) => {
  requests.push({ url, init });

  if (url.endsWith("User/Login")) {
    const requestHeaders = new Headers(init.headers);
    if (requestHeaders.get("ApiKey") === "protocol-unavailable") {
      return json({
        Result: null,
        ReturnCode: 6603,
        Message: "目前系統繁忙，請稍後再試。",
      });
    }
    // Simulate the service's forced-upgrade response whenever the client is not
    // using the protocol version advertised by the service.
    if (requestHeaders.get("AppVersion") !== REQUIRED_PROTOCOL_VERSION) {
      return json({
        Result: null,
        ReturnCode: "6608",
        Message: "請立即更新。",
        Info: JSON.stringify({ VersionNumber: REQUIRED_PROTOCOL_VERSION }),
      });
    }

    return encryptedJson({
      Result: {
        User: {
          Mobile: "0912345678",
          UserToken: "test-user-token",
          MobileBarcode: "/ABCD123",
        },
      },
    });
  }

  return json({ result: [] }, "mixed");
}) as typeof fetch;

async function main() {
  const client = new EInvoiceClient({ appVersion: OUTDATED_PROTOCOL_VERSION });
  await client.login({ mobile: "0912345678", password: "test-password" });

  assert.equal(client.currentUser?.mobile, "0912345678");
  assert.equal(client.currentUser?.userToken, "test-user-token");
  assert.equal(client.currentUser?.mobileBarcode, "/ABCD123");

  await client.checkCarrierInvoices({
    carrierId: "/ABCD123",
    carrierType: "3J0002",
    cardEncrypt: "test-password",
    startDate: "2026/07/01",
    endDate: "2026/07/31",
  });

  const outdatedLoginHeaders = new Headers(requests[0]?.init.headers);
  assert.equal(
    outdatedLoginHeaders.get("AppVersion"),
    OUTDATED_PROTOCOL_VERSION,
  );
  assert.equal(outdatedLoginHeaders.get("encrypt"), "single");

  const loginHeaders = new Headers(requests[1]?.init.headers);
  assert.equal(loginHeaders.get("AppVersion"), REQUIRED_PROTOCOL_VERSION);
  assert.equal(loginHeaders.get("OS"), "Android");
  assert.equal(loginHeaders.get("encrypt"), "single");
  assert.ok(loginHeaders.get("ApiKey"));

  const invoiceHeaders = new Headers(requests[2]?.init.headers);
  assert.equal(invoiceHeaders.get("encrypt"), "mixed");
  assert.equal(invoiceHeaders.get("Token"), "test-user-token");
  assert.equal(invoiceHeaders.get("CarrierCode"), "/ABCD123");

  assert.match(requests[0]?.url ?? "", /UIAPAPP\/api\/User\/Login$/);
  assert.match(requests[1]?.url ?? "", /UIAPAPP\/api\/User\/Login$/);
  assert.match(requests[2]?.url ?? "", /UIAPAPP\/api\/Invoice\/ChkCarrierInv$/);

  const protocolClient = new EInvoiceClient({ apiKey: "protocol-unavailable" });
  await assert.rejects(
    () =>
      protocolClient.login({ mobile: "0912345678", password: "test-password" }),
    (error: unknown) =>
      error instanceof EInvoiceProtocolUnavailableError &&
      /代碼 6603/.test(error.message) &&
      /不是帳號密碼錯誤/.test(error.message),
  );
  console.log("einvoice.selfcheck: ok");
}

function json(body: unknown, encrypt = "single") {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", encrypt },
  });
}

function encryptedJson(body: unknown) {
  const keyText = forge.util.encode64(
    forge.md.sha256
      .create()
      .update(RSA_PUBLIC_KEY.slice(0, 16), "utf8")
      .digest()
      .getBytes(),
  );
  const key = forge.md.sha256
    .create()
    .update(keyText, "utf8")
    .digest()
    .getBytes();
  const iv = forge.md.md5.create().update(keyText, "utf8").digest().getBytes();
  const cipher = forge.cipher.createCipher("AES-CBC", key);
  cipher.start({ iv });
  cipher.update(forge.util.createBuffer(JSON.stringify(body), "utf8"));
  assert.equal(cipher.finish(), true);
  return new Response(forge.util.encode64(cipher.output.getBytes()), {
    status: 200,
    headers: { "Content-Type": "application/json", encrypt: "single" },
  });
}

main();
