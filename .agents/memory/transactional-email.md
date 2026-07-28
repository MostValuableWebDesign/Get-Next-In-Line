---
name: Transactional email channel
description: How email sends work alongside SMS in the unified messaging layer, and the SMS-only automation boundary.
---

# Transactional email channel

- Email delivery mirrors the SMS pattern: Resend connector/env creds, else "simulated" status; all sends go through the unified `sendMessage` (channel "email"), recorded in `messages` with `to_email` and a `subject` in the payload.
- **Rule:** channel "email" in `sendMessage` requires an explicit `toEmail`; without one it reports `unsupported_channel`.
  **Why:** concierge automation dispatches by the profile's preferred channel and is contractually SMS-only — tests assert non-SMS preferred channels skip with `unsupported_channel`.
  **How to apply:** new email touchpoints must resolve the recipient address themselves (see the transactional email helpers) and gate on the SOS customer's `emailOptIn`; never make preference-driven automation start emailing.
- Booking confirmations (public + staff) and checkout receipts are the email touchpoints; they are additive to SMS, never replacements, and bodies must carry fully-qualified public URLs.
- Timeline channel enum (`ai_call|sms|concierge|email`) and message `kind` enum live in the OpenAPI spec — new email kinds must be added there or zod-parsed lists 400.
