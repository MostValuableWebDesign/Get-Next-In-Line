import { Router, type IRouter } from "express";
import {
  db,
  sosSettingsTable,
  sosResourcesTable,
  sosCustomersTable,
  sosVisitsTable,
  sosAppointmentsTable,
  sosWaitlistTable,
  sosDepositHoldsTable,
  messagesTable,
  sosCallsTable,
  sosPlansTable,
  sosCustomerPlansTable,
  sosPlanTransactionsTable,
  clientProfilesTable,
  tenantsTable,
  type ClientProfile,
} from "@workspace/db";
import {
  GetSosDashboardResponse,
  GetSosSettingsResponse,
  UpdateSosSettingsBody,
  UpdateSosSettingsResponse,
  ListSosResourcesResponse,
  CreateSosResourceBody,
  CreateSosResourceResponse,
  UpdateSosResourceBody,
  UpdateSosResourceResponse,
  ListSosCustomersResponse,
  GetSosCustomerResponse,
  CreateSosCustomerBody,
  CreateSosCustomerResponse,
  UpdateSosCustomerBody,
  UpdateSosCustomerResponse,
  ListSosVisitsResponse,
  CheckInSosVisitBody,
  CheckInSosVisitResponse,
  AdvanceSosVisitBody,
  AdvanceSosVisitResponse,
  ListSosAppointmentsResponse,
  CreateSosAppointmentBody,
  CreateSosAppointmentResponse,
  CancelSosAppointmentResponse,
  MarkSosAppointmentNoShowResponse,
  ListSosWaitlistResponse,
  CreateSosWaitlistEntryBody,
  CreateSosWaitlistEntryResponse,
  ClaimSosWaitlistSlotResponse,
  ListSosMessagesResponse,
  SendSosMessageBody,
  SendSosMessageResponse,
  ListSosCallsResponse,
  SimulateSosCallBody,
  SimulateSosCallResponse,
  GetSosReportsSummaryResponse,
  GetSosCustomerTimelineResponse,
  ListSosPlansResponse,
  CreateSosPlanBody,
  CreateSosPlanResponse,
  UpdateSosPlanBody,
  UpdateSosPlanResponse,
  GetSosCustomerPlansResponse,
  SellSosPlanBody,
  SellSosPlanResponse,
  RenewSosCustomerPlanResponse,
  CancelSosCustomerPlanResponse,
} from "@workspace/api-zod";
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import twilio from "twilio";
import { getSmsStatus, getTwilioAuthToken, normalizeToE164 } from "../lib/sms";
import {
  sendMessage,
  sendMessageSafe,
  recordInboundMessage,
  applyDeliveryStatus,
} from "../lib/messaging";
import { parseCallIntent, parseServiceNames } from "../lib/receptionist";
import { parseInboundKeyword, getInboundWebhookUrl } from "../lib/inboundSms";
import { claimWaitlistSlot } from "../lib/waitlistClaim";
import {
  autoLinkCustomer,
  getLinkedProfile,
  syncLinkedProfile,
} from "../lib/customerLink";
import { logger } from "../lib/logger";
import {
  getLegacySettings,
  resolveSettings,
  serializeSettings,
  toSettingsColumnUpdates,
} from "../lib/settings";
import type { Request } from "express";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  placeDepositHoldIfActive,
  settleHoldOnCancellation,
  captureHoldForNoShow,
  serializeDepositHold,
  type DepositHoldRow,
} from "../lib/noShowShield";

const router: IRouter = Router();

// ── serializers ──────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

type CustomerRow = typeof sosCustomersTable.$inferSelect;
type VisitRow = typeof sosVisitsTable.$inferSelect;
type AppointmentRow = typeof sosAppointmentsTable.$inferSelect;

function serializeCustomer(c: CustomerRow, profile: ClientProfile | null = null) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    smsOptIn: c.smsOptIn,
    visitCount: c.visitCount,
    lastVisitAt: iso(c.lastVisitAt),
    createdAt: c.createdAt.toISOString(),
    clientProfileId: c.clientProfileId,
    // Marketing fields sourced from the linked concierge client profile.
    marketing:
      profile == null
        ? null
        : {
            clientProfileId: profile.id,
            tenantId: profile.tenantId,
            preferredChannel: profile.preferredChannel,
            smsOptIn: profile.smsOptIn,
            nextVisitAt: iso(profile.nextVisitAt),
            lastVisitAt: iso(profile.lastVisitAt),
            averageCycleDays: profile.averageCycleDays,
          },
  };
}

function serializeVisit(
  v: VisitRow,
  customerName: string,
  resourceName: string | null,
) {
  return {
    id: v.id,
    customerId: v.customerId,
    customerName,
    status: v.status,
    serviceType: v.serviceType,
    partySize: v.partySize,
    resourceId: v.resourceId,
    resourceName,
    estimatedWaitMinutes: v.estimatedWaitMinutes,
    paymentAmount: v.paymentAmount == null ? null : parseFloat(v.paymentAmount),
    checkedInAt: v.checkedInAt.toISOString(),
    serviceStartedAt: iso(v.serviceStartedAt),
    checkedOutAt: iso(v.checkedOutAt),
  };
}

function serializeAppointment(
  a: AppointmentRow,
  customerName: string,
  hold: DepositHoldRow | null = null,
) {
  return {
    id: a.id,
    customerId: a.customerId,
    customerName,
    serviceType: a.serviceType,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    status: a.status,
    source: a.source,
    resourceId: a.resourceId,
    notes: a.notes,
    deposit: serializeDepositHold(hold),
    createdAt: a.createdAt.toISOString(),
  };
}

async function getAppointmentWithName(id: number, tenantId: number | null) {
  const [row] = await db
    .select({
      appt: sosAppointmentsTable,
      customerName: sosCustomersTable.name,
      hold: sosDepositHoldsTable,
    })
    .from(sosAppointmentsTable)
    .innerJoin(
      sosCustomersTable,
      eq(sosAppointmentsTable.customerId, sosCustomersTable.id),
    )
    .leftJoin(
      sosDepositHoldsTable,
      eq(sosDepositHoldsTable.appointmentId, sosAppointmentsTable.id),
    )
    .where(
      and(
        eq(sosAppointmentsTable.id, id),
        tenantMatch(sosAppointmentsTable.tenantId, tenantId),
      ),
    );
  return row ?? null;
}

// Legacy/global settings record — used by the legacy /sos/settings endpoints.
const getSettings = getLegacySettings;

// ── tenant context ───────────────────────────────────────────────────────────

/**
 * Optional tenant context for SOS operational routes, passed as the
 * `x-tenant-id` header. When absent (or invalid), routes fall back to the
 * legacy scope: only NULL-tenant rows, never other tenants' data.
 */
