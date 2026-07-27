import {
  db,
  coopEventsTable,
  coopMonthlyReportsTable,
  merchantCoopPartnershipsTable,
  sosSettingsTable,
  tenantsTable,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { logger } from "./logger";

// ── Co-op analytics event recording & aggregation ────────────────────────────
// Every co-op touchpoint (perk impressions, redemption-code claims, cross-over
// visits) is recorded as a tenant-scoped event row here. Recording is always
// best-effort: an analytics failure must never break the perk/checkout flow
// that triggered it, so the record* helpers log and swallow errors.

export type CoopEventType = "impression" | "claim" | "crossover";

export interface CoopEventInput {
  tenantId: number;
  partnershipId: number;
  partnerTenantId: number;
  eventType: CoopEventType;
  revenueAmount?: string | null;
}

/** Insert co-op events; never throws (analytics must not break the flow). */
export async function recordCoopEventsSafe(events: CoopEventInput[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await db.insert(coopEventsTable).values(
      events.map((e) => ({
        tenantId: e.tenantId,
        partnershipId: e.partnershipId,
        partnerTenantId: e.partnerTenantId,
        eventType: e.eventType,
        revenueAmount: e.revenueAmount ?? null,
      })),
    );
  } catch (err) {
    logger.error({ err, count: events.length }, "Failed to record co-op events");
  }
}

/**
 * Record one impression per perk shown to `tenantId`'s customers. Accepts the
 * partnership rows a perk surface just rendered/served.
 */
export async function recordPerkImpressionsSafe(
  tenantId: number,
  partnerships: Pick<MerchantCoopPartnership, "id" | "hostTenantId" | "partnerTenantId">[],
): Promise<void> {
  await recordCoopEventsSafe(
    partnerships.map((p) => ({
      tenantId,
      partnershipId: p.id,
      partnerTenantId: p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId,
      eventType: "impression" as const,
    })),
  );
}

/** How long after a cross-over scan a checkout can still be attributed to it. */
export const CROSSOVER_REVENUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Attribute checkout revenue to the most recent unattributed cross-over event
 * at this tenant (within the attribution window). This is the estimate the
 * monthly "revenue influenced" figure is built from: a partner's customer
 * scanned their perk pass here, then checked out. Never throws.
 */
export async function attachRevenueToRecentCrossoverSafe(
  tenantId: number | null,
  amount: number | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  if (tenantId == null || amount == null || !(amount > 0)) return false;
  try {
    const cutoff = new Date(now.getTime() - CROSSOVER_REVENUE_WINDOW_MS);
    const [candidate] = await db
      .select({ id: coopEventsTable.id })
      .from(coopEventsTable)
      .where(
        and(
          eq(coopEventsTable.tenantId, tenantId),
          eq(coopEventsTable.eventType, "crossover"),
          isNull(coopEventsTable.revenueAmount),
          gte(coopEventsTable.occurredAt, cutoff),
        ),
      )
      .orderBy(desc(coopEventsTable.occurredAt), desc(coopEventsTable.id))
      .limit(1);
    if (!candidate) return false;
    // Conditional update: a concurrent checkout attributing the same event
    // loses the race and simply attributes nothing.
    const updated = await db
      .update(coopEventsTable)
      .set({ revenueAmount: amount.toFixed(2) })
      .where(and(eq(coopEventsTable.id, candidate.id), isNull(coopEventsTable.revenueAmount)))
      .returning({ id: coopEventsTable.id });
    return updated.length > 0;
  } catch (err) {
    logger.error({ err, tenantId }, "Failed to attribute checkout revenue to co-op crossover");
    return false;
  }
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export interface CoopPartnerPerformance {
  partnershipId: number;
  partnerTenantId: number;
  partnerName: string;
  perkTitle: string;
  isActive: boolean;
  impressions: number;
  claims: number;
  clientsSent: number;
  clientsReceived: number;
  revenueInfluenced: number;
}

interface DateRange {
  from?: Date;
  to?: Date;
}

function rangeConditions(range: DateRange) {
  const conds = [];
  if (range.from) conds.push(gte(coopEventsTable.occurredAt, range.from));
  if (range.to) conds.push(lt(coopEventsTable.occurredAt, range.to));
  return conds;
}

/**
 * Per-partnership performance for one tenant: impressions and claims recorded
 * at this business, clients received (cross-overs at this business) vs sent
 * (cross-overs at the partner on the same partnership), and revenue
 * influenced (attributed crossover revenue at this business).
 */
export async function partnerPerformanceForTenant(
  tenantId: number,
  range: DateRange = {},
): Promise<CoopPartnerPerformance[]> {
  const partnerships = await db
    .select({
      partnership: merchantCoopPartnershipsTable,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        eq(merchantCoopPartnershipsTable.status, "accepted"),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
        ),
      ),
    )
    .orderBy(desc(merchantCoopPartnershipsTable.createdAt), desc(merchantCoopPartnershipsTable.id));
  if (partnerships.length === 0) return [];

  const ids = partnerships.map((p) => p.partnership.id);
  const rows = await db
    .select({
      partnershipId: coopEventsTable.partnershipId,
      eventType: coopEventsTable.eventType,
      atTenantId: coopEventsTable.tenantId,
      n: sql<number>`count(*)::int`,
      revenue: sql<string>`coalesce(sum(${coopEventsTable.revenueAmount}), 0)`,
    })
    .from(coopEventsTable)
    .where(and(inArray(coopEventsTable.partnershipId, ids), ...rangeConditions(range)))
    .groupBy(coopEventsTable.partnershipId, coopEventsTable.eventType, coopEventsTable.tenantId);

  // Partner display names.
  const partnerIds = [
    ...new Set(
      partnerships.map((p) =>
        p.partnership.hostTenantId === tenantId
          ? p.partnership.partnerTenantId
          : p.partnership.hostTenantId,
      ),
    ),
  ];
  const names = partnerIds.length
    ? await db
        .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
        .from(tenantsTable)
        .where(inArray(tenantsTable.id, partnerIds))
    : [];
  const nameById = new Map(names.map((t) => [t.id, t.brandName]));

  return partnerships.map(({ partnership: p }) => {
    const partnerTenantId = p.hostTenantId === tenantId ? p.partnerTenantId : p.hostTenantId;
    const forThis = rows.filter((r) => r.partnershipId === p.id);
    const count = (type: CoopEventType, at: number) =>
      forThis
        .filter((r) => r.eventType === type && r.atTenantId === at)
        .reduce((s, r) => s + r.n, 0);
    const revenue = forThis
      .filter((r) => r.eventType === "crossover" && r.atTenantId === tenantId)
      .reduce((s, r) => s + parseFloat(r.revenue), 0);
    return {
      partnershipId: p.id,
      partnerTenantId,
      partnerName: nameById.get(partnerTenantId) ?? "Unknown business",
      perkTitle: p.perkTitle,
      isActive: p.isActive,
      impressions: count("impression", tenantId),
      claims: count("claim", tenantId),
      // Cross-overs are recorded at the business the customer showed up at:
      // at me = clients I received; at the partner = clients I sent.
      clientsReceived: count("crossover", tenantId),
      clientsSent: count("crossover", partnerTenantId),
      revenueInfluenced: Math.round(revenue * 100) / 100,
    };
  });
}

// ── Monthly impact reports ───────────────────────────────────────────────────

/** "YYYY-MM" key of the month containing `d` (UTC). */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** [start, end) UTC bounds of the month "YYYY-MM". */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)),
  };
}

