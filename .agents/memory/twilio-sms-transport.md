---
name: Twilio SMS transport
description: How real SMS sending works now that the Twilio connector withholds raw credentials
---

# Twilio SMS transport

The Replit Twilio connector (new-style `conn_twilio_*` connection) returns **empty settings** — no account SID, auth token, or phone number. The legacy `/api/v2/connection?include_secrets=true` fetch returns 0 items for it.

**Rule:** all Twilio API calls that lack env creds must go through the connectors proxy (`@replit/connectors-sdk` → `ReplitConnectors.proxy("twilio", path)`); account SID is discovered via `GET /2010-04-01/Accounts.json`. sms.ts implements this as a second transport with a single-flight, non-regressing 60s cache.

**Why:** raw credentials are injected server-side by the proxy and never exposed; any code that expects `settings.account_sid` silently falls back to simulated mode.

**How to apply:**
- The proxy transport is hard-disabled under `NODE_ENV=test` — integration tests depend on the simulated transport; never remove that gate or tests will send real texts.
- Inbound webhook signature validation is the exception: `X-Twilio-Signature` is an HMAC of the raw auth token, so it still requires `TWILIO_AUTH_TOKEN` env; without it inbound routes 503 by design.
- From-number resolution: tenant `sos_settings.sms_from_number` overrides connector/env — placeholder values like `+1555...` make every live send fail with Twilio 21659, so treat stray placeholders as data bugs.

## Delivery-status tracking (delivered/failed)

Twilio StatusCallback signatures are HMACs of the sending account's auth token — which the connector proxy withholds, and the env `TWILIO_AUTH_TOKEN` belongs to a *different* account, so genuine callbacks always fail signature validation in proxy mode. Fix in place:
- The status webhook never trusts an unverified body; on invalid signature it triggers `verifyDeliveryStatusBySid` (authoritative fetch via proxy) — forged requests can at worst cause a truthful lookup.
- A concierge-tick sweep (`reconcileDeliveryStatuses`) polls Twilio for outbound rows stuck at "sent" (updatedAt-throttled, 48h window, batch-capped) as the backstop.
- Settings exposes `smsDeliveryStatusMode` ("callbacks" with raw creds / "polling" in proxy mode / "none" simulated) and the Settings page explains the polling limitation.
Keep any new send path recording the real Twilio SID in providerSid or the sweep can't reconcile it.
