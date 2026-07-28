# Get Next In Line (GNIL)

Multi-tenant "smart operating system" for local service businesses (salons, barbers, med-spas): SMS-first waitlists/bookings with an AI receptionist, plus a co-op network where neighboring businesses cross-promote perks, pool tips, run group buys, and settle money between each other.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (binds `PORT`)
- `pnpm --filter @workspace/gnil-os run dev` — run the web frontend (preview path `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server test` / `pnpm --filter @workspace/gnil-os run test` — test suites
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm run db:push` — apply DB schema changes via generated migrations (non-interactive; dev only). Migration files live in `lib/db/migrations`.
- `pnpm run db:check-drift` — verify the dev DB matches `lib/db/src/schema`
- `pnpm run db:reconcile` — repair a DB left in a mixed/out-of-band DDL state
- Required env: `DATABASE_URL` (Postgres). Production additionally REQUIRES `SESSION_SECRET` and `ADMIN_PASSWORD` — startup fails fast with a clear message if either is missing (`api-server/src/lib/startupChecks.ts`). Dev falls back to insecure defaults with a warning.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5; sessions in Postgres (connect-pg-simple, Drizzle-owned `session` table)
- DB: PostgreSQL + Drizzle ORM; Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec in `lib/api-spec`)
- Frontend: React + Vite (`artifacts/gnil-os`); Build: esbuild (CJS bundle) for the server

## Where things live

- `artifacts/api-server` — Express API. `src/routes/*` (HTTP), `src/lib/*` (domain logic: co-op, tips, passport, settlement, marketing…), `src/workers/concierge.ts` (reminders/rebooking), `src/index.ts` (startup: env validation, drift check, idempotent backfills).
- `artifacts/gnil-os` — the SPA (CSR-only; crawlable public pages are server-rendered from api-server, see `routes/landing.ts`).
- `artifacts/mockup-sandbox` — design/component preview only.
- `lib/db` — Drizzle schema (source of truth) + migrations; `lib/api-spec` / `lib/api-zod` — OpenAPI contract and generated schemas.

## Architecture decisions

- **Multi-tenant scoping via `x-tenant-id`**: mandatory on `/api/sos` (numeric id or `"legacy"` sentinel for NULL scope; missing/malformed → 400). A scoped caller is strictly that tenant — no platform-admin bypass; admin powers exist only on unscoped requests.
- **Dual auth**: staff/operator use Postgres-backed session cookies (password login = `ADMIN_PASSWORD` platform operator; per-user `loginToken` for seeded users), while customers use SMS wallet login codes — the two are entirely separate systems.
- **White-label contract**: tenant-facing `/api/modules` deliberately omits `slug`; frontend matches modules by `name` (sole exception: `partnerBrand` for the "partners" category).
- **Money integrity**: profit reporting uses `charged_wholesale`/`charged_resale` persisted at checkout; cross-business money events write idempotent settlement obligations; the compliance ledger is append-only.
- **Startup is self-healing in dev only**: dev boot auto-repairs checkpoint-restore schema drift (additive migrations + reseed) and sweeps stale test tenants. Production boot NEVER auto-migrates or sweeps — it logs the drift report and exits; run migrations deliberately, then redeploy.

## Product

- SOS: waitlists, bookings, SMS receptionist (AI parse with fallback), no-show deposit holds (Stripe), tips/gratuity pooling, memberships.
- Co-op network: cross-business perks with a category firewall, campaign blasts, group buys, shift coverage, tip pooling across partners, reputation shield, settlement clearinghouse, Neighborhood Passport stamps.
- Admin console: tenants, module catalog with markups, connector registry, compliance exports.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Session cookie is `Secure` — authenticate over `https://$REPLIT_DEV_DOMAIN`, never `localhost:80`, when testing with curl.
- Schema changes go through `pnpm run db:push`; never run `drizzle-kit push` directly (it prompts even with `--force`). On migration conflicts after a rebase, regenerate yours as the next number — never hand-merge snapshots.
- Integration tests creating tenants MUST use `<prefix>-${Date.now()}-${process.pid}` subdomains — the dev-only stale-tenant sweep relies on that shape.
- api-server tests run files serially (shared dev DB + global co-op state); keep it that way.
- Rate limiters are disabled under `NODE_ENV=test`; tests force-enable via `__configure*ForTests` hooks.
- Never touch drizzle tables / `alias()` at module top level in api-server route/lib files — partial `@workspace/db` mocks break at import.
- SMS bodies must carry fully-qualified public URLs (`APP_BASE_URL` → `REPLIT_DOMAINS` fallback).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- `.agents/memory/MEMORY.md` — deeper per-subsystem notes (co-op lifecycle, tips, settlement, migrations)
