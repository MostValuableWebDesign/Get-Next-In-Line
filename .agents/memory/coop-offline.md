---
name: Co-op offline pass verification & sync
description: Design decisions for signed perk-pass QRs, PWA offline shell, IndexedDB queue, and idempotent offline-redemption sync.
---

# Co-op offline fallback

- **Signing**: ECDSA P-256, not Ed25519. **Why:** Ed25519 WebCrypto support is uneven across browsers; P-256 is universal. Node must sign with `dsaEncoding: 'ieee-p1363'` so raw signatures verify in browser WebCrypto without DER conversion.
- **QR format**: `GNILPASS.<b64url(JSON payload)>.<b64url(sig)>`, payload `{v, kid, c: redemptionCode, p: passCode, nbf?, exp?}`. Legacy `code|passCode` QRs stay valid online-only; offline scans of legacy codes show "not offline-verifiable" rather than failing silently.
- **Key rotation**: `kid` in payload; `GET /coop/pass-keys` serves active + retired keys; device caches keys in localStorage with 12h refresh so rotation doesn't strand devices.
- **Sync semantics**: batch endpoint is idempotent on client-generated redemption ids (unique column + onConflictDoNothing lock insert); perk validity is evaluated at device-reported `scannedAt` (clamped to [now−30d, now]), not sync time; conflicts/rejections are persisted to an audit table and replayed on retry so outcomes are stable.
- **How to apply:** any new redemption write path must keep reusing the shared classic-redemption effects helper so offline syncs feed the same metrics/ledgers as online scans.

## PWA build gotchas (pnpm monorepo)
- `vite-plugin-pwa` requires `workbox-window` as a **direct** devDependency under pnpm (strict node_modules) or the build fails resolving `virtual:pwa-register`.
- Keep `manifest: false` when the app already ships a public manifest; set `navigateFallback` to `${basePath}index.html` with a denylist for `/api/` and other artifact prefixes (path-based routing).
- Frontend IndexedDB tests: `fake-indexeddb`, fresh `new IDBFactory()` per test.
