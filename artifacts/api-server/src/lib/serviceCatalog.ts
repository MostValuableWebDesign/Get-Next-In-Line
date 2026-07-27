import { db, sosServicesTable, sosSettingsTable } from "@workspace/db";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { parseServiceNames } from "./receptionist";
import { logger } from "./logger";

export type SosServiceRow = typeof sosServicesTable.$inferSelect;

/**
 * Structured service catalog (sos_services) — the source of truth for a
 * business's service menu. The legacy comma-separated
 * sos_settings.service_names string remains a read-only fallback for scopes
 * that have not been backfilled yet.
 */

function scopeMatch(tenantId: number | null) {
  return tenantId == null
    ? isNull(sosServicesTable.tenantId)
    : eq(sosServicesTable.tenantId, tenantId);
}

/** All service rows for a scope, in display order. */
export async function listServicesForScope(
  tenantId: number | null,
): Promise<SosServiceRow[]> {
  return db
    .select()
    .from(sosServicesTable)
    .where(scopeMatch(tenantId))
    .orderBy(asc(sosServicesTable.sortOrder), asc(sosServicesTable.id));
}

/**
 * The service vocabulary for a scope: active structured services in display
 * order when the catalog has rows, otherwise the parsed legacy
 * `serviceNames` string. This is the single source both the AI receptionist
 * and staff booking suggestions must use so parsing never drifts.
 */
export async function getServiceNamesForScope(
  tenantId: number | null,
  legacyServiceNames: string | null | undefined,
): Promise<string[]> {
  const rows = await listServicesForScope(tenantId);
  if (rows.length > 0) {
    return rows.filter((r) => r.isActive).map((r) => r.name);
  }
  return parseServiceNames(legacyServiceNames);
}

/**
 * One-time (idempotent) backfill: for every settings row whose scope has a
 * non-empty legacy serviceNames string but zero structured service rows,
 * create name-only catalog entries (no category/price/duration — owners fill
 * those in via the Service Menu editor). Safe to re-run: scopes that already
 * have any catalog rows are skipped, so edits are never overwritten.
 */
export async function backfillServiceCatalog(): Promise<void> {
  const settingsRows = await db
    .select({
      tenantId: sosSettingsTable.tenantId,
      serviceNames: sosSettingsTable.serviceNames,
    })
    .from(sosSettingsTable)
    .where(ne(sosSettingsTable.serviceNames, ""));

  for (const s of settingsRows) {
    const names = parseServiceNames(s.serviceNames);
    if (names.length === 0) continue;
    try {
      await db.transaction(async (tx) => {
        // Guard inside the transaction so concurrent server starts can't
        // double-insert: skip any scope that already has catalog rows.
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(sosServicesTable)
          .where(scopeMatch(s.tenantId));
        if (n > 0) return;
        await tx.insert(sosServicesTable).values(
          names.map((name, i) => ({
            tenantId: s.tenantId,
            name,
            sortOrder: i,
          })),
        );
        logger.info(
          { tenantId: s.tenantId, count: names.length },
          "Backfilled legacy serviceNames into structured service catalog",
        );
      });
    } catch (err) {
      logger.error(
        { err, tenantId: s.tenantId },
        "Service catalog backfill failed for scope",
      );
    }
  }
}
