import { db, tenantsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Stale test-tenant sweep.
//
// Every integration test that inserts a tenant builds its subdomain from a
// per-run tag: `const RUN = `<prefix>-${Date.now()}-${process.pid}``, giving
// subdomains like `stop-e2e-1753222335123-4142`, `nss-1753222335123-4142`,
// or with a short suffix (`...-a`, `...-b`, `...-o`). Tests delete their
// tenants in afterAll, but a crashed run skips cleanup and the strays then
// pollute the Tenants page, dashboard totals, and can break future runs
// (duplicate phone numbers make customer auto-link ambiguous).
//
// Matching is strictly structural: a subdomain must embed a 13-digit
// millisecond timestamp followed by a PID segment — something no real tenant
// subdomain ever contains. On top of that, the embedded timestamp must be
// older than MIN_AGE_MS so the sweep never deletes a tenant belonging to a
// test run currently executing in a parallel worker.
//
// If you add a new integration test that inserts tenants, keep using the
// `<prefix>-${Date.now()}-${process.pid}` subdomain convention and the sweep
// covers it automatically.
// ---------------------------------------------------------------------------

/**
 * Matches test-run subdomains: an optional prefix, a 13-digit ms timestamp,
 * a PID, and an optional short alphanumeric suffix (e.g. `-a`, `-b`, `-o`).
 * Captures the timestamp for the age check.
 */
export const TEST_TENANT_SUBDOMAIN_RE =
  /(?:^|-)(\d{13})-\d{1,7}(?:-[a-z0-9]{1,8})?$/;

/** Don't sweep tenants younger than this — they may belong to a live run. */
export const MIN_AGE_MS = 30 * 60 * 1000;

export function isStaleTestTenant(
  subdomain: string,
  now: number = Date.now(),
  minAgeMs: number = MIN_AGE_MS,
): boolean {
  const m = TEST_TENANT_SUBDOMAIN_RE.exec(subdomain);
  if (!m) return false;
  const ts = Number(m[1]);
  // Sanity: the timestamp must be a plausible past date (after 2020) and
  // strictly older than the age threshold.
  if (ts < 1577836800000 || ts > now) return false;
  return now - ts >= minAgeMs;
}

/**
 * Deletes stranded test-run tenants (FK cascades remove their profiles,
 * settings, modules, bookings, etc.). Returns the deleted rows.
 */
export async function sweepStaleTestTenants(options?: {
  now?: number;
  minAgeMs?: number;
}): Promise<Array<{ id: number; brandName: string; subdomain: string }>> {
  // Hard safety gate: integration tests only ever run against the dev
  // database, so stranded test tenants can only exist there. Never run a
  // destructive heuristic sweep against production data.
  if (process.env.NODE_ENV === "production") {
    logger.info("Skipping stale test-tenant sweep: disabled in production");
    return [];
  }
  const now = options?.now ?? Date.now();
  const minAgeMs = options?.minAgeMs ?? MIN_AGE_MS;
  const tenants = await db
    .select({
      id: tenantsTable.id,
      brandName: tenantsTable.brandName,
      subdomain: tenantsTable.subdomain,
    })
    .from(tenantsTable);
  const stale = tenants.filter((t) => isStaleTestTenant(t.subdomain, now, minAgeMs));
  if (stale.length === 0) return [];
  await db.delete(tenantsTable).where(
    inArray(
      tenantsTable.id,
      stale.map((t) => t.id),
    ),
  );
  logger.info(
    { count: stale.length, tenants: stale.map((t) => t.subdomain) },
    "Swept stale test tenants left behind by crashed test runs",
  );
  return stale;
}