function tenantIdFrom(req: Request): number | null {
  const raw = req.header("x-tenant-id");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Strict per-row tenant match: with tenant context only that tenant's rows
 * match; without it only legacy (NULL-tenant) rows match. Reads/writes must
 * never span tenants.
 */
function tenantMatch(column: PgColumn, tenantId: number | null) {
  return tenantId == null ? isNull(column) : eq(column, tenantId);
}

// ── waitlist fill engine ─────────────────────────────────────────────────────

async function broadcastOpenSlot(
  slotStart: Date,
  slotEnd: Date,
  service: string,
  tenantId: number | null,
) {
  // Only notify entries waiting for a matching service (case-insensitive)
  // within the same tenant scope as the cancelled appointment (legacy
  // NULL-tenant slots only reach legacy waitlist entries, and vice versa).
  const entries = await db
    .select({ entry: sosWaitlistTable, customer: sosCustomersTable })
    .from(sosWaitlistTable)
    .innerJoin(
      sosCustomersTable,
      eq(sosWaitlistTable.customerId, sosCustomersTable.id),
    )
    .where(
      and(
        eq(sosWaitlistTable.status, "waiting"),
        tenantMatch(sosWaitlistTable.tenantId, tenantId),
        sql`lower(${sosWaitlistTable.desiredService}) = lower(${service})`,
      ),
    )
    .orderBy(sosWaitlistTable.createdAt);

  let waitlistNotified = 0;
  let messagesSent = 0;
  const now = new Date();

  for (const { entry, customer } of entries) {
    await db
      .update(sosWaitlistTable)
      .set({
        status: "notified",
        notifiedAt: now,
        openSlotStartsAt: slotStart,
        openSlotEndsAt: slotEnd,
      })
      .where(eq(sosWaitlistTable.id, entry.id));
    waitlistNotified++;

    if (customer.smsOptIn && customer.phone) {
      // Safe send: an SMS/infra failure must not abort the broadcast loop —
      // the entry is already marked notified and the outcome is recorded.
      await sendMessageSafe({
        tenantId,
        customerId: customer.id,
        toNumber: customer.phone,
        kind: "slot_open",
        body: `Good news ${customer.name}! A ${service} slot just opened at ${slotStart.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}. Reply YES to this text to claim it — first come, first served.`,
      });
      messagesSent++;
    }
  }
  return { waitlistNotified, messagesSent };
}

// ── dashboard ────────────────────────────────────────────────────────────────

router.get("/sos/dashboard", async (req, res): Promise<void> => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  // Scope all operational metrics strictly: the tenant's rows under tenant
  // context, legacy NULL-tenant rows otherwise.
  const tenantId = tenantIdFrom(req);
  const scope = (col: PgColumn) => tenantMatch(col, tenantId);

  const [visits, resources, waitlist] = await Promise.all([
    db
      .select()
      .from(sosVisitsTable)
      .where(and(ne(sosVisitsTable.status, "checked_out"), scope(sosVisitsTable.tenantId))),
    db.select().from(sosResourcesTable).where(scope(sosResourcesTable.tenantId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sosWaitlistTable)
      .where(and(eq(sosWaitlistTable.status, "waiting"), scope(sosWaitlistTable.tenantId))),
  ]);

  const [apptsToday, msgsToday, callsToday, revenueRows, waitRows] =
    await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosAppointmentsTable)
        .where(
          and(
            gte(sosAppointmentsTable.startsAt, startOfDay),
            ne(sosAppointmentsTable.status, "cancelled"),
            scope(sosAppointmentsTable.tenantId),
          ),
        ),
      // Operational messages only (origin distinguishes them from concierge
      // automation sends), scoped strictly by the message's own tenant stamp.
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(messagesTable)
        .where(
          and(
            gte(messagesTable.createdAt, startOfDay),
            eq(messagesTable.origin, "operational"),
            scope(messagesTable.tenantId),
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosCallsTable)
        .where(and(gte(sosCallsTable.createdAt, startOfDay), scope(sosCallsTable.tenantId))),
      db
        .select({
          total: sql<string>`coalesce(sum(${sosVisitsTable.paymentAmount}), 0)`,
        })
        .from(sosVisitsTable)
        .where(and(gte(sosVisitsTable.checkedInAt, startOfDay), scope(sosVisitsTable.tenantId))),
      db
        .select({
          avg: sql<string>`coalesce(avg(extract(epoch from (${sosVisitsTable.serviceStartedAt} - ${sosVisitsTable.checkedInAt})) / 60), 0)`,
        })
        .from(sosVisitsTable)
        .where(and(sql`${sosVisitsTable.serviceStartedAt} is not null`, scope(sosVisitsTable.tenantId))),
    ]);

  const queueStatuses = ["checked_in", "queued", "assigned", "notified"];
  res.json(
    GetSosDashboardResponse.parse({
      inQueue: visits.filter((v) => queueStatuses.includes(v.status)).length,
      inService: visits.filter((v) => v.status === "in_service" || v.status === "payment").length,
      availableResources: resources.filter((r) => r.status === "available").length,
      totalResources: resources.length,
      avgWaitMinutes: Math.round(parseFloat(waitRows[0].avg) * 10) / 10,
      appointmentsToday: apptsToday[0].n,
      waitlistWaiting: waitlist[0].n,
      messagesSentToday: msgsToday[0].n,
      callsHandledToday: callsToday[0].n,
      revenueToday: parseFloat(revenueRows[0].total),
    }),
  );
});

// ── settings ─────────────────────────────────────────────────────────────────

// Legacy global settings (single-tenant SOS operations, tenant_id IS NULL).
router.get("/sos/settings", async (_req, res): Promise<void> => {
  const s = await getSettings();
  res.json(GetSosSettingsResponse.parse(await serializeSettings(s)));
});

router.patch("/sos/settings", async (req, res): Promise<void> => {
  const body = UpdateSosSettingsBody.parse(req.body);
  const s = await getSettings();
  const [updated] = await db
    .update(sosSettingsTable)
    .set({ ...toSettingsColumnUpdates(body), updatedAt: new Date() })
    .where(eq(sosSettingsTable.id, s.id))
    .returning();
  res.json(UpdateSosSettingsResponse.parse(await serializeSettings(updated)));
});

// ── resources ────────────────────────────────────────────────────────────────

