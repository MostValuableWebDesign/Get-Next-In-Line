import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { deriveEncryptionKey } from "./cryptoSecret";

/**
 * AES-256-GCM encryption for partner credential tokens at rest.
 *
 * Key derivation: SHA-256 over SESSION_SECRET with a domain-separation label.
 * Tokens are stored as `v1:<iv b64>:<authTag b64>:<ciphertext b64>` and are
 * only ever decrypted server-side — no API response may include a decrypted
 * (or encrypted) token.
 */
const KEY_LABEL = "gnil:partner-credentials:v1";

// Production fail-fast: throws when SESSION_SECRET is missing (see
// cryptoSecret.ts) — partner credential encryption never silently uses the
// hardcoded dev fallback in production.
function encryptionKey(): Buffer {
  return deriveEncryptionKey(KEY_LABEL);
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptToken(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Unrecognized encrypted token format");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
