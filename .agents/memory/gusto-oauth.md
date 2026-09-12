---
name: Gusto OAuth lifecycle
description: Security and consistency rules for tenant-scoped Gusto authorization and token refresh.
---

Gusto authorization must use server-persisted, expiring, one-time state bound to the initiating session and tenant. A legacy partner sandbox connection is never a valid Gusto workforce connection.

**Why:** Gusto refresh tokens are invalid after one use. Concurrent refresh attempts with the same token can make a successful rotation appear failed and force unnecessary reauthorization.

**How to apply:** Serialize refresh operations per tenant/provider, reload after locking, and atomically persist both rotated tokens. Stage reconnect attempts without changing a usable connection; replace active credentials/status only after company-scoped introspection succeeds.