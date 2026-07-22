---
name: SOS platform architecture decisions
description: Key decisions for the SOS operations platform (artifacts/sos + /sos API routes)
---

- SOS is a separate product from GNIL OS; its API routes are mounted in the PUBLIC section of the api-server router (before `requireAuth`) on purpose — SOS has no login yet and will need public Twilio webhooks. **Why:** GNIL's admin session wall would 401 the whole SOS frontend. **How to apply:** before publishing SOS to production, add product-specific auth and keep only webhook endpoints public (with signature verification). This is a known open risk flagged in review.
- SMS layer degrades gracefully: records messages with `deliveryStatus: "simulated"` when no Twilio credentials (connector or TWILIO_* env vars) exist — never silent-fails, never blocks the product flow.
- AI receptionist intent parsing uses the Replit OpenAI integration when `AI_INTEGRATIONS_OPENAI_*` env vars exist, else a deterministic keyword parser. If AI integration setup fails, check whether the account still needs phone verification in Replit.
- Concurrency rules: resource assignment and waitlist claim use conditional UPDATE ... WHERE status=... RETURNING guards (first-write-wins), and waitlist fill notifications are scoped to matching desired service + same slot on reset.
