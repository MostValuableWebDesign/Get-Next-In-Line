---
name: Co-Op developer API gateway
description: Tokenized public /v1/gateway API — token hashing, tenant binding, sandbox isolation, shared redemption helper.
---

# Co-Op API gateway (public /v1/gateway)

- Bearer tokens (`gwk_live_…` / `gwk_test_…`) are stored as one-way SHA-256 hashes in `gateway_api_tokens`; the plaintext is returned exactly once at create/rotate. **Why:** lookup needs a deterministic digest, and one-way beats reversible encryption when the server never needs the plaintext again.
- Tenant scope on public gateway calls comes ONLY from the token row — any `x-tenant-id` header is logged and ignored. **How to apply:** never add a tenant override parameter to /v1/gateway routes.
- Sandbox tokens hit the same routes but serve in-code fixtures (partners + `WPASS-SANDBOX-VALID/-REDEEMED/-EXPIRED`); the only live write for a sandbox call is its `gateway_api_calls` log row.
- All machine-driven perk redemptions (POS webhooks AND /v1/gateway/redemptions) go through `redeemWalletPassAsTenant` in api-server `lib/walletRedemption.ts` — participant enforcement, single-use conditional-update lock, exactly-once attribution. Any new redemption write path must reuse it.
- Public gateway routes are session-exempt via `SESSION_EXEMPT_PATTERNS` (regex list) in routes/index — the PATHS Set is test-guarded to exactly the two Twilio paths; add patterns, not paths.
- The "custom" POS vendor signs the raw body with hex HMAC-SHA256 in `X-GNIL-Signature`; the pos-webhooks test asserts the exact vendor list, update it when vendors change.
