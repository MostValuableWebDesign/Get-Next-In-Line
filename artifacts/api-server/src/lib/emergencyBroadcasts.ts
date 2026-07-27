import {
  db,
  tenantsTable,
  sosCustomersTable,
  emergencyBroadcastsTable,
  emergencyBroadcastTargetsTable,
  emergencyCheckinsTable,
  type EmergencyBroadcast,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { sendMessageSafe } from "./messaging";
import { normalizeToE164 } from "./sms";
import { logger } from "./logger";

// ── Co-Op Emergency & Crisis Network Broadcast ───────────────────────────────
// Shared logic for the /coop/emergency routes, the concierge worker's SMS
// fan-out sweep, and the public landing page status surface.

export const EMERGENCY_SEVERITIES = ["info", "warning", "critical"] as const;
export const EMERGENCY_ALERT_TYPES = [
  "weather_closure",
  "power_outage",
  "safety_alert",
  "schedule_change",
  "other",
] as const;
export const EMERGENCY_CHECKIN_STATUSES = ["open", "temporarily_closed", "safe"] as const;

export const ADMIN_SENDER_NAME = "Platform Administration";

export const CHECKIN_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  temporarily_closed: "Temporarily Closed",
  safe: "Safe",
};

const SEVERITY_LABELS: Record<string, string> = {
  info: "Notice",
  warning: "Alert",
  critical: "URGENT",
};

export interface RosterEntry {
  tenantId: number;
  tenantName: string;
  status: string | null;
  note: string | null;
  checkedInAt: string | null;
}

/** Network status roster: every targeted tenant with its latest check-in. */
export async function rosterForBroadcast(broadcastId: number): Promise<RosterEntry[]> {
  const targets = await db
    .select({
      tenantId: emergencyBroadcastTargetsTable.tenantId,
      tenantName: tenantsTable.brandName,
    })
    .from(emergencyBroadcastTargetsTable)
    .innerJoin(tenantsTable, eq(emergencyBroadcastTargetsTable.tenantId, tenantsTable.id))
    .where(eq(emergencyBroadcastTargetsTable.broadcastId, broadcastId))
    .orderBy(tenantsTable.brandName);
  const checkins = await db
    .select()
    .from(emergencyCheckinsTable)
    .where(eq(emergencyCheckinsTable.broadcastId, broadcastId));
  const byTenant = new Map(checkins.map((c) => [c.tenantId, c]));
  return targets.map((t) => {
    const c = byTenant.get(t.tenantId);
    return {
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      status: c?.status ?? null,
      note: c?.note ?? null,
      checkedInAt: c ? c.updatedAt.toISOString() : null,
    };
  });
}

