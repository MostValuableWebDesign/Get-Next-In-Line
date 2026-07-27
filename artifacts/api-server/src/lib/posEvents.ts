import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  posInboundEventsTable,
  posIntegrationsTable,
  sosCustomersTable,
  sosStaffMembersTable,
  sosResourcesTable,
  sosVisitsTable,
  perkPassesTable,
  coopPerkRedemptionsTable,
  coopAttributionEventsTable,
  type PosIntegration,
} from "@workspace/db";
import type { PgColumn } from "drizzle-orm/pg-core";
import { randomUUID } from "crypto";
import { logger } from "./logger";
import { normalizeToE164 } from "./sms";
import { autoLinkCustomer } from "./customerLink";
import { updateProfileCadence } from "./visitCadence";
import { grantPerkPassesSafe, findWalletPass, isWalletPassToken } from "./perkPasses";
import { attachRevenueToRecentCrossoverSafe } from "./coopEvents";
import { recordPassportStampSafe } from "./passport";
import type { CoopDirection } from "./coopTracking";
import { translatePosPayload, type NormalizedPosEvent, type PosVendor } from "./posVendors";

/**
 * Normalized POS event processing pipeline.
 *
 * Every signature-verified delivery is logged in pos_inbound_events first —
 * including malformed and unrecognized payloads — and then translated into
 * platform effects. The unique (integration, external event id) constraint is
 * the idempotency lock: a vendor retry of an already-logged event is
 * acknowledged without reprocessing.
 */

export interface PosProcessResult {
  /** processed | duplicate | ignored | unrecognized | invalid | error */
  status: string;
  detail: string;
  eventLogId: number | null;
}

function tenantMatch(column: PgColumn, tenantId: number | null) {
  return tenantId == null ? isNull(column) : eq(column, tenantId);
}

// ── customer matching ────────────────────────────────────────────────────────

async function matchOrCreateCustomer(
  integration: PosIntegration,
  ev: NormalizedPosEvent
): Promise<{ id: number; created: boolean } | null> {
  const tenantId = integration.tenantId;
  const phone = normalizeToE164(ev.customer?.phone ?? null);
  const email = ev.customer?.email?.toLowerCase() ?? null;
  const name = ev.customer?.name ?? null;
  if (!phone && !email && !name) return null;

  const scope = tenantMatch(sosCustomersTable.tenantId, tenantId);
  if (phone) {
    const [byPhone] = await db
      .select({ id: sosCustomersTable.id })
      .from(sosCustomersTable)
      .where(and(scope, eq(sosCustomersTable.phone, phone)));
    if (byPhone) return { id: byPhone.id, created: false };
  }
  if (email) {
    const [byEmail] = await db
      .select({ id: sosCustomersTable.id })
      .from(sosCustomersTable)
      .where(and(scope, sql`lower(${sosCustomersTable.email}) = ${email}`));
    if (byEmail) return { id: byEmail.id, created: false };
  }
  if (name) {
    const [byName] = await db
      .select({ id: sosCustomersTable.id })
      .from(sosCustomersTable)
      .where(and(scope, sql`lower(${sosCustomersTable.name}) = lower(${name})`));
    if (byName) return { id: byName.id, created: false };
  }
  const [created] = await db
    .insert(sosCustomersTable)
    .values({
      tenantId,
      name: name ?? phone ?? email ?? "POS customer",
      phone,
      email: ev.customer?.email ?? null,
      // POS-sourced customers have not consented to SMS through us.
      smsOptIn: false,
    })
    .returning({ id: sosCustomersTable.id });
  return { id: created.id, created: true };
}

async function matchStaff(
  integration: PosIntegration,
  staffName: string | null
): Promise<number | null> {
  if (!staffName) return null;
  const [staff] = await db
    .select({ id: sosStaffMembersTable.id })
    .from(sosStaffMembersTable)
    .where(
      and(
        tenantMatch(sosStaffMembersTable.tenantId, integration.tenantId),
        eq(sosStaffMembersTable.isActive, true),
        sql`lower(${sosStaffMembersTable.name}) = lower(${staffName})`
      )
    );
  return staff?.id ?? null;
}

// ── per-kind effects ─────────────────────────────────────────────────────────

async function applyCheckIn(
  integration: PosIntegration,
  ev: NormalizedPosEvent,
  customerId: number
): Promise<{ visitId: number; detail: string }> {
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, customerId));
  const [visit] = await db
    .insert(sosVisitsTable)
    .values({
      customerId,
      tenantId: integration.tenantId,
      serviceType: ev.serviceType ?? "POS visit",
      partySize: 1,
    })
    .returning({ id: sosVisitsTable.id });
  await db
    .update(sosCustomersTable)
    .set({ visitCount: customer.visitCount + 1, lastVisitAt: new Date() })
    .where(eq(sosCustomersTable.id, customerId));
  return { visitId: visit.id, detail: `Checked in ${customer.name} (visit #${visit.id})` };
}

