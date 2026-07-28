---
name: Module checkout payment modes
description: Live Stripe vs simulated module provisioning — gating, webhook idempotency, test hook
---

# Module checkout payment modes

- Module checkout has two modes: **live** (Stripe configured → real Stripe Checkout session; NOTHING provisions until the `checkout.session.completed` webhook) and **simulated** (Stripe absent → immediate provisioning, explicitly labeled, `sim_` transaction ids).
- The priced cart is snapshotted in `module_checkout_sessions` at checkout time; the webhook provisions from that snapshot and never re-derives pricing. The row's pending→completed conditional update is the send-once claim (duplicate/late webhooks are no-ops; expired sessions go pending→failed and a later "completed" cannot resurrect them).
- `tenant_modules.payment_mode` ("simulated" default, incl. all legacy rows / "live") is how billing surfaces distinguish real vs simulated revenue; ledger descriptions carry the label too.
- **Why:** real money must never be conflated with simulated MRR, and Stripe retries webhooks — provisioning must be idempotent.
- **How to apply:** under NODE_ENV=test the live path is OFF by default so existing checkout tests keep hitting the simulated path; live-mode tests mock `lib/stripeClient` and opt in via `__setLiveModuleCheckoutForTests(true)` (reset to null in afterEach). Any new provisioning path must go through `provisionModuleItems` so payment mode, ledger, MRR, and activity stay consistent.
