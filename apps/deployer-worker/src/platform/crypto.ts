const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function utf8ToBase64(value: string) {
  return bytesToBase64(encoder.encode(value));
}

export async function sha256Hex(data: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytesToArrayBuffer(data),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function encryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptJson(value: unknown, secret: string) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value)),
  );

  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptJson<TValue>(encrypted: string, secret: string) {
  const parsed = JSON.parse(encrypted) as {
    v: number;
    alg: "AES-GCM";
    iv: string;
    ciphertext: string;
  };

  if (parsed.v !== 1 || parsed.alg !== "AES-GCM") {
    throw new Error("Unsupported encrypted token format.");
  }

  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parsed.iv) },
    key,
    base64ToBytes(parsed.ciphertext),
  );

  return JSON.parse(decoder.decode(plaintext)) as TValue;
}

export function randomToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return bytesToBase64url(value);
}

export function randomHex(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function bytesToBase64url(bytes: Uint8Array) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generateInstallKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!privateJwk.d) throw new Error("VAPID private key export failed.");
  return {
    configEncryptionKey: randomHex(32),
    vapidPublicKey: bytesToBase64url(publicRaw),
    vapidPrivateKey: privateJwk.d,
  };
}

export async function sha256Base64url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64url(new Uint8Array(digest));
}