async function applyServiceCompleted(
  integration: PosIntegration,
  ev: NormalizedPosEvent,
  customerId: number
): Promise<{ visitId: number; detail: string }> {
  const tenantId = integration.tenantId;
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, customerId));

  // Advance the customer's most recent open visit; if the POS never sent a
  // check-in, create the visit on the spot so the completion still lands.
  const [openVisit] = await db
    .select()
    .from(sosVisitsTable)
    .where(
      and(
        eq(sosVisitsTable.customerId, customerId),
        tenantMatch(sosVisitsTable.tenantId, tenantId),
        ne(sosVisitsTable.status, "checked_out")
      )
    )
    .orderBy(desc(sosVisitsTable.checkedInAt), desc(sosVisitsTable.id))
    .limit(1);

  let visitId: number;
  let resourceId: number | null = null;
  if (openVisit) {
    visitId = openVisit.id;
    resourceId = openVisit.resourceId;
  } else {
    const [created] = await db
      .insert(sosVisitsTable)
      .values({
        customerId,
        tenantId,
        serviceType: ev.serviceType ?? "POS visit",
        partySize: 1,
      })
      .returning({ id: sosVisitsTable.id });
    visitId = created.id;
    await db
      .update(sosCustomersTable)
      .set({ visitCount: customer.visitCount + 1 })
      .where(eq(sosCustomersTable.id, customerId));
  }

  const staffId = await matchStaff(integration, ev.staffName);
  const now = new Date();

  // Co-op analytics attribution mirrors the native checkout path.
  await attachRevenueToRecentCrossoverSafe(tenantId, ev.paymentAmount ?? null);

  if (resourceId) {
    await db
      .update(sosResourcesTable)
      .set({ status: "cleaning", currentVisitId: null })
      .where(eq(sosResourcesTable.id, resourceId));
  }

  await db
    .update(sosVisitsTable)
    .set({
      status: "checked_out",
      checkedOutAt: now,
      paymentAmount: ev.paymentAmount != null ? ev.paymentAmount.toFixed(2) : undefined,
      staffId: staffId ?? undefined,
      serviceType: ev.serviceType ?? undefined,
    })
    .where(eq(sosVisitsTable.id, visitId));

  // Native checkout side effects: last-visit stamp, concierge cadence, and
  // co-op perk pass grants — downstream behavior fires exactly as if the
  // visit were recorded natively.
  await db
    .update(sosCustomersTable)
    .set({ lastVisitAt: now })
    .where(eq(sosCustomersTable.id, customerId));
  const [fresh] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, customerId));
  const linkedProfileId = fresh.clientProfileId ?? (await autoLinkCustomer(fresh))?.id ?? null;
  await updateProfileCadence(linkedProfileId);
  const grant = await grantPerkPassesSafe({ tenantId, customerId });

  const bits = [
    `Completed visit #${visitId} for ${customer.name}`,
    ev.paymentAmount != null ? `$${ev.paymentAmount.toFixed(2)}` : null,
    staffId != null ? `staff: ${ev.staffName}` : ev.staffName ? `staff "${ev.staffName}" not matched` : null,
    grant.granted > 0 ? `${grant.granted} perk pass(es) granted` : null,
  ].filter(Boolean);
  return { visitId, detail: bits.join(" — ") };
}

async function applyPerkRedeemed(
  integration: PosIntegration,
  ev: NormalizedPosEvent
): Promise<{ status: string; detail: string }> {
  if (integration.tenantId == null) {
    return {
      status: "error",
      detail: "Perk redemption requires a tenant-scoped integration",
    };
  }
  const token = ev.perkToken?.trim() ?? "";
  if (!token || !isWalletPassToken(token)) {
    return { status: "error", detail: "Missing or unrecognized perk pass token" };
  }
  const row = await findWalletPass(token);
  if (!row) return { status: "error", detail: "Unknown perk pass token" };
  if (row.pass.redeemedAt != null) {
    return { status: "ignored", detail: "Pass was already redeemed" };
  }
  if (row.pass.expiresAt <= new Date()) {
    return { status: "error", detail: "Pass has expired" };
  }
  // Same integrity rule as the native /coop/redemptions path: only a business
  // that is a party to the partnership may redeem its passes. A leaked token
  // presented through some other tenant's POS is rejected without writes.
  if (
    integration.tenantId !== row.partnership.hostTenantId &&
    integration.tenantId !== row.partnership.partnerTenantId
  ) {
    return {
      status: "error",
      detail: "Only a business in this partnership can redeem this perk pass",
    };
  }
  // Conditional update is the single-use lock (same as the native
  // /coop/redemptions path): exactly one redeemer flips redeemed_at.
  const [redeemed] = await db
    .update(perkPassesTable)
    .set({ redeemedAt: new Date(), redeemedByTenantId: integration.tenantId })
    .where(and(eq(perkPassesTable.token, token), isNull(perkPassesTable.redeemedAt)))
    .returning();
  if (!redeemed) {
    return { status: "ignored", detail: "Pass was already redeemed" };
  }
  // Mirror into the shared redemption ledger for partner-side reporting.
  const [redemption] = await db
    .insert(coopPerkRedemptionsTable)
    .values({
      partnershipId: row.partnership.id,
      passCode: token,
      redeemedByTenantId: integration.tenantId,
    })
    .onConflictDoNothing()
    .returning();
  // Attribution: exactly one event per counted redemption (unique
  // redemption_id makes replays no-ops). The redeeming tenant is the
  // receiver; the other side of the partnership sent the customer.
  if (redemption) {
    const p = row.partnership;
    const direction: CoopDirection =
      integration.tenantId === p.hostTenantId ? "partner_to_host" : "host_to_partner";
    await db
      .insert(coopAttributionEventsTable)
      .values({
        redemptionId: redemption.id,
        partnershipId: p.id,
        direction,
        sendingTenantId: direction === "host_to_partner" ? p.hostTenantId : p.partnerTenantId,
        receivingTenantId: integration.tenantId,
      })
      .onConflictDoNothing();
    // Neighborhood Passport: stamp the redeeming business on the wallet
    // owner's passport, enriched with any customer contact on the POS event.
    await recordPassportStampSafe({
      redeemedByTenantId: integration.tenantId,
      redemptionId: redemption.id,
      person: {
        phone: row.pass.customerPhone,
        email: ev.customer?.email ?? null,
        name: row.pass.customerName ?? ev.customer?.name ?? null,
      },
    });
  }
  return { status: "processed", detail: `Perk pass ${token} redeemed` };
}

