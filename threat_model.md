# Threat Model

## Project Overview

A multi-tenant SaaS agency management platform ("Get Next In Line — GNIL OS") built with Node.js/Express 5, PostgreSQL + Drizzle ORM, and a React/Vite frontend. The platform lets a single agency manage sub-tenants (brands/clients), provision SaaS modules, and track billing and MRR. Not yet deployed (no active deployment as of last scan).

**Stack:** pnpm workspaces, Node.js 24, TypeScript 5.9, Express 5, Drizzle ORM, Zod validation, esbuild, React 18 + Vite.

## Assets

- **Tenant records** — brand names, contact emails, subdomains, operational status, MRR values. Contains PII and business-sensitive financial data.
- **Agency settings** — platform name, markup percent, deployment mode. Tampering changes all resale prices and margins.
- **Billing state** — per-tenant MRR, modules enabled, transaction records. Manipulation directly affects revenue calculations.
- **Module catalog** — wholesale prices, resale prices, category/slug data.
- **Activity log** — audit trail of provisioning and status changes.
- **Database credentials** — `DATABASE_URL` environment variable; compromise gives full DB access.

## Trust Boundaries

- **Internet → API server** — The Express API is the primary trust boundary. It is enforced by session-cookie authentication (`express-session`, HttpOnly + Secure cookie) applied to all `/api` routes except an explicit exemption list (auth endpoints and Twilio webhooks, which are authenticated by X-Twilio-Signature validation).
- **API server → PostgreSQL** — Drizzle ORM with parameterized queries; no raw SQL string concatenation observed. Low injection risk.
- **Frontend → API** — The React frontend (`artifacts/gnil-os`) calls the API with a shared session-cookie auth context (`credentials: include`), gated by a CORS origin allowlist.
- **Mockup sandbox** — `artifacts/mockup-sandbox` is a design/preview tool, dev-only, not exposed in production API routes.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts` → `artifacts/api-server/src/routes/index.ts`
- **Highest-risk routes:** `POST /api/billing/checkout`, `DELETE /api/tenants/:id`, `PATCH /api/agency/settings`
- **Public surface:** Auth endpoints (`/auth/login`, `/auth/logout`, `/auth/me`) and Twilio webhooks (signature-verified) — see `SESSION_EXEMPT_PATHS` in `routes/index.ts`
- **Authenticated surface:** All other `/api/*` routes require a valid session
- **Admin surface:** Single operator role; all authenticated callers are treated as the agency admin (no role separation yet)
- **Dev-only:** `artifacts/mockup-sandbox` (design canvas, `/__mockup` path, not part of API surface)

## Threat Categories

### Spoofing / Authentication

Session-cookie authentication (ADMIN_PASSWORD login, `express-session` signed with SESSION_SECRET) protects all `/api` routes except the explicit exemption list (auth endpoints and signature-verified Twilio webhooks). Regression tests pin the exemption list to exactly those paths.

**Guarantee:** All `/api` routes except the audited exemptions MUST require a verified session before returning data or performing mutations; any addition to `SESSION_EXEMPT_PATHS` is a session-auth bypass and must be reviewed.

### Tampering

Write endpoints (agency settings, tenant updates/deletes, billing checkouts) sit behind session auth, so only the authenticated agency operator can commit changes. Zod schema validation additionally constrains input shape.

**Guarantee:** Write endpoints (PATCH, POST, DELETE) MUST remain behind session auth; identity verification cannot be replaced by input validation.

### Information Disclosure

Read endpoints returning PII or financial data (`GET /api/tenants`, `GET /api/modules/pricing`) require an authenticated session. CORS is restricted to an explicit origin allowlist (Replit domains from REPLIT_DOMAINS, production getnextinline.com origins / ALLOWED_ORIGINS, and localhost in development); requests from other origins are rejected, and regression tests cover the allowlist behavior.

**Guarantee:** Read endpoints returning PII or financial data MUST require authentication, and the CORS allowlist MUST NOT be widened to a wildcard — especially since credentials (session cookies) are enabled.

### Elevation of Privilege

There is a single authenticated privilege level (agency operator, no roles). If additional user types are added, role separation between agency admin and read-only viewers should be enforced server-side for mutating endpoints.

### Denial of Service

No rate limiting is present on any endpoint. The unauthenticated login endpoint (`POST /auth/login`) can be hammered without restriction, enabling password brute-forcing; rate limiting there should be a priority.

### Injection

Drizzle ORM is used throughout with structured query builders (no raw string concatenation observed). SQL injection risk is low. Input is validated with Zod schemas before reaching DB operations.
