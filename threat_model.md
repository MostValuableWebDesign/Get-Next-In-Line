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

- **Internet → API server** — The Express API is the primary trust boundary. Currently, this boundary is not enforced: no authentication separates anonymous callers from privileged agency operations. **This is the primary vulnerability.**
- **API server → PostgreSQL** — Drizzle ORM with parameterized queries; no raw SQL string concatenation observed. Low injection risk.
- **Frontend → API** — The React frontend (`artifacts/gnil-os`) calls the API. Currently the frontend and API have no shared auth context.
- **Mockup sandbox** — `artifacts/mockup-sandbox` is a design/preview tool, dev-only, not exposed in production API routes.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts` → `artifacts/api-server/src/routes/index.ts`
- **Highest-risk routes:** `POST /api/billing/checkout`, `DELETE /api/tenants/:id`, `PATCH /api/agency/settings`
- **Public surface:** Entire `/api/*` is currently public (no auth)
- **Authenticated surface:** None — no authentication exists yet
- **Admin surface:** No role separation; all endpoints treat every caller as an admin
- **Dev-only:** `artifacts/mockup-sandbox` (design canvas, `/__mockup` path, not part of API surface)

## Threat Categories

### Spoofing / Authentication

**Critical gap:** No authentication exists on any API endpoint. Every management operation — reading tenant PII, modifying billing, deleting tenants — is reachable by any unauthenticated HTTP request. There is no session, JWT, API key, or any other identity check anywhere in the middleware chain.

**Required guarantee:** All `/api` routes except a health check MUST require a verified identity (session token, API key, or equivalent) before returning data or performing mutations.

### Tampering

Without authentication, any caller can mutate agency settings (markup percent affects all billing), update or delete any tenant, and trigger billing checkouts that permanently increment MRR. Business-logic controls (Zod schema validation) are present for input shape but cannot substitute for identity verification.

**Required guarantee:** Write endpoints (PATCH, POST, DELETE) MUST verify the caller is the authorized agency operator before committing changes.

### Information Disclosure

`GET /api/tenants` exposes contact emails and financial data for all tenants to any anonymous caller. `GET /api/modules/pricing` reveals wholesale costs and margins. CORS is configured as wildcard (`*`), permitting any website to read these responses cross-origin.

**Required guarantee:** Read endpoints returning PII or financial data MUST require authentication. CORS MUST be restricted to known frontend origins.

### Elevation of Privilege

There is a single privilege level (no roles). Once authentication is added, role separation between agency admin and read-only viewers should be enforced server-side for mutating endpoints.

### Denial of Service

No rate limiting is present on any endpoint. Public, unauthenticated endpoints that hit the database (e.g., `/api/tenants`) can be hammered without restriction.

### Injection

Drizzle ORM is used throughout with structured query builders (no raw string concatenation observed). SQL injection risk is low. Input is validated with Zod schemas before reaching DB operations.
