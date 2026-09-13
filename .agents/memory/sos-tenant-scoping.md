---
name: Single-business runtime scoping
description: How one configured active business is resolved while internal tenant isolation remains intact.
---

Normal authenticated client requests automatically resolve the deployment's sole active business. Zero or multiple active businesses are configuration errors; never choose the first row and never trust a client tenant header to select a business. Do not expose tenant catalogs, tenant detail, cross-business billing, governance assignment, franchise control, or provisioning simulation in the GNIL client.

**Why:** The product deployment contract is one client and one business. Tenant columns remain for internal isolation and legitimate B2B/co-op participant identities, not as a client-selectable application context.

**How to apply:** Resolve business context before membership authorization and keep scoped queries intact. Preserve public slugs, signed webhooks, gateway tokens, and co-op counterparty IDs. Keep any platform APIs internal and guarded; never remount their pages in the client.
