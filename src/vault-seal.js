/**
 * Same envelope as the Metina desk. The POST body carries ciphertext.
 * The server unwraps it with the key from GET /api/web/vault-pub.
 */
import { webcrypto } from "node:crypto";

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
const webCrypto = globalThis.crypto || webcrypto;

function bytesToB64(buf) {
  return Buffer.from(buf).toString("base64url");
}

function b64ToBytes(s) {
  return new Uint8Array(Buffer.from(String(s || ""), "base64url"));
}

async function aesFromShared(shared, usages) {
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("metina-vault-seal"),
      info: new TextEncoder().encode("metina-vault-seal-v1"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

export async function sealVaultForServer(vault, pubB64) {
  const pubBytes = b64ToBytes(pubB64);
  if (pubBytes.length !== 65 || pubBytes[0] !== 4) {
    throw new Error("Could not protect the wallet key");
  }
  const serverPub = await subtle.importKey(
    "raw",
    pubBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const eph = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const shared = await subtle.deriveBits(
    { name: "ECDH", public: serverPub },
    eph.privateKey,
    256,
  );
  const epk = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const aes = await aesFromShared(shared, ["encrypt"]);
  const plain = new TextEncoder().encode(JSON.stringify({
    evmKey: String(vault?.evmKey || ""),
    solanaKey: String(vault?.solanaKey || ""),
  }));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aes, plain));
  return {
    v: 1,
    epk: bytesToB64(epk),
    iv: bytesToB64(iv),
    ct: bytesToB64(ct),
  };
}
