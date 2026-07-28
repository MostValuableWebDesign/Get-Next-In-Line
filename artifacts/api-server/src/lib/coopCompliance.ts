import {
  db,
  coopTaxSettingsTable,
  coopComplianceLedgerTable,
  coopPartnerPayoutsTable,
  tenantsTable,
  type CoopTaxSettings,
  type CoopComplianceLedgerEntry,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Co-Op Tax & Revenue Compliance Ledger — write-side helpers.
 *
 * Every entry snapshots the tenant's tax rates at write time (rate changes
 * only affect entries going forward), computes the estimated tax obligation
 * from that snapshot, and — for expense-side entries naming a payee —
 * accumulates the payee's calendar-year payout total for 1099 tracking.
 * All figures are merchant-configured ESTIMATES, not tax advice.
 */

export const COOP_COMPLIANCE_CATEGORIES = [
  "perk_redemption",
  "referral_commission",
  "sponsorship",
  "shared_expense",
] as const;
export type CoopComplianceCategory = (typeof COOP_COMPLIANCE_CATEGORIES)[number];

export interface CoopComplianceEvent {
  tenantId: number | null;
  category: CoopComplianceCategory;
  /** income | expense — which side of the tenant's books. */
  direction: "income" | "expense";
  counterpartTenantId?: number | null;
  payeeName?: string | null;
  description?: string | null;
  /** Gross dollars, e.g. 25 or 25.5. */
  grossAmount: number;
  /** Unique stable reference, e.g. "coop_perk_redemptions:12". */
  sourceRef: string;
  occurredAt: Date;
}