async function serializeResources(tenantId: number | null) {
  const rows = await db
    .select()
    .from(sosResourcesTable)
    .where(tenantMatch(sosResourcesTable.tenantId, tenantId))
    .orderBy(sosResourcesTable.id);
  const visitIds = rows.map((r) => r.currentVisitId).filter((x): x is number => x != null);
  const nameByVisit = new Map<number, string>();
  if (visitIds.length > 0) {
    const visits = await db
      .select({ id: sosVisitsTable.id, name: sosCustomersTable.name })
      .from(sosVisitsTable)
      .innerJoin(sosCustomersTable, eq(sosVisitsTable.customerId, sosCustomersTable.id))
      .where(inArray(sosVisitsTable.id, visitIds));
    for (const v of visits) nameByVisit.set(v.id, v.name);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    resourceType: r.resourceType,
    status: r.status,
    currentVisitId: r.currentVisitId,
    currentCustomerName: r.currentVisitId ? (nameByVisit.get(r.currentVisitId) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

router.get("/sos/resources", async (req, res): Promise<void> => {
  res.json(ListSosResourcesResponse.parse(await serializeResources(tenantIdFrom(req))));
});

router.post("/sos/resources", async (req, res): Promise<void> => {
  const body = CreateSosResourceBody.parse(req.body);
  const [row] = await db
    .insert(sosResourcesTable)
    .values({ ...body, tenantId: tenantIdFrom(req) })
    .returning();
  res.status(201).json(
    CreateSosResourceResponse.parse({
      id: row.id,
      name: row.name,
      resourceType: row.resourceType,
      status: row.status,
      currentVisitId: row.currentVisitId,
      currentCustomerName: null,
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

router.patch("/sos/resources/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = UpdateSosResourceBody.parse(req.body);
  const [row] = await db
    .update(sosResourcesTable)
    .set(body)
    .where(and(eq(sosResourcesTable.id, id), tenantMatch(sosResourcesTable.tenantId, tenantIdFrom(req))))
    .returning();
  if (!row) {
    res.status(404).json({ message: "Resource not found" });
    return;
  }
  res.json(
    UpdateSosResourceResponse.parse({
      id: row.id,
      name: row.name,
      resourceType: row.resourceType,
      status: row.status,
      currentVisitId: row.currentVisitId,
      currentCustomerName: null,
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

router.delete("/sos/resources/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .delete(sosResourcesTable)
    .where(and(eq(sosResourcesTable.id, id), tenantMatch(sosResourcesTable.tenantId, tenantIdFrom(req))))
    .returning({ id: sosResourcesTable.id });
  if (!row) {
    res.status(404).json({ message: "Resource not found" });
    return;
  }
  res.status(204).send();
});

// ── customers ────────────────────────────────────────────────────────────────

router.get("/sos/customers", async (req, res): Promise<void> => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const tenantId = tenantIdFrom(req);
  const rows = await db
    .select({ customer: sosCustomersTable, profile: clientProfilesTable })
    .from(sosCustomersTable)
    .leftJoin(
      clientProfilesTable,
      eq(sosCustomersTable.clientProfileId, clientProfilesTable.id),
    )
    .where(
      and(
        search ? ilike(sosCustomersTable.name, `%${search}%`) : undefined,
        tenantMatch(sosCustomersTable.tenantId, tenantId),
      ),
    )
    .orderBy(desc(sosCustomersTable.createdAt));
  res.json(
    ListSosCustomersResponse.parse(
      rows.map((r) => serializeCustomer(r.customer, r.profile)),
    ),
  );
});

router.get("/sos/customers/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .select({ customer: sosCustomersTable, profile: clientProfilesTable })
    .from(sosCustomersTable)
    .leftJoin(
      clientProfilesTable,
      eq(sosCustomersTable.clientProfileId, clientProfilesTable.id),
    )
    .where(and(eq(sosCustomersTable.id, id), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))));
  if (!row) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  res.json(GetSosCustomerResponse.parse(serializeCustomer(row.customer, row.profile)));
});

router.post("/sos/customers", async (req, res): Promise<void> => {
  const body = CreateSosCustomerBody.parse(req.body);
  const [row] = await db
    .insert(sosCustomersTable)
    .values({ ...body, tenantId: tenantIdFrom(req) })
    .returning();
  // Establish the concierge link by phone match when unambiguous.
  const profile = await autoLinkCustomer(row);
  const created = profile ? { ...row, clientProfileId: profile.id } : row;
  res
    .status(201)
    .json(CreateSosCustomerResponse.parse(serializeCustomer(created, profile)));
});

router.patch("/sos/customers/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = UpdateSosCustomerBody.parse(req.body);
  const [row] = await db
    .update(sosCustomersTable)
    .set(body)
    .where(and(eq(sosCustomersTable.id, id), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))))
    .returning();
  if (!row) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  let profile: ClientProfile | null = null;
  if (row.clientProfileId != null) {
    // Keep the linked concierge profile consistent with contact/opt-in edits.
    await syncLinkedProfile(row.clientProfileId, {
      name: body.name,
      phone: body.phone,
      email: body.email,
      smsOptIn: body.smsOptIn,
    });
    profile = await getLinkedProfile(row.clientProfileId);
  } else if (body.phone !== undefined) {
    // A phone edit may make an unlinked customer linkable.
    profile = await autoLinkCustomer(row);
    if (profile) row.clientProfileId = profile.id;
  }
  res.json(UpdateSosCustomerResponse.parse(serializeCustomer(row, profile)));
});

// ── unified customer communications timeline ────────────────────────────────

type TimelineEntry = {
  id: string;
  channel: "ai_call" | "sms" | "concierge";
  kind: string;
  direction: "inbound" | "outbound";
  status: string;
  timestamp: string;
  body: string | null;
};

// Merges AI receptionist calls, SOS SMS, and concierge automated messages
// into one chronological feed, matched by customer id, linked concierge
// profile, and normalized phone number.
router.get("/sos/customers/:id/timeline", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(and(eq(sosCustomersTable.id, id), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }

  const phone = normalizeToE164(customer.phone);

  const [calls, messages] = await Promise.all([
    // Calls only carry a phone number; match by normalized phone within the
    // customer's own tenant scope (strict: legacy customers only match
    // legacy calls) so shared numbers never pull in another tenant's calls.
    phone
      ? db
          .select()
          .from(sosCallsTable)
          .where(tenantMatch(sosCallsTable.tenantId, customer.tenantId))
          .orderBy(desc(sosCallsTable.createdAt))
      : Promise.resolve([] as (typeof sosCallsTable.$inferSelect)[]),
    // Unified messages table holds both SOS SMS and concierge automation
    // sends: linked by customer id, linked concierge profile, or to-number.
    // sends: linked by customer id, linked concierge profile, or to-number —
    // always within the customer's own tenant scope so one business's texts
    // never surface on another business's timeline.
    db
      .select()
      .from(messagesTable)
      .where(
        and(
          tenantMatch(messagesTable.tenantId, customer.tenantId),
          sql`(${messagesTable.customerId} = ${id}
            or ${customer.clientProfileId != null ? sql`${messagesTable.clientProfileId} = ${customer.clientProfileId}` : sql`false`}
            or ${phone ? sql`${messagesTable.toNumber} is not null` : sql`false`})`,
        ),
      )
      .orderBy(desc(messagesTable.createdAt)),
  ]);

  const entries: TimelineEntry[] = [];

  for (const c of calls) {
    if (normalizeToE164(c.fromNumber) !== phone) continue;
    entries.push({
      id: `call-${c.id}`,
      channel: "ai_call",
      kind: c.outcome,
      direction: "inbound",
      status: c.outcome,
      timestamp: c.createdAt.toISOString(),
      body: c.transcriptSummary ?? c.intent,
    });
  }

  for (const m of messages) {
    const matches =
      m.customerId === id ||
      (customer.clientProfileId != null &&
        m.clientProfileId === customer.clientProfileId) ||
      (phone != null && normalizeToE164(m.toNumber) === phone);
    if (!matches) continue;
    const isConcierge = m.origin === "concierge";
    entries.push({
      id: isConcierge ? `concierge-${m.id}` : `sms-${m.id}`,
      channel: isConcierge ? "concierge" : "sms",
      kind: m.kind,
      direction: m.direction === "inbound" ? "inbound" : "outbound",
      status: m.status,
      timestamp: m.createdAt.toISOString(),
      body: m.body || null,
    });
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  res.json(GetSosCustomerTimelineResponse.parse(entries));
});

// ── memberships, packages & credit passes ───────────────────────────────────

type PlanRow = typeof sosPlansTable.$inferSelect;
type CustomerPlanRow = typeof sosCustomerPlansTable.$inferSelect;

function serializePlan(p: PlanRow) {
  return {
    id: p.id,
    name: p.name,
    planType: p.planType,
    description: p.description,
    price: parseFloat(p.price),
    billingInterval: p.billingInterval,
    discountPercent: p.discountPercent,
    creditCount: p.creditCount,
    isActive: p.isActive,
    createdAt: p.createdAt.toISOString(),
  };
}

function serializeCustomerPlan(cp: CustomerPlanRow, plan: PlanRow) {
  return {
    id: cp.id,
    customerId: cp.customerId,
    planId: cp.planId,
    planName: plan.name,
    planType: plan.planType,
    price: parseFloat(plan.price),
    billingInterval: plan.billingInterval,
    discountPercent: plan.discountPercent,
    status: cp.status,
    remainingCredits: cp.remainingCredits,
    renewsAt: iso(cp.renewsAt),
    purchasedAt: cp.purchasedAt.toISOString(),
    cancelledAt: iso(cp.cancelledAt),
  };
}

function nextRenewalDate(interval: string | null, from: Date): Date {
  const d = new Date(from);
  if (interval === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

router.get("/sos/plans", async (_req, res): Promise<void> => {
  const rows = await db.select().from(sosPlansTable).orderBy(sosPlansTable.id);
  res.json(ListSosPlansResponse.parse(rows.map(serializePlan)));
});

router.post("/sos/plans", async (req, res): Promise<void> => {
  const body = CreateSosPlanBody.parse(req.body);
  if (body.planType === "membership" && body.discountPercent == null) {
    res.status(400).json({ message: "discountPercent is required for memberships" });
    return;
  }
  if (body.planType !== "membership" && body.creditCount == null) {
    res.status(400).json({ message: "creditCount is required for packages and passes" });
    return;
  }
  const [row] = await db
    .insert(sosPlansTable)
    .values({
      name: body.name,
      planType: body.planType,
      description: body.description ?? null,
      price: body.price.toFixed(2),
      billingInterval:
        body.planType === "membership" ? (body.billingInterval ?? "monthly") : null,
      discountPercent: body.planType === "membership" ? body.discountPercent : null,
      creditCount: body.planType === "membership" ? null : body.creditCount,
    })
    .returning();
  res.status(201).json(CreateSosPlanResponse.parse(serializePlan(row)));
});

router.patch("/sos/plans/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = UpdateSosPlanBody.parse(req.body);
  const updates: Partial<typeof sosPlansTable.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.price !== undefined) updates.price = body.price.toFixed(2);
  if (body.billingInterval !== undefined) updates.billingInterval = body.billingInterval;
  if (body.discountPercent !== undefined) updates.discountPercent = body.discountPercent;
  if (body.creditCount !== undefined) updates.creditCount = body.creditCount;
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  const [row] = await db
    .update(sosPlansTable)
    .set(updates)
    .where(eq(sosPlansTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ message: "Plan not found" });
    return;
  }
  res.json(UpdateSosPlanResponse.parse(serializePlan(row)));
});

router.get("/sos/customers/:id/plans", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [customer] = await db
    .select({ id: sosCustomersTable.id })
    .from(sosCustomersTable)
    .where(and(eq(sosCustomersTable.id, id), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const [plans, txns] = await Promise.all([
    db
      .select({ cp: sosCustomerPlansTable, plan: sosPlansTable })
      .from(sosCustomerPlansTable)
      .innerJoin(sosPlansTable, eq(sosCustomerPlansTable.planId, sosPlansTable.id))
      .where(eq(sosCustomerPlansTable.customerId, id))
      .orderBy(desc(sosCustomerPlansTable.purchasedAt)),
    db
      .select({ txn: sosPlanTransactionsTable, planName: sosPlansTable.name })
      .from(sosPlanTransactionsTable)
      .innerJoin(
        sosCustomerPlansTable,
        eq(sosPlanTransactionsTable.customerPlanId, sosCustomerPlansTable.id),
      )
      .innerJoin(sosPlansTable, eq(sosCustomerPlansTable.planId, sosPlansTable.id))
      .where(eq(sosPlanTransactionsTable.customerId, id))
      .orderBy(desc(sosPlanTransactionsTable.createdAt)),
  ]);
  res.json(
    GetSosCustomerPlansResponse.parse({
      plans: plans.map((r) => serializeCustomerPlan(r.cp, r.plan)),
      transactions: txns.map((r) => ({
        id: r.txn.id,
        customerPlanId: r.txn.customerPlanId,
        customerId: r.txn.customerId,
        planName: r.planName,
        visitId: r.txn.visitId,
        transactionType: r.txn.transactionType,
        amount: r.txn.amount == null ? null : parseFloat(r.txn.amount),
        creditsDelta: r.txn.creditsDelta,
        note: r.txn.note,
        createdAt: r.txn.createdAt.toISOString(),
      })),
    }),
  );
});

router.post("/sos/customer-plans", async (req, res): Promise<void> => {
  const body = SellSosPlanBody.parse(req.body);
  const [[customer], [plan]] = await Promise.all([
    db
      .select()
      .from(sosCustomersTable)
      .where(
        and(
          eq(sosCustomersTable.id, body.customerId),
          tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req)),
        ),
      ),
    db.select().from(sosPlansTable).where(eq(sosPlansTable.id, body.planId)),
  ]);
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  if (!plan || !plan.isActive) {
    res.status(404).json({ message: "Plan not found or inactive" });
    return;
  }
  const now = new Date();
  const [cp] = await db
    .insert(sosCustomerPlansTable)
    .values({
      customerId: customer.id,
      planId: plan.id,
      status: "active",
      remainingCredits: plan.planType === "membership" ? null : plan.creditCount,
      renewsAt:
        plan.planType === "membership"
          ? nextRenewalDate(plan.billingInterval, now)
          : null,
    })
    .returning();
  await db.insert(sosPlanTransactionsTable).values({
    customerPlanId: cp.id,
    customerId: customer.id,
    transactionType: "purchase",
    amount: plan.price,
    creditsDelta: plan.planType === "membership" ? null : plan.creditCount,
    note: `Purchased ${plan.name}`,
  });
  res.status(201).json(SellSosPlanResponse.parse(serializeCustomerPlan(cp, plan)));
});

async function getCustomerPlanWithPlan(id: number, tenantId: number | null) {
  // Enrollments have no tenant column; they inherit scope from the customer.
  const [row] = await db
    .select({ cp: sosCustomerPlansTable, plan: sosPlansTable })
    .from(sosCustomerPlansTable)
    .innerJoin(sosPlansTable, eq(sosCustomerPlansTable.planId, sosPlansTable.id))
    .innerJoin(
      sosCustomersTable,
      eq(sosCustomerPlansTable.customerId, sosCustomersTable.id),
    )
    .where(
      and(
        eq(sosCustomerPlansTable.id, id),
        tenantMatch(sosCustomersTable.tenantId, tenantId),
      ),
    );
  return row ?? null;
}

router.post("/sos/customer-plans/:id/renew", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const found = await getCustomerPlanWithPlan(id, tenantIdFrom(req));
  if (!found) {
    res.status(404).json({ message: "Enrollment not found" });
    return;
  }
  const { cp, plan } = found;
  if (plan.planType !== "membership" || cp.status === "cancelled") {
    res.status(409).json({ message: "Enrollment is not renewable" });
    return;
  }
  // Renew from the current renewal date when still in the future (early
  // renewal extends), otherwise from now (past-due renewal restarts).
  const now = new Date();
  const base = cp.renewsAt && cp.renewsAt > now ? cp.renewsAt : now;
  const [updated] = await db
    .update(sosCustomerPlansTable)
    .set({ status: "active", renewsAt: nextRenewalDate(plan.billingInterval, base) })
    .where(eq(sosCustomerPlansTable.id, id))
    .returning();
  await db.insert(sosPlanTransactionsTable).values({
    customerPlanId: cp.id,
    customerId: cp.customerId,
    transactionType: "renewal",
    amount: plan.price,
    note: `Renewed ${plan.name}`,
  });
  res.json(RenewSosCustomerPlanResponse.parse(serializeCustomerPlan(updated, plan)));
});

router.post("/sos/customer-plans/:id/cancel", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const found = await getCustomerPlanWithPlan(id, tenantIdFrom(req));
  if (!found) {
    res.status(404).json({ message: "Enrollment not found" });
    return;
  }
  const { cp, plan } = found;
  if (cp.status === "cancelled") {
    res.status(409).json({ message: "Enrollment already cancelled" });
    return;
  }
  const [updated] = await db
    .update(sosCustomerPlansTable)
    .set({ status: "cancelled", cancelledAt: new Date() })
    .where(eq(sosCustomerPlansTable.id, id))
    .returning();
  await db.insert(sosPlanTransactionsTable).values({
    customerPlanId: cp.id,
    customerId: cp.customerId,
    transactionType: "cancellation",
    note: `Cancelled ${plan.name}`,
  });
  res.json(CancelSosCustomerPlanResponse.parse(serializeCustomerPlan(updated, plan)));
});

// ── visits (customer journey state machine) ──────────────────────────────────

async function serializeVisits(activeOnly: boolean, tenantId: number | null) {
  const rows = await db
    .select({
      visit: sosVisitsTable,
      customerName: sosCustomersTable.name,
      resourceName: sosResourcesTable.name,
    })
    .from(sosVisitsTable)
    .innerJoin(sosCustomersTable, eq(sosVisitsTable.customerId, sosCustomersTable.id))
    .leftJoin(sosResourcesTable, eq(sosVisitsTable.resourceId, sosResourcesTable.id))
    .where(
      and(
        activeOnly ? ne(sosVisitsTable.status, "checked_out") : undefined,
        tenantMatch(sosVisitsTable.tenantId, tenantId),
      ),
    )
    .orderBy(sosVisitsTable.checkedInAt);
  return rows.map((r) => serializeVisit(r.visit, r.customerName, r.resourceName));
}

router.get("/sos/visits", async (req, res): Promise<void> => {
  const active = req.query.active === "true";
  res.json(ListSosVisitsResponse.parse(await serializeVisits(active, tenantIdFrom(req))));
});

router.post("/sos/visits", async (req, res): Promise<void> => {
  const body = CheckInSosVisitBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(and(eq(sosCustomersTable.id, body.customerId), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const [row] = await db
    .insert(sosVisitsTable)
    .values({
      customerId: body.customerId,
      // Visits belong to the customer's tenant (header as fallback for
      // legacy customers checked in under tenant context).
      tenantId: customer.tenantId ?? tenantIdFrom(req),
      serviceType: body.serviceType,
      partySize: body.partySize ?? 1,
      estimatedWaitMinutes: body.estimatedWaitMinutes ?? null,
    })
    .returning();
  await db
    .update(sosCustomersTable)
    .set({ visitCount: customer.visitCount + 1, lastVisitAt: new Date() })
    .where(eq(sosCustomersTable.id, customer.id));
  res
    .status(201)
    .json(CheckInSosVisitResponse.parse(serializeVisit(row, customer.name, null)));
});

const VISIT_TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  queue: { from: ["checked_in"], to: "queued" },
  assign: { from: ["checked_in", "queued"], to: "assigned" },
  notify: { from: ["assigned"], to: "notified" },
  start_service: { from: ["assigned", "notified"], to: "in_service" },
  request_payment: { from: ["in_service"], to: "payment" },
  check_out: { from: ["payment", "in_service"], to: "checked_out" },
};

router.post("/sos/visits/:id/advance", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = AdvanceSosVisitBody.parse(req.body);

  const [found] = await db
    .select({ visit: sosVisitsTable, customer: sosCustomersTable })
    .from(sosVisitsTable)
    .innerJoin(sosCustomersTable, eq(sosVisitsTable.customerId, sosCustomersTable.id))
    .where(and(eq(sosVisitsTable.id, id), tenantMatch(sosVisitsTable.tenantId, tenantIdFrom(req))));
  if (!found) {
    res.status(404).json({ message: "Visit not found" });
    return;
  }
  const { visit, customer } = found;

  const transition = VISIT_TRANSITIONS[body.action];
  if (!transition.from.includes(visit.status)) {
    res.status(409).json({
      message: `Cannot ${body.action} a visit in status "${visit.status}"`,
    });
    return;
  }

  const updates: Partial<typeof sosVisitsTable.$inferInsert> = {
    status: transition.to,
  };

  if (body.action === "assign") {
    if (!body.resourceId) {
      res.status(400).json({ message: "resourceId is required to assign" });
      return;
    }
    // Conditional update guards against two visits claiming the same
    // resource concurrently: only succeeds if the resource is still available.
    const [claimed] = await db
      .update(sosResourcesTable)
      .set({ status: "occupied", currentVisitId: visit.id })
      .where(
        and(
          eq(sosResourcesTable.id, body.resourceId),
          eq(sosResourcesTable.status, "available"),
          // A visit may only claim a resource in its own tenant scope.
          tenantMatch(sosResourcesTable.tenantId, tenantIdFrom(req)),
        ),
      )
      .returning({ id: sosResourcesTable.id });
    if (!claimed) {
      res.status(409).json({ message: "Resource is not available" });
      return;
    }
    updates.resourceId = body.resourceId;
  }

  if (body.action === "notify" && customer.smsOptIn && customer.phone) {
    // Safe send: a Twilio/infra failure is recorded on the message row but
    // must never block the visit's queue transition below.
    await sendMessageSafe({
      tenantId: customer.tenantId,
      customerId: customer.id,
      toNumber: customer.phone,
      kind: "you_are_next",
      body: `${customer.name}, you're up next! Please make your way over — we're ready for you.`,
    });
  }

  if (body.action === "start_service") {
    updates.serviceStartedAt = new Date();
  }

  if (body.action === "request_payment" || body.action === "check_out") {
    if (body.paymentAmount != null) {
      updates.paymentAmount = body.paymentAmount.toFixed(2);
    }
  }

  // Optional plan benefit at checkout: redeem a prepaid credit or apply a
  // membership discount. Validated before the visit transition is written.
  if (body.action === "check_out" && body.benefitCustomerPlanId != null) {
    if (!body.benefitType) {
      res.status(400).json({ message: "benefitType is required with benefitCustomerPlanId" });
      return;
    }
    const found = await getCustomerPlanWithPlan(body.benefitCustomerPlanId, tenantIdFrom(req));
    if (!found || found.cp.customerId !== visit.customerId) {
      res.status(404).json({ message: "Plan enrollment not found for this customer" });
      return;
    }
    if (found.cp.status === "cancelled") {
      res.status(409).json({ message: "Plan enrollment is cancelled" });
      return;
    }
    if (body.benefitType === "redeem_credit") {
      if (found.plan.planType === "membership") {
        res.status(409).json({ message: "Memberships have no credits to redeem" });
        return;
      }
      // Conditional decrement guards against two concurrent redemptions
      // spending the same last credit.
      const [spent] = await db
        .update(sosCustomerPlansTable)
        .set({ remainingCredits: sql`${sosCustomerPlansTable.remainingCredits} - 1` })
        .where(
          and(
            eq(sosCustomerPlansTable.id, found.cp.id),
            gte(sosCustomerPlansTable.remainingCredits, 1),
          ),
        )
        .returning({ remaining: sosCustomerPlansTable.remainingCredits });
      if (!spent) {
        res.status(409).json({ message: "No credits remaining on this plan" });
        return;
      }
      await db.insert(sosPlanTransactionsTable).values({
        customerPlanId: found.cp.id,
        customerId: visit.customerId,
        visitId: visit.id,
        transactionType: "redemption",
        creditsDelta: -1,
        note: `Redeemed 1 credit from ${found.plan.name} for ${visit.serviceType} (${spent.remaining} left)`,
      });
    } else {
      if (found.plan.planType !== "membership") {
        res.status(409).json({ message: "Only memberships grant a discount" });
        return;
      }
      await db.insert(sosPlanTransactionsTable).values({
        customerPlanId: found.cp.id,
        customerId: visit.customerId,
        visitId: visit.id,
        transactionType: "discount",
        amount: body.paymentAmount != null ? body.paymentAmount.toFixed(2) : null,
        note: `${found.plan.discountPercent}% ${found.plan.name} discount applied to ${visit.serviceType}`,
      });
    }
  }

  if (body.action === "check_out") {
    updates.checkedOutAt = new Date();
    if (visit.resourceId) {
      await db
        .update(sosResourcesTable)
        .set({ status: "cleaning", currentVisitId: null })
        .where(eq(sosResourcesTable.id, visit.resourceId));
    }
  }

  const [updated] = await db
    .update(sosVisitsTable)
    .set(updates)
    .where(eq(sosVisitsTable.id, id))
    .returning();

  const resourceName = updated.resourceId
    ? ((
        await db
          .select({ name: sosResourcesTable.name })
          .from(sosResourcesTable)
          .where(eq(sosResourcesTable.id, updated.resourceId))
      )[0]?.name ?? null)
    : null;

  res.json(
    AdvanceSosVisitResponse.parse(serializeVisit(updated, customer.name, resourceName)),
  );
});

// ── appointments + cancellation fill engine ──────────────────────────────────

router.get("/sos/appointments", async (req, res): Promise<void> => {
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  const tenantId = tenantIdFrom(req);
  const conditions = [];
  if (from && !isNaN(from.getTime())) conditions.push(gte(sosAppointmentsTable.startsAt, from));
  if (to && !isNaN(to.getTime())) conditions.push(lte(sosAppointmentsTable.startsAt, to));
  conditions.push(tenantMatch(sosAppointmentsTable.tenantId, tenantId));

  const rows = await db
    .select({
      appt: sosAppointmentsTable,
      customerName: sosCustomersTable.name,
      hold: sosDepositHoldsTable,
    })
    .from(sosAppointmentsTable)
    .innerJoin(sosCustomersTable, eq(sosAppointmentsTable.customerId, sosCustomersTable.id))
    .leftJoin(
      sosDepositHoldsTable,
      eq(sosDepositHoldsTable.appointmentId, sosAppointmentsTable.id),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sosAppointmentsTable.startsAt);

  res.json(
    ListSosAppointmentsResponse.parse(
      rows.map((r) => serializeAppointment(r.appt, r.customerName, r.hold)),
    ),
  );
});

router.post("/sos/appointments", async (req, res): Promise<void> => {
  const body = CreateSosAppointmentBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(and(eq(sosCustomersTable.id, body.customerId), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const [row] = await db
    .insert(sosAppointmentsTable)
    .values({
      customerId: body.customerId,
      tenantId: customer.tenantId ?? tenantIdFrom(req),
      serviceType: body.serviceType,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      resourceId: body.resourceId ?? null,
      notes: body.notes ?? null,
      source: body.source ?? "staff",
    })
    .returning();
  // No-Show Shield: records the policy agreement + deposit hold when active.
  const hold = await placeDepositHoldIfActive(row.id);
  res
    .status(201)
    .json(CreateSosAppointmentResponse.parse(serializeAppointment(row, customer.name, hold)));
});

router.post("/sos/appointments/:id/cancel", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const found = await getAppointmentWithName(id, tenantIdFrom(req));
  if (!found) {
    res.status(404).json({ message: "Appointment not found" });
    return;
  }
  if (found.appt.status !== "booked") {
    res.status(409).json({ message: `Appointment is already ${found.appt.status}` });
    return;
  }

  const [cancelled] = await db
    .update(sosAppointmentsTable)
    .set({ status: "cancelled" })
    .where(eq(sosAppointmentsTable.id, id))
    .returning();

  // No-Show Shield: outside the agreed window → release the hold;
  // inside it → capture the late-cancellation fee.
  const hold = await settleHoldOnCancellation(cancelled.id, cancelled.startsAt);

  // Auto-fill is governed by the settings of the tenant that owns the
  // cancelled appointment (legacy NULL-tenant appointments use the legacy
  // global settings record).
  const settings = await resolveSettings(cancelled.tenantId);
  let waitlistNotified = 0;
  let messagesSent = 0;
  if (settings.waitlistAutoFillEnabled) {
    const result = await broadcastOpenSlot(
      cancelled.startsAt,
      cancelled.endsAt,
      cancelled.serviceType,
      cancelled.tenantId,
    );
    waitlistNotified = result.waitlistNotified;
    messagesSent = result.messagesSent;
  }

  res.json(
    CancelSosAppointmentResponse.parse({
      appointment: serializeAppointment(cancelled, found.customerName, hold),
      waitlistNotified,
      messagesSent,
    }),
  );
});

// Mark a booked appointment as a no-show — captures the held deposit (if
// any) as the agreed penalty fee.
router.post("/sos/appointments/:id/no-show", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const found = await getAppointmentWithName(id, tenantIdFrom(req));
  if (!found) {
    res.status(404).json({ message: "Appointment not found" });
    return;
  }
  if (found.appt.status !== "booked") {
    res.status(409).json({ message: `Appointment is already ${found.appt.status}` });
    return;
  }

  const [updated] = await db
    .update(sosAppointmentsTable)
    .set({ status: "no_show" })
    .where(eq(sosAppointmentsTable.id, id))
    .returning();
  const hold = await captureHoldForNoShow(id);

  res.json(
    MarkSosAppointmentNoShowResponse.parse(
      serializeAppointment(updated, found.customerName, hold),
    ),
  );
});

// ── waitlist ─────────────────────────────────────────────────────────────────

async function serializeWaitlist(tenantId: number | null) {
  const rows = await db
    .select({ entry: sosWaitlistTable, customer: sosCustomersTable })
    .from(sosWaitlistTable)
    .innerJoin(sosCustomersTable, eq(sosWaitlistTable.customerId, sosCustomersTable.id))
    .where(tenantMatch(sosWaitlistTable.tenantId, tenantId))
    .orderBy(desc(sosWaitlistTable.createdAt));
  return rows.map(({ entry, customer }) => ({
    id: entry.id,
    customerId: entry.customerId,
    customerName: customer.name,
    customerPhone: customer.phone,
    desiredService: entry.desiredService,
    status: entry.status,
    notifiedAt: iso(entry.notifiedAt),
    openSlotStartsAt: iso(entry.openSlotStartsAt),
    openSlotEndsAt: iso(entry.openSlotEndsAt),
    createdAt: entry.createdAt.toISOString(),
  }));
}

router.get("/sos/waitlist", async (req, res): Promise<void> => {
  res.json(ListSosWaitlistResponse.parse(await serializeWaitlist(tenantIdFrom(req))));
});

router.post("/sos/waitlist", async (req, res): Promise<void> => {
  const body = CreateSosWaitlistEntryBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(and(eq(sosCustomersTable.id, body.customerId), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const [row] = await db
    .insert(sosWaitlistTable)
    .values({ ...body, tenantId: customer.tenantId ?? tenantIdFrom(req) })
    .returning();
  res.status(201).json(
    CreateSosWaitlistEntryResponse.parse({
      id: row.id,
      customerId: row.customerId,
      customerName: customer.name,
      customerPhone: customer.phone,
      desiredService: row.desiredService,
      status: row.status,
      notifiedAt: iso(row.notifiedAt),
      openSlotStartsAt: iso(row.openSlotStartsAt),
      openSlotEndsAt: iso(row.openSlotEndsAt),
      createdAt: row.createdAt.toISOString(),
    }),
  );
});

router.post("/sos/waitlist/:id/claim", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const result = await claimWaitlistSlot(id, { tenantId: tenantIdFrom(req) });
  switch (result.outcome) {
    case "not_found":
      res.status(404).json({ message: "Waitlist entry not found" });
      return;
    case "no_slot_held":
      res.status(409).json({ message: "No open slot is held for this entry" });
      return;
    case "already_claimed":
      res.status(409).json({ message: "Slot was already claimed" });
      return;
    case "claimed":
      res.json(
        ClaimSosWaitlistSlotResponse.parse(
          serializeAppointment(result.appointment, result.customer.name, result.depositHold),
        ),
      );
      return;
  }
});

// ── messages ─────────────────────────────────────────────────────────────────

type MessageRow = typeof messagesTable.$inferSelect;

/** Serialize a unified messages row in the stable SOS message shape. */
function serializeSosMessage(msg: MessageRow, customerName: string | null) {
  return {
    id: msg.id,
    customerId: msg.customerId,
    customerName,
    toNumber: msg.toNumber,
    direction: msg.direction,
    body: msg.body,
    kind: msg.kind,
    deliveryStatus: msg.status,
    providerSid: msg.providerSid,
    errorCode: msg.errorCode,
    errorMessage: msg.errorMessage,
    createdAt: msg.createdAt.toISOString(),
  };
}

router.get("/sos/messages", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  // Operational (SOS) messages only: concierge automation sends are surfaced
  // by the automation report instead. Origin classifies the surface; the
  // message's own tenant stamp scopes it (strict NULL-vs-tenant semantics —
  // legacy NULL-tenant messages only appear in the legacy view).
  const tenantId = tenantIdFrom(req);
  const rows = await db
    .select({ msg: messagesTable, customerName: sosCustomersTable.name })
    .from(messagesTable)
    .leftJoin(sosCustomersTable, eq(messagesTable.customerId, sosCustomersTable.id))
    .where(
      and(
        eq(messagesTable.origin, "operational"),
        tenantMatch(messagesTable.tenantId, tenantId),
      ),
    )
    .orderBy(desc(messagesTable.createdAt))
    .limit(limit);
  res.json(
    ListSosMessagesResponse.parse(
      rows.map(({ msg, customerName }) => serializeSosMessage(msg, customerName)),
    ),
  );
});

router.post("/sos/messages", async (req, res): Promise<void> => {
  const body = SendSosMessageBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(and(eq(sosCustomersTable.id, body.customerId), tenantMatch(sosCustomersTable.tenantId, tenantIdFrom(req))));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  // Manual sends/replies respect the customer's SMS opt-in: an opted-out
  // customer must never receive staff-initiated texts.
  if (!customer.smsOptIn) {
    res.status(409).json({ message: "Customer has opted out of SMS" });
    return;
  }
  const msg = await sendMessage({
    tenantId: customer.tenantId,
    customerId: customer.id,
    toNumber: customer.phone,
    kind: body.kind ?? "manual",
    body: body.body,
  });
  res
    .status(201)
    .json(SendSosMessageResponse.parse(serializeSosMessage(msg, customer.name)));
});

// ── Twilio inbound SMS webhook ───────────────────────────────────────────────

/** Find a customer whose phone matches the (normalized) inbound From number. */
/**
 * Resolve the inbound sender to an SOS customer. The webhook has no tenant
 * context (per-tenant Twilio numbers are a separate effort), so a phone number
 * that matches customers in more than one tenant scope is ambiguous: we fail
 * safe and return null (log-only, no opt-in change or claim) rather than
 * mutate the wrong tenant's customer.
 */
async function findCustomerByPhone(from: string | null) {
  if (!from) return null;
  const candidates = await db
    .select()
    .from(sosCustomersTable)
    .where(sql`${sosCustomersTable.phone} is not null`);
  const matches = candidates.filter((c) => normalizeToE164(c.phone) === from);
  if (matches.length === 0) return null;
  const scopes = new Set(matches.map((c) => c.tenantId ?? "legacy"));
  return scopes.size === 1 ? matches[0] : null;
}

/** Ids of concierge client profiles whose phone matches the inbound number. */
async function findClientProfileIdsByPhone(from: string | null): Promise<number[]> {
  if (!from) return [];
  const candidates = await db
    .select({ id: clientProfilesTable.id, phone: clientProfilesTable.phone })
    .from(clientProfilesTable)
    .where(sql`${clientProfilesTable.phone} is not null`);
  return candidates.filter((p) => normalizeToE164(p.phone) === from).map((p) => p.id);
}

/**
 * Apply an inbound STOP/START uniformly: the sender's operational (SOS)
 * customer record, its linked concierge profile, and any other concierge
 * profiles with the same phone number all change together, so opt-out covers
 * concierge automations too — not just SOS texts.
 */
async function applyOptInChange(
  customer: { id: number; clientProfileId: number | null } | null,
  fromNumber: string | null,
  smsOptIn: boolean,
): Promise<void> {
  if (customer) {
    await db
      .update(sosCustomersTable)
      .set({ smsOptIn })
      .where(eq(sosCustomersTable.id, customer.id));
    await syncLinkedProfile(customer.clientProfileId, { smsOptIn });
  }
  const profileIds = await findClientProfileIdsByPhone(fromNumber);
  const remaining = profileIds.filter((id) => id !== customer?.clientProfileId);
  if (remaining.length > 0) {
    await db
      .update(clientProfilesTable)
      .set({ smsOptIn, updatedAt: new Date() })
      .where(inArray(clientProfilesTable.id, remaining));
  }
}

const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

// Public endpoint Twilio calls when a text arrives ("A message comes in").
// Authenticated via Twilio's request signature, not the session — spoofed
// requests without a valid X-Twilio-Signature are rejected.
router.post("/sos/twilio/inbound", async (req, res): Promise<void> => {
  const authToken = await getTwilioAuthToken();
  if (!authToken) {
    logger.warn("Inbound SMS webhook hit but no Twilio auth token is configured");
    res.status(503).json({ message: "Inbound SMS is not configured" });
    return;
  }
  const signature = req.header("X-Twilio-Signature") ?? "";
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  if (!twilio.validateRequest(authToken, signature, url, params)) {
    logger.warn({ url }, "Rejected inbound SMS webhook: invalid Twilio signature");
    res.status(403).json({ message: "Invalid Twilio signature" });
    return;
  }

  const fromNumber = normalizeToE164(params.From) ?? params.From ?? null;
  const body = typeof params.Body === "string" ? params.Body : "";
  const customer = await findCustomerByPhone(normalizeToE164(params.From));

  // Every inbound text is recorded in the unified messages table, matched to
  // a customer when possible.
  await recordInboundMessage({
    tenantId: customer?.tenantId ?? null,
    customerId: customer?.id ?? null,
    clientProfileId: customer?.clientProfileId ?? null,
    fromNumber, // the sender — shown as the counterparty in the log
    body,
    providerSid: params.MessageSid ?? null,
  });

  const keyword = parseInboundKeyword(body);

  if (keyword === "stop") {
    // Applies to SOS texts AND concierge automations, even for senders who
    // only exist as a concierge client profile.
    await applyOptInChange(customer, fromNumber, false);
    logger.info(
      { customerId: customer?.id ?? null, fromNumber },
      "Sender opted out of SMS via STOP",
    );
    // Twilio sends its own compliance auto-reply for STOP; don't double-text.
    res.type("text/xml").send(twiml);
    return;
  }
  if (keyword === "start") {
    await applyOptInChange(customer, fromNumber, true);
    logger.info(
      { customerId: customer?.id ?? null, fromNumber },
      "Sender opted back in to SMS via START",
    );
    res.type("text/xml").send(twiml);
    return;
  }

  if (!customer) {
    // Unknown sender: logged above, no auto-response.
    res.type("text/xml").send(twiml);
    return;
  }

  if (keyword === "yes") {
    // Reply-to-claim: act on the customer's notified waitlist entry.
    const [notified] = await db
      .select()
      .from(sosWaitlistTable)
      .where(
        and(
          eq(sosWaitlistTable.customerId, customer.id),
          eq(sosWaitlistTable.status, "notified"),
        ),
      )
      .orderBy(desc(sosWaitlistTable.notifiedAt))
      .limit(1);

    if (notified) {
      // The webhook has no tenant header; the entry was already matched to
      // this customer, so claim within the entry's own tenant scope.
      const result = await claimWaitlistSlot(notified.id, { tenantId: notified.tenantId });
      if (result.outcome === "claimed") {
        const when = result.appointment.startsAt.toLocaleString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
        await sendMessage({
          tenantId: customer.tenantId,
          customerId: customer.id,
          toNumber: customer.phone,
          kind: "claim_confirmation",
          body: `You're in, ${customer.name}! Your ${result.appointment.serviceType} is booked for ${when}. See you then!`,
        });
      } else {
        await sendMessage({
          tenantId: customer.tenantId,
          customerId: customer.id,
          toNumber: customer.phone,
          kind: "claim_confirmation",
          body: `Sorry ${customer.name}, that slot was just claimed by someone else. You're still on the waitlist — we'll text you when the next one opens.`,
        });
      }
    } else {
      // A "YES" with no held slot: if they recently lost the race their entry
      // is back to "waiting" — let them know instead of staying silent.
      const [waiting] = await db
        .select()
        .from(sosWaitlistTable)
        .where(
          and(
            eq(sosWaitlistTable.customerId, customer.id),
            eq(sosWaitlistTable.status, "waiting"),
          ),
        )
        .limit(1);
      if (waiting) {
        await sendMessage({
          tenantId: customer.tenantId,
          customerId: customer.id,
          toNumber: customer.phone,
          kind: "claim_confirmation",
          body: `Sorry ${customer.name}, that slot was already claimed. You're still on the waitlist — we'll text you when the next one opens.`,
        });
      }
      // No waitlist entry at all: logged, no auto-response.
    }
  }
  // keyword === "none": logged, no auto-response.

  res.type("text/xml").send(twiml);
});

// ── Twilio delivery-status callback ─────────────────────────────────────────

// Public endpoint Twilio POSTs per-message delivery updates to (the
// StatusCallback URL passed on every send). Authenticated by Twilio's
// request signature, not the session.
router.post("/sos/twilio/status", async (req, res): Promise<void> => {
  const authToken = await getTwilioAuthToken();
  if (!authToken) {
    logger.warn("Status callback hit but no Twilio auth token is configured");
    res.status(503).json({ message: "SMS status callbacks are not configured" });
    return;
  }
  const signature = req.header("X-Twilio-Signature") ?? "";
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  if (!twilio.validateRequest(authToken, signature, url, params)) {
    logger.warn({ url }, "Rejected status callback: invalid Twilio signature");
    res.status(403).json({ message: "Invalid Twilio signature" });
    return;
  }

  const providerSid = params.MessageSid ?? params.SmsSid;
  const messageStatus = params.MessageStatus ?? params.SmsStatus;
  if (!providerSid || !messageStatus) {
    res.status(400).json({ message: "MessageSid and MessageStatus are required" });
    return;
  }

  const updated = await applyDeliveryStatus({
    providerSid,
    messageStatus,
    errorCode: params.ErrorCode ?? null,
    errorMessage: params.ErrorMessage ?? null,
  });
  if (updated) {
    logger.info(
      { providerSid, messageStatus, messageId: updated.id, status: updated.status },
      "Applied Twilio delivery status update",
    );
  }
  res.status(204).send();
});

// ── AI receptionist calls ────────────────────────────────────────────────────

function serializeCall(
  c: typeof sosCallsTable.$inferSelect,
  customerId: number | null = null,
) {
  return {
    id: c.id,
    fromNumber: c.fromNumber,
    customerId,
    callerName: c.callerName,
    intent: c.intent,
    transcriptSummary: c.transcriptSummary,
    outcome: c.outcome,
    appointmentId: c.appointmentId,
    createdAt: c.createdAt.toISOString(),
  };
}

/**
 * Map of normalized phone → customer id, for matching call logs to customers.
 * Scoped strictly to the tenant context (NULL matches only legacy customers)
 * so a shared phone number never links a call to another tenant's customer.
 */
async function customerIdByNormalizedPhone(
  tenantId: number | null,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: sosCustomersTable.id, phone: sosCustomersTable.phone })
    .from(sosCustomersTable)
    .where(
      and(
        sql`${sosCustomersTable.phone} is not null`,
        tenantMatch(sosCustomersTable.tenantId, tenantId),
      ),
    );
  const map = new Map<string, number>();
  for (const r of rows) {
    const normalized = normalizeToE164(r.phone);
    if (normalized && !map.has(normalized)) map.set(normalized, r.id);
  }
  return map;
}

