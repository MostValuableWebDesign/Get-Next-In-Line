import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * AES-256-GCM encryption for sensitive safety-incident text at rest — the
 * same approach used for partner credential tokens (see partnerCrypto.ts),
 * with a distinct domain-separation label so the two key spaces never mix.
 * Values are stored as `v1:<iv b64>:<authTag b64>:<ciphertext b64>` and only
 * decrypted server-side when serializing for an authorized tenant.
 */
const KEY_LABEL = "gnil:safety-incidents:v1";

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET ?? "dev-fallback-secret-change-me";
  return createHash("sha256").update(`${KEY_LABEL}:${secret}`).digest();
}

export function encryptIncidentText(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptIncidentText(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Unrecognized encrypted incident text format");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** True when the stored value looks like our encryption envelope. */
export function isEncryptedIncidentText(stored: string): boolean {
  return stored.startsWith("v1:") && stored.split(":").length === 4;
}