const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** Tenant's tax settings row, auto-created with zero rates on first access. */
export async function getCoopTaxSettings(tenantId: number | null): Promise<CoopTaxSettings> {
  const scope =
    tenantId == null
      ? isNull(coopTaxSettingsTable.tenantId)
      : eq(coopTaxSettingsTable.tenantId, tenantId);
  const [existing] = await db.select().from(coopTaxSettingsTable).where(scope).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(coopTaxSettingsTable)
    .values({ tenantId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db.select().from(coopTaxSettingsTable).where(scope).limit(1);
  return raced;
}

export function combinedRatePercent(s: {
  stateRatePercent: string;
  localRatePercent: string;
  salesRatePercent: string;
}): number {
  return (
    parseFloat(s.stateRatePercent) + parseFloat(s.localRatePercent) + parseFloat(s.salesRatePercent)
  );
}

/** Normalized 1099 payee key: on-platform counterparts by tenant id, off-platform by lowercased name. */
export function payoutPayeeKey(e: {
  counterpartTenantId?: number | null;
  payeeName?: string | null;
}): string | null {
  if (e.counterpartTenantId != null) return `tenant:${e.counterpartTenantId}`;
  const name = e.payeeName?.trim();
  return name ? `name:${name.toLowerCase()}` : null;
}

/**
 * Record compliance ledger entries without ever throwing — the ledger
 * observes financial events, it must never alter or abort them. Idempotent
 * via the unique source_ref; payout accumulation only runs for rows the
 * insert actually created, so replays never double-count 1099 totals.
 * Returns the created rows (empty for pure replays or on failure).
 */
export async function recordCoopComplianceEventsSafe(
  events: CoopComplianceEvent[],
): Promise<CoopComplianceLedgerEntry[]> {
  if (events.length === 0) return [];
  try {
    const created: CoopComplianceLedgerEntry[] = [];
    // Settings are per-tenant; resolve once per distinct tenant in the batch.
    const settingsByTenant = new Map<number | null, CoopTaxSettings>();
    for (const e of events) {
      if (!settingsByTenant.has(e.tenantId)) {
        settingsByTenant.set(e.tenantId, await getCoopTaxSettings(e.tenantId));
      }
    }
    for (const e of events) {
      const s = settingsByTenant.get(e.tenantId)!;
      const rate = combinedRatePercent(s);
      const [row] = await db
        .insert(coopComplianceLedgerTable)
        .values({
          tenantId: e.tenantId,
          category: e.category,
          direction: e.direction,
          counterpartTenantId: e.counterpartTenantId ?? null,
          payeeName: e.payeeName?.trim() || null,
          description: e.description ?? null,
          grossAmount: money(e.grossAmount),
          stateRatePercent: s.stateRatePercent,
          localRatePercent: s.localRatePercent,
          salesRatePercent: s.salesRatePercent,
          estimatedTaxAmount: money((e.grossAmount * rate) / 100),
          sourceRef: e.sourceRef,
          occurredAt: e.occurredAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) continue;
      created.push(row);
      // 1099 payout accumulation: expense-side entries paid to a payee.
      if (row.direction === "expense") {
        const key = payoutPayeeKey(row);
        if (key) {
          let payeeName = row.payeeName ?? "";
          if (!payeeName && row.counterpartTenantId != null) {
            const [t] = await db
              .select({ brandName: tenantsTable.brandName })
              .from(tenantsTable)
              .where(eq(tenantsTable.id, row.counterpartTenantId));
            payeeName = t?.brandName ?? `Tenant ${row.counterpartTenantId}`;
          }
          await db
            .insert(coopPartnerPayoutsTable)
            .values({
              tenantId: row.tenantId,
              payeeKey: key,
              payeeName: payeeName || "Unknown payee",
              calendarYear: row.occurredAt.getUTCFullYear(),
              totalPaid: row.grossAmount,
            })
            .onConflictDoUpdate({
              target: [
                coopPartnerPayoutsTable.tenantId,
                coopPartnerPayoutsTable.payeeKey,
                coopPartnerPayoutsTable.calendarYear,
              ],
              set: {
                totalPaid: sql`${coopPartnerPayoutsTable.totalPaid} + ${row.grossAmount}`,
                payeeName: payeeName || coopPartnerPayoutsTable.payeeName,
                updatedAt: new Date(),
              },
            });
        }
      }
    }
    return created;
  } catch (err) {
    logger.error(
      { err, sourceRefs: events.map((e) => e.sourceRef) },
      "COOP COMPLIANCE LEDGER WRITE FAILED — tax ledger is missing entries",
    );
    return [];
  }
}

/**
 * Ledger both sides of a counted perk redemption when the partnership has
 * monetary terms: an expense for the redeeming business (it honored the
 * perk's value) and mirrored income context for the sending side is captured
 * via counterpartTenantId. Never throws; no-op when perkValueAmount is NULL.
 */
export async function recordPerkRedemptionComplianceSafe(args: {
  redemptionId: number;
  redeemedByTenantId: number | null;
  otherTenantId: number | null;
  perkValueAmount: string | null;
  perkTitle: string;
  redeemedAt: Date;
}): Promise<void> {
  if (args.perkValueAmount == null) return;
  const value = parseFloat(args.perkValueAmount);
  if (!Number.isFinite(value) || value <= 0) return;
  await recordCoopComplianceEventsSafe([
    {
      tenantId: args.redeemedByTenantId,
      category: "perk_redemption",
      direction: "expense",
      counterpartTenantId: args.otherTenantId,
      description: `Perk redeemed: ${args.perkTitle}`,
      grossAmount: value,
      sourceRef: `coop_perk_redemptions:${args.redemptionId}`,
      occurredAt: args.redeemedAt,
    },
  ]);
}

// ── period parsing ───────────────────────────────────────────────────────────

export interface CompliancePeriod {
  /** Canonical label, e.g. "2026", "2026-07", "2026-Q3". */
  label: string;
  from: Date;
  to: Date; // exclusive
}

/**
 * Parse a period key: "YYYY" (year), "YYYY-MM" (month), or "YYYY-Qn"
 * (quarter). Returns null for anything else. All boundaries are UTC.
 */
export function parseCompliancePeriod(raw: string | undefined): CompliancePeriod | null {
  if (!raw) return null;
  const year = /^(\d{4})$/.exec(raw);
  if (year) {
    const y = Number(year[1]);
    return { label: raw, from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) };
  }
  const quarter = /^(\d{4})-[Qq]([1-4])$/.exec(raw);
  if (quarter) {
    const y = Number(quarter[1]);
    const q = Number(quarter[2]);
    return {
      label: `${y}-Q${q}`,
      from: new Date(Date.UTC(y, (q - 1) * 3, 1)),
      to: new Date(Date.UTC(y, q * 3, 1)),
    };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(raw);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    return { label: raw, from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
  }
  return null;
}
