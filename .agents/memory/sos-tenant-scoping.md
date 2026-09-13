---
name: Single-business runtime scoping
description: How one configured active business is resolved while internal tenant isolation remains intact.
---

Normal authenticated client requests automatically resolve the deployment's sole active business. Zero or multiple active businesses are configuration errors; never choose the first row and never trust a client tenant header to select a business. Multi-installation administration belongs only under the separate `/platform/*` control-plane boundary.

**Why:** The merchant product contract is one client and one business. Tenant columns remain for internal isolation, platform-owner administration, and legitimate B2B/co-op participant identities—not as merchant-selectable context.

**How to apply:** Resolve client business context before membership authorization and keep scoped queries intact. Preserve public slugs, signed webhooks, gateway tokens, and co-op counterparty IDs. Platform pages use a distinct shell and `/platform/*` namespace, permit only `super_admin`, and never add business selection to client pages.
