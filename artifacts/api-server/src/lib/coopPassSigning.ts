import { createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "crypto";
import { db, coopSigningKeysTable, type CoopSigningKey } from "@workspace/db";
import { asc, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-op pass signing — offline-verifiable customer pass QR payloads.
//
// Customer co-op pass QR codes carry a compact server-signed payload instead
// of a bare `<code>|<passCode>` string, so a merchant device that cached the
// public verification key can verify a scanned pass with Web Crypto while
// fully offline. ECDSA P-256 (SHA-256, IEEE P1363 signatures) is used because
// it is the curve with universal browser Web Crypto support (Ed25519 is still
// patchy in the field).
//
// QR format:  GNILPASS.<base64url(payload JSON)>.<base64url(signature)>
// Payload:    { v: 1, kid, c: <redemption/tracking code>, p: <passCode>,
//               nbf?: <epoch s>, exp?: <epoch s> }
//
// The private key lives only in the coop_signing_keys table and is never
// exposed by any API. Rotation retires the active key (it keeps verifying
// already-issued passes) and generates a fresh signing key with a new kid.
// ---------------------------------------------------------------------------

export const COOP_PASS_QR_PREFIX = "GNILPASS.";

export type CoopPassPayload = {
  v: 1;
  kid: string;
  /** Redemption or direction-aware tracking code. */
  c: string;
  /** Customer pass instance (e.g. "C123"). */
  p: string;
  /** Validity window start (epoch seconds), when the perk has one. */
  nbf?: number;
  /** Validity window end (epoch seconds), when the perk has one. */
  exp?: number;
};

const b64url = (buf: Buffer) => buf.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

function signingParams(key: KeyObject) {
  return { key, dsaEncoding: "ieee-p1363" as const };
}

/** Fetch the active signing key, generating one on first use. */
export async function ensureActiveCoopSigningKey(): Promise<CoopSigningKey> {
  const [existing] = await db
    .select()
    .from(coopSigningKeysTable)
    .where(eq(coopSigningKeysTable.status, "active"))
    .orderBy(asc(coopSigningKeysTable.id))
    .limit(1);
  if (existing) return existing;

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyId = `k${randomBytes(6).toString("hex")}`;
  await db
    .insert(coopSigningKeysTable)
    .values({
      keyId,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      status: "active",
    })
    .onConflictDoNothing();
  // Re-select (oldest active wins) so a startup race can't split signing
  // between two keys.
  const [row] = await db
    .select()
    .from(coopSigningKeysTable)
    .where(eq(coopSigningKeysTable.status, "active"))
    .orderBy(asc(coopSigningKeysTable.id))
    .limit(1);
  if (!row) throw new Error("Failed to provision a co-op signing key");
  return row;
}

/**
 * Rotate the signing key: retire every active key (they keep verifying
 * already-issued passes) and generate a fresh active key with a new kid.
 */
export async function rotateCoopSigningKey(): Promise<CoopSigningKey> {
  const active = await db
    .select({ id: coopSigningKeysTable.id })
    .from(coopSigningKeysTable)
    .where(eq(coopSigningKeysTable.status, "active"));
  if (active.length > 0) {
    await db
      .update(coopSigningKeysTable)
      .set({ status: "retired", retiredAt: new Date() })
      .where(inArray(coopSigningKeysTable.id, active.map((k) => k.id)));
  }
  return ensureActiveCoopSigningKey();
}

/** All keys a merchant device may need to verify with: active + retired. */
export async function listCoopVerificationKeys(): Promise<CoopSigningKey[]> {
  return db.select().from(coopSigningKeysTable).orderBy(asc(coopSigningKeysTable.id));
}

/** Public key as a JWK — the shape Web Crypto's importKey("jwk") consumes. */
export function publicKeyJwk(publicKeyPem: string): { kty: string; crv: string; x: string; y: string } {
  const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" });
  return { kty: String(jwk.kty), crv: String(jwk.crv), x: String(jwk.x), y: String(jwk.y) };
}

/** Sign a pass payload into the compact QR string. */
export async function signCoopPassPayload(input: {
  code: string;
  passCode: string;
  notBefore?: Date | null;
  expiresAt?: Date | null;
}): Promise<string> {
  const key = await ensureActiveCoopSigningKey();
  const payload: CoopPassPayload = {
    v: 1,
    kid: key.keyId,
    c: input.code,
    p: input.passCode,
    ...(input.notBefore ? { nbf: Math.floor(input.notBefore.getTime() / 1000) } : {}),
    ...(input.expiresAt ? { exp: Math.floor(input.expiresAt.getTime() / 1000) } : {}),
  };
  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = cryptoSign(
    "sha256",
    Buffer.from(encoded, "utf8"),
    signingParams(createPrivateKey(key.privateKeyPem))
  );
  return `${COOP_PASS_QR_PREFIX}${encoded}.${b64url(signature)}`;
}

export function isSignedCoopPassPayload(raw: string): boolean {
  return raw.trim().startsWith(COOP_PASS_QR_PREFIX);
}

/** Parse a signed QR string without verifying (server re-validates via DB). */
export function parseCoopPassPayload(raw: string): CoopPassPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(COOP_PASS_QR_PREFIX)) return null;
  const parts = trimmed.slice(COOP_PASS_QR_PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[0]).toString("utf8")) as CoopPassPayload;
    if (payload.v !== 1 || typeof payload.c !== "string" || typeof payload.p !== "string") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Full server-side verification (used by tests and defense-in-depth). */
export function verifyCoopPassSignature(raw: string, publicKeyPem: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(COOP_PASS_QR_PREFIX)) return false;
  const parts = trimmed.slice(COOP_PASS_QR_PREFIX.length).split(".");
  if (parts.length !== 2) return false;
  try {
    return cryptoVerify(
      "sha256",
      Buffer.from(parts[0], "utf8"),
      signingParams(createPublicKey(publicKeyPem)),
      fromB64url(parts[1])
    );
  } catch {
    return false;
  }
}