/** "YYYY-MM" key of the month before `now`. */
export function priorMonthKey(now: Date = new Date()): string {
  return monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

export interface MonthlyReportRunResult {
  month: string;
  created: number;
  notified: number;
}

/**
 * Generate the monthly co-op impact report for every tenant that participates
 * in at least one accepted partnership (or recorded events that month), for
 * the month before `now`. Idempotent per tenant-month: the unique
 * (tenant, month) constraint means a re-run inserts nothing and therefore
 * notifies no one twice. Safe to call on every worker tick.
 */
export async function generateCoopMonthlyReports(
  now: Date = new Date(),
): Promise<MonthlyReportRunResult> {
  const month = priorMonthKey(now);
  const { start, end } = monthBounds(month);

  // Tenants in scope: any side of an accepted partnership, plus any tenant
  // with events recorded that month (covers partnerships since deleted).
  const partRows = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.status, "accepted"));
  const eventTenants = await db
    .selectDistinct({ tenantId: coopEventsTable.tenantId })
    .from(coopEventsTable)
    .where(and(gte(coopEventsTable.occurredAt, start), lt(coopEventsTable.occurredAt, end)));
  const tenantIds = new Set<number>();
  for (const r of partRows) {
    tenantIds.add(r.hostTenantId);
    tenantIds.add(r.partnerTenantId);
  }
  for (const r of eventTenants) tenantIds.add(r.tenantId);
  if (tenantIds.size === 0) return { month, created: 0, notified: 0 };

  // Skip tenants that already have this month's report (fast path for the
  // every-tick call; the unique constraint is still the hard guarantee).
  const existing = await db
    .select({ tenantId: coopMonthlyReportsTable.tenantId })
    .from(coopMonthlyReportsTable)
    .where(
      and(
        eq(coopMonthlyReportsTable.month, month),
        inArray(coopMonthlyReportsTable.tenantId, [...tenantIds]),
      ),
    );
  for (const r of existing) tenantIds.delete(r.tenantId);
  if (tenantIds.size === 0) return { month, created: 0, notified: 0 };

  const totals = await db
    .select({
      tenantId: coopEventsTable.tenantId,
      eventType: coopEventsTable.eventType,
      n: sql<number>`count(*)::int`,
      revenue: sql<string>`coalesce(sum(${coopEventsTable.revenueAmount}), 0)`,
    })
    .from(coopEventsTable)
    .where(
      and(
        inArray(coopEventsTable.tenantId, [...tenantIds]),
        gte(coopEventsTable.occurredAt, start),
        lt(coopEventsTable.occurredAt, end),
      ),
    )
    .groupBy(coopEventsTable.tenantId, coopEventsTable.eventType);

  let created = 0;
  let notified = 0;
  for (const tenantId of tenantIds) {
    const forTenant = totals.filter((t) => t.tenantId === tenantId);
    const count = (type: CoopEventType) =>
      forTenant.filter((t) => t.eventType === type).reduce((s, t) => s + t.n, 0);
    const revenue = forTenant
      .filter((t) => t.eventType === "crossover")
      .reduce((s, t) => s + parseFloat(t.revenue), 0);
    const impressions = count("impression");
    const claims = count("claim");
    const crossoverVisits = count("crossover");

    // onConflictDoNothing + returning: only the run that actually created the
    // row (won the tenant-month lock) sends the notification.
    let inserted: { id: number } | undefined;
    try {
      [inserted] = await db
        .insert(coopMonthlyReportsTable)
        .values({
          tenantId,
          month,
          impressions,
          claims,
          crossoverVisits,
          revenueInfluenced: revenue.toFixed(2),
        })
        .onConflictDoNothing()
        .returning({ id: coopMonthlyReportsTable.id });
    } catch (err) {
      // FK violation: the tenant was deleted between scoping and insert
      // (concurrent offboarding). Skip it — nothing to report on.
      const pgCode =
        (err as { code?: string }).code ??
        ((err as { cause?: { code?: string } }).cause?.code);
      if (pgCode === "23503") continue;
      throw err;
    }
    if (!inserted) continue;
    created++;

    // Owner notification via the existing messaging pipeline (simulated-SMS
    // fallback applies automatically). Best-effort: a send problem is
    // recorded on the message row and never blocks report generation.
    const [settings] = await db
      .select({ publicPhone: sosSettingsTable.publicPhone, businessName: sosSettingsTable.businessName })
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.tenantId, tenantId));
    const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    await sendMessageSafe({
      tenantId,
      origin: "concierge",
      toNumber: settings?.publicPhone?.trim() || null,
      kind: "coop_monthly_report",
      body: `Your ${monthLabel} Co-Op impact report is ready: ${impressions} perk impressions, ${claims} perks claimed, ${crossoverVisits} cross-over visits, and an estimated $${revenue.toFixed(2)} in revenue influenced. See the full breakdown in your Co-Op Partner Hub.`,
      context: { month, impressions, claims, crossoverVisits, revenueInfluenced: revenue.toFixed(2) },
    });
    notified++;
  }
  if (created > 0) {
    logger.info({ month, created, notified }, "Generated co-op monthly impact reports");
  }
  return { month, created, notified };
}
