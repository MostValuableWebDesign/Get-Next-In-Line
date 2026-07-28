import { listCoopPassKeys, type CoopPassKey } from '@workspace/api-client-react';

// ---------------------------------------------------------------------------
// Offline co-op pass verification (Co-Op Offline Fallback Mode).
//
// Customer pass QR codes carry a compact server-signed payload:
//   GNILPASS.<base64url(payload JSON)>.<base64url(ECDSA P-256 signature)>
// The merchant device caches the server's public verification keys while
// online (localStorage, refreshed periodically) and verifies scanned passes
// entirely locally with Web Crypto when connectivity is gone. The key id in
// each payload selects the right cached key, so a rotated key never strands
// a device — retired keys stay in the served/cached list.
// ---------------------------------------------------------------------------

export const COOP_PASS_QR_PREFIX = 'GNILPASS.';

export type SignedPassPayload = {
  v: 1;
  kid: string;
  /** Redemption or direction-aware tracking code. */
  c: string;
  /** Customer pass instance (e.g. "C123"). */
  p: string;
  nbf?: number;
  exp?: number;
};

export function isSignedPassPayload(raw: string): boolean {
  return raw.trim().startsWith(COOP_PASS_QR_PREFIX);
}

/** Decode the payload without verifying (verification is a separate step). */
export function parseSignedPassPayload(raw: string): SignedPassPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(COOP_PASS_QR_PREFIX)) return null;
  const parts = trimmed.slice(COOP_PASS_QR_PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  try {
    const json = new TextDecoder().decode(base64urlToBytes(parts[0]));
    const payload = JSON.parse(json) as SignedPassPayload;
    if (payload.v !== 1 || typeof payload.c !== 'string' || typeof payload.p !== 'string' || typeof payload.kid !== 'string') {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Cached verification keys ────────────────────────────────────────────────

const KEYS_STORAGE_KEY = 'gnil.coop-pass-keys';
const KEYS_MAX_AGE_MS = 12 * 60 * 60 * 1000; // refresh twice a day while online

type CachedKeys = { fetchedAt: number; keys: CoopPassKey[] };

export function getCachedPassKeys(): CoopPassKey[] {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as CachedKeys).keys ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch + cache the verification keys while online. Safe to call often —
 * it only hits the network when the cache is stale (or `force`).
 */
export async function refreshPassKeys(force = false): Promise<void> {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE_KEY);
    if (!force && raw) {
      const cached = JSON.parse(raw) as CachedKeys;
      if (Date.now() - cached.fetchedAt < KEYS_MAX_AGE_MS && cached.keys.length > 0) return;
    }
  } catch {
    // fall through to refetch
  }
  try {
    const res = await listCoopPassKeys();
    const payload: CachedKeys = { fetchedAt: Date.now(), keys: res.keys };
    localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Offline or transient failure — keep whatever is cached.
  }
}

export type OfflineVerification =
  | { ok: true; payload: SignedPassPayload }
  | { ok: false; reason: string };

/**
 * Fully local verification of a scanned signed pass: signature (Web Crypto,
 * against the cached key matching the payload's key id) plus the embedded
 * validity window. Redemption-queue duplicate checks live with the queue.
 */
export async function verifyPassOffline(raw: string, now: Date = new Date()): Promise<OfflineVerification> {
  const payload = parseSignedPassPayload(raw);
  if (!payload) {
    return { ok: false, reason: 'This QR code is not an offline-verifiable pass — reconnect to redeem it.' };
  }
  const keys = getCachedPassKeys();
  if (keys.length === 0) {
    return { ok: false, reason: 'No verification keys cached on this device yet — connect once while online first.' };
  }
  const key = keys.find(k => k.keyId === payload.kid);
  if (!key) {
    return { ok: false, reason: 'This pass was signed with a key this device has not cached yet — reconnect to refresh keys.' };
  }
  const trimmed = raw.trim();
  const [encodedPayload, encodedSig] = trimmed.slice(COOP_PASS_QR_PREFIX.length).split('.');
  let valid = false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key.publicKeyJwk as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      base64urlToBytes(encodedSig) as BufferSource,
      new TextEncoder().encode(encodedPayload),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, reason: 'Signature check failed — this pass is not authentic.' };
  }
  const nowS = Math.floor(now.getTime() / 1000);
  if (payload.nbf != null && payload.nbf > nowS) {
    return { ok: false, reason: 'This perk is not active yet.' };
  }
  if (payload.exp != null && payload.exp <= nowS) {
    return { ok: false, reason: 'This perk has expired.' };
  }
  return { ok: true, payload };
}
