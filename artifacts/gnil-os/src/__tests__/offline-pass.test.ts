import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  COOP_PASS_QR_PREFIX,
  isSignedPassPayload,
  parseSignedPassPayload,
  verifyPassOffline,
  getCachedPassKeys,
} from '@/lib/offline-pass';

// Local ECDSA P-256 signing helper mirroring the server's payload format so
// verification can be exercised without a network.
const subtle = webcrypto.subtle;

function toB64url(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeSignedPass(payload: Record<string, unknown>) {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const encoded = toB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(encoded)),
  );
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return {
    qr: `${COOP_PASS_QR_PREFIX}${encoded}.${toB64url(sig)}`,
    publicKeyJwk: { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! },
  };
}

function cacheKeys(keys: Array<{ keyId: string; publicKeyJwk: unknown; status?: string }>) {
  localStorage.setItem(
    'gnil.coop-pass-keys',
    JSON.stringify({
      fetchedAt: Date.now(),
      keys: keys.map(k => ({ keyId: k.keyId, status: k.status ?? 'active', publicKeyJwk: k.publicKeyJwk, createdAt: new Date().toISOString() })),
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no Web Crypto subtle — bridge to Node's implementation.
  if (!globalThis.crypto?.subtle) {
    vi.stubGlobal('crypto', webcrypto);
  } else if (!window.crypto.subtle) {
    Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  }
});

describe('signed pass payload parsing', () => {
  it('detects and parses the GNILPASS format', async () => {
    const { qr } = await makeSignedPass({ v: 1, kid: 'k1', c: 'COOP-ABC', p: 'C7' });
    expect(isSignedPassPayload(qr)).toBe(true);
    expect(isSignedPassPayload('COOP-ABC|C7')).toBe(false);
    expect(isSignedPassPayload('WPASS-xyz')).toBe(false);
    const payload = parseSignedPassPayload(qr);
    expect(payload).toEqual({ v: 1, kid: 'k1', c: 'COOP-ABC', p: 'C7' });
  });

  it('rejects malformed payloads', () => {
    expect(parseSignedPassPayload('GNILPASS.not-base64')).toBeNull();
    expect(parseSignedPassPayload(`${COOP_PASS_QR_PREFIX}${btoa('{"v":2}')}.sig`)).toBeNull();
  });
});

describe('verifyPassOffline', () => {
  it('verifies a valid signature against the cached key with matching kid', async () => {
    const { qr, publicKeyJwk } = await makeSignedPass({ v: 1, kid: 'kA', c: 'COOP-1', p: 'C1' });
    cacheKeys([{ keyId: 'kA', publicKeyJwk }]);
    const res = await verifyPassOffline(qr);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload.c).toBe('COOP-1');
  });

  it('fails when no keys are cached, and when the kid is unknown (rotation gap)', async () => {
    const { qr, publicKeyJwk } = await makeSignedPass({ v: 1, kid: 'kNew', c: 'COOP-1', p: 'C1' });
    const none = await verifyPassOffline(qr);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toMatch(/no verification keys/i);

    cacheKeys([{ keyId: 'kOld', publicKeyJwk }]);
    const wrongKid = await verifyPassOffline(qr);
    expect(wrongKid.ok).toBe(false);
    if (!wrongKid.ok) expect(wrongKid.reason).toMatch(/not cached/i);
  });

  it('verifies with a retired key after rotation as long as it stays cached', async () => {
    const { qr, publicKeyJwk } = await makeSignedPass({ v: 1, kid: 'kRetired', c: 'COOP-1', p: 'C1' });
    const other = await makeSignedPass({ v: 1, kid: 'kActive', c: 'X', p: 'Y' });
    cacheKeys([
      { keyId: 'kRetired', publicKeyJwk, status: 'retired' },
      { keyId: 'kActive', publicKeyJwk: other.publicKeyJwk, status: 'active' },
    ]);
    const res = await verifyPassOffline(qr);
    expect(res.ok).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const { qr, publicKeyJwk } = await makeSignedPass({ v: 1, kid: 'kA', c: 'COOP-1', p: 'C1' });
    cacheKeys([{ keyId: 'kA', publicKeyJwk }]);
    const [encoded, sig] = qr.slice(COOP_PASS_QR_PREFIX.length).split('.');
    expect(encoded).toBeTruthy();
    const forgedPayload = toB64url(new TextEncoder().encode(JSON.stringify({ v: 1, kid: 'kA', c: 'COOP-1', p: 'C999' })));
    const res = await verifyPassOffline(`${COOP_PASS_QR_PREFIX}${forgedPayload}.${sig}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not authentic/i);
  });

  it('enforces the embedded validity window', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const expired = await makeSignedPass({ v: 1, kid: 'kE', c: 'COOP-1', p: 'C1', exp: nowS - 60 });
    cacheKeys([{ keyId: 'kE', publicKeyJwk: expired.publicKeyJwk }]);
    const resExpired = await verifyPassOffline(expired.qr);
    expect(resExpired.ok).toBe(false);
    if (!resExpired.ok) expect(resExpired.reason).toMatch(/expired/i);

    const future = await makeSignedPass({ v: 1, kid: 'kF', c: 'COOP-1', p: 'C1', nbf: nowS + 3600 });
    cacheKeys([{ keyId: 'kF', publicKeyJwk: future.publicKeyJwk }]);
    const resFuture = await verifyPassOffline(future.qr);
    expect(resFuture.ok).toBe(false);
    if (!resFuture.ok) expect(resFuture.reason).toMatch(/not active yet/i);
  });
});

describe('key cache', () => {
  it('returns [] on empty or corrupt cache', () => {
    expect(getCachedPassKeys()).toEqual([]);
    localStorage.setItem('gnil.coop-pass-keys', '{corrupt');
    expect(getCachedPassKeys()).toEqual([]);
  });
});
