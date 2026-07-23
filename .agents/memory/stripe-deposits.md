---
name: Stripe deposit holds (No-Show Shield)
description: Quirks of the Replit Stripe connector and stripe-replit-sync in this repo
---

- The Replit Stripe connector's connection API returns the key under `settings.secret` (with `publishable`, `account_id`), NOT the skill template's `settings.secret_key`. stripeClient accepts both shapes.
  **Why:** blindly following the template made credential fetch fail with "not connected" even though the connector was attached.
- `stripe-replit-sync` must be listed in api-server's esbuild `external` array: it loads its SQL migration files from disk relative to its package dir, so bundling makes `runMigrations` a silent no-op and the `stripe` schema never gets created (webhook setup then fails with `relation "stripe.accounts" does not exist`).
- Deposit-hold lifecycle: `pending_authorization` (Checkout link created, manual-capture PI) → `held` via `checkout.session.completed` webhook → `released` (PI void) / `captured` (partial capture of fee cents) / `failed` (never authorized or Stripe create failed — surfaced in outcomeReason). Stripe op failures during settle keep the hold `held` and write the error to outcomeReason so staff can retry.
- Webhook route `/api/stripe/webhook` uses `express.raw()` and is registered BEFORE `express.json()` in app.ts; domain logic runs after stripe-replit-sync signature verification and must not throw (would make Stripe retry).
- Integration tests mock `../../lib/stripeClient` via vi.mock with a fake Stripe recording calls; `authorizeHold()` helper simulates the checkout.session.completed webhook.
