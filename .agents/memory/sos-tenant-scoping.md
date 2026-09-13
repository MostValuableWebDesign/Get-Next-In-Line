---
name: Single-business runtime scoping
description: How one configured active business is resolved while internal tenant isolation remains intact.
---

Normal authenticated SOS and Operations requests automatically resolve the deployment's sole active business. Zero or multiple active businesses are configuration errors; never choose the first row and never trust a client tenant header to select a business.

**Why:** The product deployment contract is one client and one business, but tenant columns still provide internal query isolation during this runtime-only migration phase.

**How to apply:** Resolve business context before membership authorization, then continue passing its internal tenant ID through every existing scoped query and direct-ID predicate. Keep public slug routes, signed webhooks, gateway tokens, and true platform administration on their independent resolution models.
