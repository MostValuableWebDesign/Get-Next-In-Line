---
name: External POS webhook connectors
description: Conventions for the Square/Clover/Boulevard/Vagaro webhook pipeline (signatures, raw body, idempotency, simulator).
---

# External POS webhook connectors

- Webhook route `POST /api/pos/webhooks/:vendor/:token` is mounted in app.ts with `express.raw` BEFORE `express.json()` (same pattern as Stripe) — signature verification needs the exact raw body bytes. Any new signed-webhook family must follow this mount order.
- **Why:** parsing then re-stringifying JSON changes bytes and breaks HMAC verification.
- Signature schemes are body-only HMAC-SHA256: square = base64, boulevard = hex, vagaro = base64, clover = the shared secret compared verbatim in its header. Always `timingSafeEqual`.
- Idempotency lives in `pos_inbound_events` via unique `(integrationId, externalEventId)` + `onConflictDoNothing`; the endpoint returns 200 with a status (`processed|duplicate|ignored|unrecognized|invalid|error`) once authenticated — never 5xx for payload problems, so vendor retries don't loop.
- Every delivery is logged (malformed ones get a synthetic `invalid-<uuid>` external id) — nothing may be silently dropped.
- Completion effects must mirror the native checkout path in sos.ts (revenue crossover attach, resource release, lastVisitAt, profile cadence, `grantPerkPassesSafe`); if a new native checkout side effect is added, add it to `posEvents.ts` too.
- Dev simulator `POST /api/pos/simulate` signs a vendor-shaped payload with the real stored secret and runs the same `handlePosDelivery` — keep it exercising the true pipeline, not a shortcut.
- Tenant scoping: `/api/pos/` is one of the URL families in gnil-os `sos-tenant.tsx` (header getter + query-drop predicate).