router.get("/sos/calls", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const [rows, phoneMap] = await Promise.all([
    db
      .select()
      .from(sosCallsTable)
      .where(tenantMatch(sosCallsTable.tenantId, tenantId))
      .orderBy(desc(sosCallsTable.createdAt))
      .limit(100),
    customerIdByNormalizedPhone(tenantId),
  ]);
  res.json(
    ListSosCallsResponse.parse(
      rows.map((c) => {
        const normalized = normalizeToE164(c.fromNumber);
        return serializeCall(c, normalized ? (phoneMap.get(normalized) ?? null) : null);
      }),
    ),
  );
});

router.post("/sos/calls", async (req, res): Promise<void> => {
  const body = SimulateSosCallBody.parse(req.body);
  // The receptionist toggle and service vocabulary come from the calling
  // tenant's settings (legacy global record when no tenant context).
  const tenantId = tenantIdFrom(req);
  const settings = await resolveSettings(tenantId);
  if (!settings.aiReceptionistEnabled) {
    res.status(409).json({ message: "AI receptionist is disabled in settings" });
    return;
  }

  const parsed = await parseCallIntent(
    body.inquiry,
    body.callerName ?? null,
    new Date().toISOString(),
    parseServiceNames(settings.serviceNames),
  );

  // Find or create the customer by phone number, within the tenant scope.
  let [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(
      and(
        eq(sosCustomersTable.phone, body.fromNumber),
        tenantMatch(sosCustomersTable.tenantId, tenantId),
      ),
    );
  if (!customer) {
    [customer] = await db
      .insert(sosCustomersTable)
      .values({ name: body.callerName ?? "New Caller", phone: body.fromNumber, tenantId })
      .returning();
  }

  let outcome: "booked" | "followup_sms" | "message_taken" = "message_taken";
  let appointmentId: number | null = null;

  if (parsed.intent === "book_appointment") {
    const startsAt = parsed.requestedTime ? new Date(parsed.requestedTime) : null;
    if (startsAt && !isNaN(startsAt.getTime())) {
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      const [appt] = await db
        .insert(sosAppointmentsTable)
        .values({
          customerId: customer.id,
          tenantId,
          serviceType: parsed.serviceType ?? "General service",
          startsAt,
          endsAt,
          source: "ai_receptionist",
          notes: `Booked by AI receptionist. Caller said: "${body.inquiry.slice(0, 200)}"`,
        })
        .returning();
      appointmentId = appt.id;
      outcome = "booked";
      // No-Show Shield applies to AI-receptionist bookings too.
      await placeDepositHoldIfActive(appt.id);
      await sendMessageSafe({
        tenantId,
        customerId: customer.id,
        toNumber: body.fromNumber,
        kind: "ai_followup",
        body: `Hi ${customer.name}! Your ${appt.serviceType} is confirmed for ${startsAt.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Reply CHANGE to reschedule.`,
      });
    } else {
      outcome = "followup_sms";
      await sendMessageSafe({
        tenantId,
        customerId: customer.id,
        toNumber: body.fromNumber,
        kind: "ai_followup",
        body: `Hi ${customer.name}! Thanks for calling ${settings.businessName}. Tap here to pick a time that works for you, or reply with a preferred day and time.`,
      });
    }
  } else if (parsed.intent === "question" || parsed.intent === "reschedule") {
    outcome = "followup_sms";
    await sendMessageSafe({
      tenantId,
      customerId: customer.id,
      toNumber: body.fromNumber,
      kind: "ai_followup",
      body: `Hi ${customer.name}! Thanks for calling ${settings.businessName}. We received your message and a team member will text you back shortly.`,
    });
  }

  const [call] = await db
    .insert(sosCallsTable)
    .values({
      fromNumber: body.fromNumber,
      tenantId,
      callerName: body.callerName ?? null,
      intent: parsed.intent,
      transcriptSummary: parsed.summary,
      outcome,
      appointmentId,
    })
    .returning();

  res.status(201).json(SimulateSosCallResponse.parse(serializeCall(call, customer.id)));
});

// ── reports ──────────────────────────────────────────────────────────────────

router.get("/sos/reports/summary", async (_req, res): Promise<void> => {
  const since = new Date();
  since.setDate(since.getDate() - 13);
  since.setHours(0, 0, 0, 0);

  const [
    visitsByDay,
    waitRows,
    filled,
    cancelledCount,
    callOutcomes,
    revenue,
    automationByJobStatus,
    automationByDay,
  ] = await Promise.all([
      db
        .select({
          day: sql<string>`to_char(${sosVisitsTable.checkedInAt}, 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(sosVisitsTable)
        .where(gte(sosVisitsTable.checkedInAt, since))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({
          avg: sql<string>`coalesce(avg(extract(epoch from (${sosVisitsTable.serviceStartedAt} - ${sosVisitsTable.checkedInAt})) / 60), 0)`,
        })
        .from(sosVisitsTable)
        .where(sql`${sosVisitsTable.serviceStartedAt} is not null`),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosAppointmentsTable)
        .where(eq(sosAppointmentsTable.source, "waitlist_fill")),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosAppointmentsTable)
        .where(eq(sosAppointmentsTable.status, "cancelled")),
      db
        .select({
          outcome: sosCallsTable.outcome,
          count: sql<number>`count(*)::int`,
        })
        .from(sosCallsTable)
        .groupBy(sosCallsTable.outcome),
      db
        .select({
          total: sql<string>`coalesce(sum(${sosVisitsTable.paymentAmount}), 0)`,
        })
        .from(sosVisitsTable),
      db
        .select({
          jobType: messagesTable.kind,
          status: messagesTable.status,
          count: sql<number>`count(*)::int`,
        })
        .from(messagesTable)
        .where(and(gte(messagesTable.createdAt, since), eq(messagesTable.origin, "concierge")))
        .groupBy(messagesTable.kind, messagesTable.status),
      db
        .select({
          day: sql<string>`to_char(${messagesTable.createdAt}, 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(messagesTable)
        .where(and(gte(messagesTable.createdAt, since), eq(messagesTable.origin, "concierge")))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
    ]);

  // Fold job-type/status counts into per-job-type stats. "sent" (accepted by
  // Twilio), "delivered" (confirmed via status callback), and "simulated"
  // all count as delivered.
  const DELIVERED = new Set(["sent", "delivered", "simulated"]);
  const jobStats = new Map<
    string,
    { jobType: string; delivered: number; failed: number; skipped: number; pending: number; total: number }
  >();
  for (const row of automationByJobStatus) {
    let s = jobStats.get(row.jobType);
    if (!s) {
      s = { jobType: row.jobType, delivered: 0, failed: 0, skipped: 0, pending: 0, total: 0 };
      jobStats.set(row.jobType, s);
    }
    s.total += row.count;
    if (DELIVERED.has(row.status)) s.delivered += row.count;
    else if (row.status === "failed") s.failed += row.count;
    else if (row.status === "skipped") s.skipped += row.count;
    else s.pending += row.count;
  }
  const byJobType = [...jobStats.values()].sort((a, b) => b.total - a.total);
  const automation = {
    remindersSent: jobStats.get("send_reminder")?.delivered ?? 0,
    nudgesSent: jobStats.get("rebooking_nudge")?.delivered ?? 0,
    deliveredCount: byJobType.reduce((n, s) => n + s.delivered, 0),
    failedCount: byJobType.reduce((n, s) => n + s.failed, 0),
    skippedCount: byJobType.reduce((n, s) => n + s.skipped, 0),
    byJobType,
    messagesByDay: automationByDay,
  };

  const slotsFilled = filled[0].n;
  const cancelled = cancelledCount[0].n;
  res.json(
    GetSosReportsSummaryResponse.parse({
      visitsByDay,
      avgWaitMinutes: Math.round(parseFloat(waitRows[0].avg) * 10) / 10,
      slotsFilled,
      fillRate: cancelled > 0 ? Math.round((slotsFilled / cancelled) * 1000) / 10 : 0,
      callOutcomes,
      totalRevenue: parseFloat(revenue[0].total),
      automation,
    }),
  );
});

export default router;