export async function serializeBroadcast(
  b: EmergencyBroadcast,
  viewerTenantId: number | null,
) {
  const roster = await rosterForBroadcast(b.id);
  const [smsRow] = await db
    .select({
      total: sql<number>`coalesce(sum(${emergencyBroadcastTargetsTable.smsSentCount}), 0)::int`,
    })
    .from(emergencyBroadcastTargetsTable)
    .where(eq(emergencyBroadcastTargetsTable.broadcastId, b.id));
  let senderName = ADMIN_SENDER_NAME;
  if (b.senderTenantId != null) {
    const [t] = await db
      .select({ brandName: tenantsTable.brandName })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, b.senderTenantId));
    senderName = t?.brandName ?? `Business #${b.senderTenantId}`;
  }
  const mine = viewerTenantId != null ? roster.find((r) => r.tenantId === viewerTenantId) : null;
  return {
    id: b.id,
    senderTenantId: b.senderTenantId,
    senderName,
    scope: b.scope,
    severity: b.severity,
    alertType: b.alertType,
    headline: b.headline,
    message: b.message,
    status: b.status,
    resolvedAt: b.resolvedAt ? b.resolvedAt.toISOString() : null,
    targetCount: roster.length,
    checkedInCount: roster.filter((r) => r.status != null).length,
    smsSentCount: smsRow?.total ?? 0,
    myCheckinStatus: mine?.status ?? null,
    myCheckinNote: mine?.note ?? null,
    roster,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/**
 * Concierge-worker fan-out sweep: for every target of an ACTIVE broadcast
 * whose SMS dispatch hasn't been claimed yet, text that tenant's opted-in
 * subscribers. The conditional `sms_dispatched_at IS NULL` claim is the
 * send-once lock — a concurrent tick, or the immediate post-create kick
 * racing the worker, can never double-text a tenant's subscriber base.
 * Returns the number of targets dispatched.
 */
export async function sweepEmergencyBroadcastFanout(now: Date = new Date()): Promise<number> {
  const pending = await db
    .select({
      targetId: emergencyBroadcastTargetsTable.id,
      tenantId: emergencyBroadcastTargetsTable.tenantId,
      broadcast: emergencyBroadcastsTable,
      tenantName: tenantsTable.brandName,
    })
    .from(emergencyBroadcastTargetsTable)
    .innerJoin(
      emergencyBroadcastsTable,
      eq(emergencyBroadcastTargetsTable.broadcastId, emergencyBroadcastsTable.id),
    )
    .innerJoin(tenantsTable, eq(emergencyBroadcastTargetsTable.tenantId, tenantsTable.id))
    .where(
      and(
        isNull(emergencyBroadcastTargetsTable.smsDispatchedAt),
        eq(emergencyBroadcastsTable.status, "active"),
      ),
    );

  let dispatched = 0;
  for (const row of pending) {
    // Claim first: exactly one worker texts this tenant's subscribers.
    const [claimed] = await db
      .update(emergencyBroadcastTargetsTable)
      .set({ smsDispatchedAt: now })
      .where(
        and(
          eq(emergencyBroadcastTargetsTable.id, row.targetId),
          isNull(emergencyBroadcastTargetsTable.smsDispatchedAt),
        ),
      )
      .returning({ id: emergencyBroadcastTargetsTable.id });
    if (!claimed) continue;

    const customers = await db
      .select({
        id: sosCustomersTable.id,
        phone: sosCustomersTable.phone,
        smsOptIn: sosCustomersTable.smsOptIn,
      })
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.tenantId, row.tenantId));

    const sevLabel = SEVERITY_LABELS[row.broadcast.severity] ?? "Alert";
    const seen = new Set<string>();
    let sent = 0;
    for (const customer of customers) {
      const phone = normalizeToE164(customer.phone);
      if (!customer.smsOptIn || !phone || seen.has(phone)) continue;
      seen.add(phone);
      const msg = await sendMessageSafe({
        tenantId: row.tenantId,
        origin: "operational",
        kind: "emergency_broadcast",
        customerId: customer.id,
        toNumber: phone,
        body:
          `${sevLabel} from ${row.tenantName}: ${row.broadcast.headline}. ` +
          `${row.broadcast.message} Reply STOP to opt out.`,
        context: { broadcastId: row.broadcast.id },
      });
      if (msg && (msg.status === "sent" || msg.status === "simulated")) sent++;
    }
    if (sent > 0) {
      await db
        .update(emergencyBroadcastTargetsTable)
        .set({ smsSentCount: sent })
        .where(eq(emergencyBroadcastTargetsTable.id, row.targetId));
    }
    dispatched++;
  }
  if (dispatched > 0) {
    logger.info({ dispatched }, "Emergency broadcast SMS fan-out dispatched");
  }
  return dispatched;
}

/**
 * Public landing surface: the tenant's latest check-in (or a pending prompt)
 * for the newest ACTIVE broadcast targeting it. Null when no alert is active,
 * so the landing page renders normally.
 */
export async function activeEmergencyStatusForTenant(tenantId: number): Promise<{
  headline: string;
  severity: string;
  status: string | null;
  statusLabel: string | null;
  note: string | null;
  updatedAt: string | null;
} | null> {
  const [row] = await db
    .select({ broadcast: emergencyBroadcastsTable })
    .from(emergencyBroadcastTargetsTable)
    .innerJoin(
      emergencyBroadcastsTable,
      eq(emergencyBroadcastTargetsTable.broadcastId, emergencyBroadcastsTable.id),
    )
    .where(
      and(
        eq(emergencyBroadcastTargetsTable.tenantId, tenantId),
        eq(emergencyBroadcastsTable.status, "active"),
      ),
    )
    .orderBy(desc(emergencyBroadcastsTable.createdAt), desc(emergencyBroadcastsTable.id))
    .limit(1);
  if (!row) return null;
  const [checkin] = await db
    .select()
    .from(emergencyCheckinsTable)
    .where(
      and(
        eq(emergencyCheckinsTable.broadcastId, row.broadcast.id),
        eq(emergencyCheckinsTable.tenantId, tenantId),
      ),
    );
  return {
    headline: row.broadcast.headline,
    severity: row.broadcast.severity,
    status: checkin?.status ?? null,
    statusLabel: checkin ? (CHECKIN_STATUS_LABELS[checkin.status] ?? checkin.status) : null,
    note: checkin?.note ?? null,
    updatedAt: checkin ? checkin.updatedAt.toISOString() : null,
  };
}

/** Ids of ACTIVE broadcasts targeting a set of tenants (leak-check helper). */
export async function activeBroadcastIdsForTenants(tenantIds: number[]): Promise<number[]> {
  if (tenantIds.length === 0) return [];
  const rows = await db
    .select({ broadcastId: emergencyBroadcastTargetsTable.broadcastId })
    .from(emergencyBroadcastTargetsTable)
    .innerJoin(
      emergencyBroadcastsTable,
      eq(emergencyBroadcastTargetsTable.broadcastId, emergencyBroadcastsTable.id),
    )
    .where(
      and(
        inArray(emergencyBroadcastTargetsTable.tenantId, tenantIds),
        eq(emergencyBroadcastsTable.status, "active"),
      ),
    );
  return [...new Set(rows.map((r) => r.broadcastId))];
}