// ── pipeline entry ───────────────────────────────────────────────────────────

/**
 * Log + process one signature-verified webhook delivery. Idempotent: a retry
 * of an already-logged external event id is acknowledged as a duplicate.
 */
export async function processPosDelivery(
  integration: PosIntegration,
  rawPayload: string
): Promise<PosProcessResult> {
  const vendor = integration.vendor as PosVendor;
  const stamp = async (patch: { lastError?: string | null }) => {
    await db
      .update(posIntegrationsTable)
      .set({ lastEventAt: new Date(), updatedAt: new Date(), ...patch })
      .where(eq(posIntegrationsTable.id, integration.id));
  };

  let parsed: unknown = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    parseError = "Payload is not valid JSON";
  }
  const ev = parseError == null ? translatePosPayload(vendor, parsed) : null;

  if (parseError != null || ev == null) {
    // Malformed — still logged and inspectable, never silently dropped. A
    // synthetic id keeps the idempotency constraint out of the way.
    const detail = parseError ?? "Malformed payload: missing vendor event id";
    const [row] = await db
      .insert(posInboundEventsTable)
      .values({
        integrationId: integration.id,
        tenantId: integration.tenantId,
        vendor,
        externalEventId: `invalid-${randomUUID()}`,
        eventKind: "unknown",
        status: "invalid",
        payload: rawPayload.slice(0, 20000),
        detail,
      })
      .returning({ id: posInboundEventsTable.id });
    await stamp({ lastError: detail });
    return { status: "invalid", detail, eventLogId: row.id };
  }

  // Idempotency lock: first delivery of this event id wins; retries no-op.
  const [logRow] = await db
    .insert(posInboundEventsTable)
    .values({
      integrationId: integration.id,
      tenantId: integration.tenantId,
      vendor,
      externalEventId: ev.externalEventId,
      eventKind: ev.kind,
      status: "received",
      payload: rawPayload.slice(0, 20000),
    })
    .onConflictDoNothing()
    .returning({ id: posInboundEventsTable.id });
  if (!logRow) {
    await stamp({});
    return {
      status: "duplicate",
      detail: `Event ${ev.externalEventId} already processed`,
      eventLogId: null,
    };
  }

  const finish = async (
    status: string,
    detail: string,
    refs: { customerId?: number | null; visitId?: number | null } = {}
  ): Promise<PosProcessResult> => {
    await db
      .update(posInboundEventsTable)
      .set({ status, detail, customerId: refs.customerId ?? null, visitId: refs.visitId ?? null })
      .where(eq(posInboundEventsTable.id, logRow.id));
    await stamp({ lastError: status === "error" ? detail : null });
    return { status, detail, eventLogId: logRow.id };
  };

  try {
    if (ev.kind === "unknown") {
      return await finish(
        "unrecognized",
        `Unrecognized vendor event type${ev.vendorEventType ? ` "${ev.vendorEventType}"` : ""}`
      );
    }
    if (ev.kind === "perk_redeemed") {
      const out = await applyPerkRedeemed(integration, ev);
      return await finish(out.status, out.detail);
    }
    const matched = await matchOrCreateCustomer(integration, ev);
    if (!matched) {
      return await finish("error", "Event has no identifiable customer (name, phone, or email)");
    }
    if (ev.kind === "check_in") {
      const out = await applyCheckIn(integration, ev, matched.id);
      return await finish("processed", out.detail, { customerId: matched.id, visitId: out.visitId });
    }
    const out = await applyServiceCompleted(integration, ev, matched.id);
    return await finish("processed", out.detail, { customerId: matched.id, visitId: out.visitId });
  } catch (err) {
    logger.error({ err, integrationId: integration.id }, "POS event processing failed");
    return await finish("error", err instanceof Error ? err.message : "Processing failed");
  }
}
