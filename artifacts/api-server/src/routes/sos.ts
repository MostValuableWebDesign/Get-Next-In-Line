import { Router, type IRouter } from "express";
import { webhookRateLimit } from "../middlewares/rateLimit";
import {
  db,
  sosSettingsTable,
  sosResourcesTable,
  sosCustomersTable,
  sosVisitsTable,
  sosStaffMembersTable,
  sosAppointmentsTable,
  sosWaitlistTable,
  sosDepositHoldsTable,
  messagesTable,
  sosCallsTable,
  sosServicesTable,
  sosPlansTable,
  sosCustomerPlansTable,
  sosPlanTransactionsTable,
  sosGratuityLedgerTable,
  sosTipPoolLedgerTable,
  clientProfilesTable,
  tenantsTable,
  merchantCoopPartnershipsTable,
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
  ListSosServicesResponse,
  CreateSosServiceBody,
  CreateSosServiceResponse,
  UpdateSosServiceBody,
  UpdateSosServiceResponse,
  ReorderSosServicesBody,
  ReorderSosServicesResponse,
  ListSosStaffResponse,
  CreateSosStaffMemberBody,
  CreateSosStaffMemberResponse,
  UpdateSosStaffMemberBody,
  UpdateSosStaffMemberResponse,
  VerifySosStaffLicenseBody,
  VerifySosStaffLicenseResponse,
  GetSosStaffEarningsResponse,
  GetSosGratuityConfigResponse,
  UpdateSosGratuityConfigBody,
  UpdateSosGratuityConfigResponse,
  GetSosGratuityLedgerResponse,
  GetSosTwilioWebhookStatusResponse,
  GetSosOnboardingResponse,
} from "@workspace/api-zod";
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import twilio from "twilio";
import { getSmsStatus, getTwilioAuthToken, getTwilioWebhookStatus, normalizeToE164 } from "../lib/sms";
import {
  sendMessage,
  sendMessageSafe,
  recordInboundMessage,
  applyDeliveryStatus,
} from "../lib/messaging";
import { recordLedgerEventsSafe } from "../lib/platformLedger";
import { parseCallIntent } from "../lib/receptionist";
import {
  listServicesForScope,
  getServiceNamesForScope,
  type SosServiceRow,
} from "../lib/serviceCatalog";
import { parseInboundKeyword, getInboundWebhookUrl } from "../lib/inboundSms";
import { handleInboundCoopFeedback } from "../lib/coopFeedback";
import { claimWaitlistSlot } from "../lib/waitlistClaim";
import { updateProfileCadence } from "../lib/visitCadence";
import {
  autoLinkCustomer,
  getLinkedProfile,
  syncLinkedProfile,
} from "../lib/customerLink";
import { logger } from "../lib/logger";
import { attachRevenueToRecentCrossoverSafe } from "../lib/coopEvents";
import {
  resolveTipRuleForVisit,
  tenantHasLivePartnership,
  writeGratuityLedger,
} from "../lib/tipPooling";
import { recordAmbassadorActivitySafe } from "../lib/ambassador";
import {
  sendBookingConfirmationEmailSafe,
  sendReceiptEmailSafe,
} from "../lib/transactionalEmail";
import { isValidEmail, publicAppBaseUrl } from "../lib/email";
import {
  addressFieldsTouched,
  resolveSettings,
  serializeSettings,
  toSettingsColumnUpdates,
} from "../lib/settings";
import { scheduleDensityDetection } from "../lib/geoDensity";
import type { Request } from "express";
import type { PgColumn } from "drizzle-orm/pg-core";
import { requireTenantScope } from "../lib/tenantScope";
import { grantPerkPassesSafe } from "../lib/perkPasses";
import {
  computeTipAllocations,
  isTipSplitRule,
  resolveTipParticipants,
  type TipSplitRule,
} from "../lib/gratuity";
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
    emailOptIn: c.emailOptIn,
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
  staffName: string | null = null,
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
    staffId: v.staffId,
    staffName,
    estimatedWaitMinutes: v.estimatedWaitMinutes,
    paymentAmount: v.paymentAmount == null ? null : parseFloat(v.paymentAmount),
    tipAmount: v.tipAmount == null ? null : parseFloat(v.tipAmount),
    bundleId: v.bundleId,
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

// ── tenant context ───────────────────────────────────────────────────────────

/**
 * Required tenant context for SOS operational routes, passed as the
 * `x-tenant-id` header. A positive integer selects that tenant's rows; the
 * literal value "legacy" deliberately selects the legacy (NULL-tenant)
 * scope. A missing or malformed header is rejected with a 400 — it must
 * never silently fall back to the legacy rows.
 */
function tenantIdFrom(req: Request): number | null {
  return requireTenantScope(req);
}

/**
 * Whether a tenant is party to any co-op partnership (any status). Used to
 * decide which gratuity engine handles a rule-less checkout tip: co-op
 * member tenants follow the tip-pool contract, standalone tenants keep the
 * classic per-tenant gratuity pool.
 */
async function tenantHasCoopPartnership(tenantId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: merchantCoopPartnershipsTable.id })
    .from(merchantCoopPartnershipsTable)
    .where(
      or(
        eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
        eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId),
      ),
    )
    .limit(1);
  return row != null;
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

// Settings for the caller's explicit tenant scope (`x-tenant-id: <id>` for a
// tenant's row, `legacy` for the tenant_id IS NULL record). Like every other
// SOS route, a missing/malformed header is rejected with 400 — settings must
// never silently fall back to the legacy row.
router.get("/sos/settings", async (req, res): Promise<void> => {
  const s = await resolveSettings(tenantIdFrom(req));
  res.json(GetSosSettingsResponse.parse(await serializeSettings(s)));
});

router.patch("/sos/settings", async (req, res): Promise<void> => {
  const body = UpdateSosSettingsBody.parse(req.body);
  const s = await resolveSettings(tenantIdFrom(req));
  const [updated] = await db
    .update(sosSettingsTable)
    .set({ ...toSettingsColumnUpdates(body), updatedAt: new Date() })
    .where(eq(sosSettingsTable.id, s.id))
    .returning();
  // Address changed → re-run co-op density detection in the background.
  if (addressFieldsTouched(body)) scheduleDensityDetection(updated.id);
  res.json(UpdateSosSettingsResponse.parse(await serializeSettings(updated)));
});

// First-run onboarding checklist state, derived from the scope's existing
// data: at least one service (structured catalog or legacy names), at least
// one active staff member, and hours saved at least once (hoursConfirmedAt
// is stamped whenever a settings update touches openTime/closeTime). The
// frontend hides the checklist once `complete` — existing tenants with data
// therefore never see it.
router.get("/sos/onboarding", async (req, res): Promise<void> => {
  const tenantId = tenantIdFrom(req);
  const settings = await resolveSettings(tenantId);
  const [serviceNames, staffRows] = await Promise.all([
    getServiceNamesForScope(tenantId, settings.serviceNames),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sosStaffMembersTable)
      .where(
        and(
          eq(sosStaffMembersTable.isActive, true),
          tenantMatch(sosStaffMembersTable.tenantId, tenantId),
        ),
      ),
  ]);
  const addServiceDone = serviceNames.length > 0;
  const addStaffDone = staffRows[0].n > 0;
  const confirmHoursDone = settings.hoursConfirmedAt != null;
  res.json(
    GetSosOnboardingResponse.parse({
      addServiceDone,
      addStaffDone,
      confirmHoursDone,
      complete: addServiceDone && addStaffDone && confirmHoursDone,
    }),
  );
});

// Live check (Twilio API) of whether the active SMS number's "A message
// comes in" webhook actually points at this app's inbound URL. Scoped like
// settings: the tenant's From-number override wins over the connector's.
router.get("/sos/twilio/webhook-status", async (req, res): Promise<void> => {
  const result = await getTwilioWebhookStatus(tenantIdFrom(req));
  res.json(GetSosTwilioWebhookStatusResponse.parse(result));
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
  const tenantId = tenantIdFrom(req);
  // Refuse to delete a resource that still has a customer in it: an occupied
  // status or an active visit assignment means deleting would orphan the
  // visit's resource assignment mid-service.
  const [existing] = await db
    .select()
    .from(sosResourcesTable)
    .where(and(eq(sosResourcesTable.id, id), tenantMatch(sosResourcesTable.tenantId, tenantId)));
  if (!existing) {
    res.status(404).json({ message: "Resource not found" });
    return;
  }
  if (existing.status === "occupied" || existing.currentVisitId != null) {
    res.status(409).json({
      message: `${existing.name} is currently occupied. Finish or reassign the active visit before deleting it.`,
    });
    return;
  }
  const [row] = await db
    .delete(sosResourcesTable)
    .where(
      and(
        eq(sosResourcesTable.id, id),
        tenantMatch(sosResourcesTable.tenantId, tenantId),
        // Concurrency guard: re-check occupancy inside the delete itself so a
        // visit assigned between the read and the delete still blocks it.
        ne(sosResourcesTable.status, "occupied"),
        isNull(sosResourcesTable.currentVisitId),
      ),
    )
    .returning({ id: sosResourcesTable.id });
  if (!row) {
    // Lost the race with a concurrent assignment/occupancy change.
    res.status(409).json({
      message: `${existing.name} is currently occupied. Finish or reassign the active visit before deleting it.`,
    });
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
  const email = body.email?.trim() || null;
  if (email && !isValidEmail(email)) {
    res.status(400).json({ message: "That email address doesn't look right." });
    return;
  }
  const [row] = await db
    .insert(sosCustomersTable)
    .values({ ...body, email, tenantId: tenantIdFrom(req) })
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
  const updates: Record<string, unknown> = { ...body };
  if (body.email !== undefined) {
    const trimmed = body.email?.trim() || null;
    if (trimmed && !isValidEmail(trimmed)) {
      res.status(400).json({ message: "That email address doesn't look right." });
      return;
    }
    updates.email = trimmed;
  }
  const [row] = await db
    .update(sosCustomersTable)
    .set(updates)
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
  channel: "ai_call" | "sms" | "concierge" | "email";
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
    const isEmail = m.channel === "email";
    // Real inbound phone calls (and voicemails) surface as ai_call entries,
    // same bucket as simulated receptionist calls.
    const isVoice = m.channel === "voice";
    entries.push({
      id: isVoice
        ? `voice-${m.id}`
        : isEmail
          ? `email-${m.id}`
          : isConcierge
            ? `concierge-${m.id}`
            : `sms-${m.id}`,
      channel: isVoice ? "ai_call" : isEmail ? "email" : isConcierge ? "concierge" : "sms",
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

// ── structured service catalog ───────────────────────────────────────────────

function serializeService(s: SosServiceRow) {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    price: s.price == null ? null : parseFloat(s.price),
    durationMinutes: s.durationMinutes,
    sortOrder: s.sortOrder,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Case-insensitive duplicate-name check within a scope. */
async function serviceNameTaken(
  name: string,
  tenantId: number | null,
  excludeId?: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: sosServicesTable.id })
    .from(sosServicesTable)
    .where(
      and(
        tenantMatch(sosServicesTable.tenantId, tenantId),
        sql`lower(${sosServicesTable.name}) = lower(${name})`,
        excludeId != null ? ne(sosServicesTable.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

router.get("/sos/services", async (req, res): Promise<void> => {
  const rows = await listServicesForScope(tenantIdFrom(req));
  res.json(ListSosServicesResponse.parse(rows.map(serializeService)));
});

router.post("/sos/services", async (req, res): Promise<void> => {
  const body = CreateSosServiceBody.parse(req.body);
  const tenantId = tenantIdFrom(req);
  if (await serviceNameTaken(body.name, tenantId)) {
    res.status(409).json({ message: `A service named "${body.name}" already exists` });
    return;
  }
  // Append to the end of the menu.
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${sosServicesTable.sortOrder}), -1)::int` })
    .from(sosServicesTable)
    .where(tenantMatch(sosServicesTable.tenantId, tenantId));
  const [row] = await db
    .insert(sosServicesTable)
    .values({
      tenantId,
      name: body.name,
      category: body.category ?? null,
      description: body.description ?? null,
      price: body.price == null ? null : body.price.toFixed(2),
      durationMinutes: body.durationMinutes ?? null,
      sortOrder: max + 1,
    })
    .returning();
  res.status(201).json(CreateSosServiceResponse.parse(serializeService(row)));
});

router.patch("/sos/services/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = UpdateSosServiceBody.parse(req.body);
  const tenantId = tenantIdFrom(req);
  if (body.name !== undefined && (await serviceNameTaken(body.name, tenantId, id))) {
    res.status(409).json({ message: `A service named "${body.name}" already exists` });
    return;
  }
  const updates: Partial<typeof sosServicesTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) updates.name = body.name;
  if (body.category !== undefined) updates.category = body.category;
  if (body.description !== undefined) updates.description = body.description;
  if (body.price !== undefined)
    updates.price = body.price == null ? null : body.price.toFixed(2);
  if (body.durationMinutes !== undefined) updates.durationMinutes = body.durationMinutes;
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;
  const [row] = await db
    .update(sosServicesTable)
    .set(updates)
    .where(and(eq(sosServicesTable.id, id), tenantMatch(sosServicesTable.tenantId, tenantId)))
    .returning();
  if (!row) {
    res.status(404).json({ message: "Service not found" });
    return;
  }
  res.json(UpdateSosServiceResponse.parse(serializeService(row)));
});

router.delete("/sos/services/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .delete(sosServicesTable)
    .where(and(eq(sosServicesTable.id, id), tenantMatch(sosServicesTable.tenantId, tenantIdFrom(req))))
    .returning({ id: sosServicesTable.id });
  if (!row) {
    res.status(404).json({ message: "Service not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/sos/services/reorder", async (req, res): Promise<void> => {
  const body = ReorderSosServicesBody.parse(req.body);
  const tenantId = tenantIdFrom(req);
  const rows = await listServicesForScope(tenantId);
  const currentIds = new Set(rows.map((r) => r.id));
  const requested = body.orderedIds;
  // The new order must be a permutation of exactly this scope's services —
  // anything else (missing rows, foreign ids, duplicates) is a stale client.
  const valid =
    requested.length === currentIds.size &&
    new Set(requested).size === requested.length &&
    requested.every((id) => currentIds.has(id));
  if (!valid) {
    res.status(400).json({
      message: "orderedIds must list each of this business's services exactly once",
    });
    return;
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < requested.length; i++) {
      await tx
        .update(sosServicesTable)
        .set({ sortOrder: i, updatedAt: new Date() })
        .where(
          and(
            eq(sosServicesTable.id, requested[i]),
            tenantMatch(sosServicesTable.tenantId, tenantId),
          ),
        );
    }
  });
  const updated = await listServicesForScope(tenantId);
  res.json(ReorderSosServicesResponse.parse(updated.map(serializeService)));
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

router.get("/sos/plans", async (req, res): Promise<void> => {
  // Strict business scope: the tenant's own plan catalog under tenant
  // context, legacy (NULL-tenant) plans otherwise.
  const rows = await db
    .select()
    .from(sosPlansTable)
    .where(tenantMatch(sosPlansTable.tenantId, tenantIdFrom(req)))
    .orderBy(sosPlansTable.id);
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
      tenantId: tenantIdFrom(req),
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
    .where(and(eq(sosPlansTable.id, id), tenantMatch(sosPlansTable.tenantId, tenantIdFrom(req))))
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
    db
      .select()
      .from(sosPlansTable)
      .where(
        and(
          eq(sosPlansTable.id, body.planId),
          tenantMatch(sosPlansTable.tenantId, tenantIdFrom(req)),
        ),
      ),
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
  const [purchaseTxn] = await db.insert(sosPlanTransactionsTable).values({
    customerPlanId: cp.id,
    customerId: customer.id,
    transactionType: "purchase",
    amount: plan.price,
    creditsDelta: plan.planType === "membership" ? null : plan.creditCount,
    note: `Purchased ${plan.name}`,
  }).returning();
  await recordLedgerEventsSafe([{
    source: "plan_purchase",
    sourceRef: `sos_plan_transactions:${purchaseTxn.id}`,
    tenantId: customer.tenantId,
    category: "Plans",
    description: `Purchased ${plan.name}`,
    amount: plan.price,
    occurredAt: purchaseTxn.createdAt,
  }]);
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
  const [renewalTxn] = await db.insert(sosPlanTransactionsTable).values({
    customerPlanId: cp.id,
    customerId: cp.customerId,
    transactionType: "renewal",
    amount: plan.price,
    note: `Renewed ${plan.name}`,
  }).returning();
  await recordLedgerEventsSafe([{
    source: "plan_renewal",
    sourceRef: `sos_plan_transactions:${renewalTxn.id}`,
    tenantId: tenantIdFrom(req),
    category: "Plans",
    description: `Renewed ${plan.name}`,
    amount: plan.price,
    occurredAt: renewalTxn.createdAt,
  }]);
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

// ── staff members & compensation ─────────────────────────────────────────────

type StaffRow = typeof sosStaffMembersTable.$inferSelect;

/**
 * Effective license status: "expired" is always derived from the expiration
 * date (never stored), so a verified license that lapses flips to expired
 * automatically without any sweeper.
 */
export function staffLicenseStatus(s: {
  licenseExpiresAt: Date | null;
  licenseVerificationStatus: string;
}): "unverified" | "verified" | "expired" {
  if (s.licenseExpiresAt != null && s.licenseExpiresAt.getTime() <= Date.now()) return "expired";
  return s.licenseVerificationStatus === "verified" ? "verified" : "unverified";
}

function serializeStaffMember(s: StaffRow) {
  return {
    id: s.id,
    name: s.name,
    phone: s.phone,
    email: s.email,
    isActive: s.isActive,
    compensationType: s.compensationType,
    commissionPercent: s.commissionPercent,
    amount: s.amount == null ? null : parseFloat(s.amount),
    cadence: s.cadence,
    tipPercent: s.tipPercent,
    tipRoleWeight: s.tipRoleWeight,
    skills: s.skills,
    certifications: s.certifications,
    licenseNumber: s.licenseNumber,
    licenseState: s.licenseState,
    licenseExpiresAt: iso(s.licenseExpiresAt),
    licenseStatus: staffLicenseStatus(s),
    licenseVerifiedBy: s.licenseVerifiedBy,
    licenseVerifiedAt: iso(s.licenseVerifiedAt),
    coopCoverageEnabled: s.coopCoverageEnabled,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Normalize skill/cert lists: trim entries, drop empties. */
function cleanList(list: string[] | undefined): string[] | undefined {
  if (list == null) return undefined;
  return list.map((x) => x.trim()).filter((x) => x.length > 0);
}

const parseExpiry = (raw: string | null | undefined): Date | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
};

/**
 * Cross-field validation for a compensation model: each model must carry
 * exactly the terms it needs. Returns an error message or null.
 */
function validateCompensation(input: {
  compensationType: string;
  commissionPercent: number | null;
  amount: number | null;
  cadence: string | null;
}): string | null {
  if (input.compensationType === "commission") {
    if (input.commissionPercent == null)
      return "commissionPercent is required for commission staff";
    if (input.amount != null || input.cadence != null)
      return "amount and cadence do not apply to commission staff";
  } else {
    if (input.amount == null || input.cadence == null)
      return `amount and cadence are required for ${input.compensationType === "flat_fee" ? "flat-fee" : "booth-rent"} staff`;
    if (input.commissionPercent != null)
      return "commissionPercent only applies to commission staff";
  }
  return null;
}

router.get("/sos/staff", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(sosStaffMembersTable)
    .where(tenantMatch(sosStaffMembersTable.tenantId, tenantIdFrom(req)))
    .orderBy(sosStaffMembersTable.id);
  res.json(ListSosStaffResponse.parse(rows.map(serializeStaffMember)));
});

router.post("/sos/staff", async (req, res): Promise<void> => {
  const body = CreateSosStaffMemberBody.parse(req.body);
  const terms = {
    compensationType: body.compensationType,
    commissionPercent: body.commissionPercent ?? null,
    amount: body.amount ?? null,
    cadence: body.cadence ?? null,
  };
  const err = validateCompensation(terms);
  if (err) {
    res.status(400).json({ message: err });
    return;
  }
  const [row] = await db
    .insert(sosStaffMembersTable)
    .values({
      tenantId: tenantIdFrom(req),
      name: body.name,
      phone: body.phone ?? null,
      email: body.email ?? null,
      compensationType: terms.compensationType,
      commissionPercent: terms.commissionPercent,
      amount: terms.amount == null ? null : terms.amount.toFixed(2),
      cadence: terms.cadence,
      skills: cleanList(body.skills) ?? [],
      certifications: cleanList(body.certifications) ?? [],
      licenseNumber: body.licenseNumber?.trim() || null,
      licenseState: body.licenseState?.trim().toUpperCase() || null,
      licenseExpiresAt: parseExpiry(body.licenseExpiresAt) ?? null,
      coopCoverageEnabled: body.coopCoverageEnabled ?? false,
    })
    .returning();
  res.status(201).json(CreateSosStaffMemberResponse.parse(serializeStaffMember(row)));
});

router.patch("/sos/staff/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = UpdateSosStaffMemberBody.parse(req.body);
  const [existing] = await db
    .select()
    .from(sosStaffMembersTable)
    .where(
      and(
        eq(sosStaffMembersTable.id, id),
        tenantMatch(sosStaffMembersTable.tenantId, tenantIdFrom(req)),
      ),
    );
  if (!existing) {
    res.status(404).json({ message: "Staff member not found" });
    return;
  }

  // When the compensation model changes, the terms are re-validated as a
  // whole; terms not mentioned in the update fall back to the stored ones,
  // except across a model switch where stale terms are dropped.
  const nextType = body.compensationType ?? existing.compensationType;
  const switching = nextType !== existing.compensationType;
  const terms = {
    compensationType: nextType,
    commissionPercent:
      body.commissionPercent ?? (switching ? null : existing.commissionPercent),
    amount:
      body.amount ??
      (switching || existing.amount == null ? null : parseFloat(existing.amount)),
    cadence: body.cadence ?? (switching ? null : existing.cadence),
  };
  // Drop terms that don't apply to the (possibly new) model before validating,
  // so e.g. switching commission → flat_fee doesn't complain about the old %.
  if (terms.compensationType === "commission") {
    terms.amount = null;
    terms.cadence = null;
  } else {
    terms.commissionPercent = null;
  }
  const err = validateCompensation(terms);
  if (err) {
    res.status(400).json({ message: err });
    return;
  }

  // Any change to the license itself invalidates the manual attestation —
  // the credential on file is no longer the one that was verified.
  const nextLicenseNumber =
    body.licenseNumber === undefined
      ? existing.licenseNumber
      : body.licenseNumber?.trim() || null;
  const nextLicenseState =
    body.licenseState === undefined
      ? existing.licenseState
      : body.licenseState?.trim().toUpperCase() || null;
  const parsedExpiry = parseExpiry(body.licenseExpiresAt);
  const nextLicenseExpiresAt = parsedExpiry === undefined ? existing.licenseExpiresAt : parsedExpiry;
  const licenseTouched =
    nextLicenseNumber !== existing.licenseNumber ||
    nextLicenseState !== existing.licenseState ||
    (nextLicenseExpiresAt?.getTime() ?? null) !== (existing.licenseExpiresAt?.getTime() ?? null);

  const [row] = await db
    .update(sosStaffMembersTable)
    .set({
      name: body.name ?? existing.name,
      phone: body.phone ?? existing.phone,
      email: body.email ?? existing.email,
      isActive: body.isActive ?? existing.isActive,
      compensationType: terms.compensationType,
      commissionPercent: terms.commissionPercent,
      amount: terms.amount == null ? null : terms.amount.toFixed(2),
      cadence: terms.cadence,
      skills: cleanList(body.skills) ?? existing.skills,
      certifications: cleanList(body.certifications) ?? existing.certifications,
      licenseNumber: nextLicenseNumber,
      licenseState: nextLicenseState,
      licenseExpiresAt: nextLicenseExpiresAt,
      ...(licenseTouched
        ? {
            licenseVerificationStatus: "unverified",
            licenseVerifiedBy: null,
            licenseVerifiedAt: null,
          }
        : {}),
      coopCoverageEnabled: body.coopCoverageEnabled ?? existing.coopCoverageEnabled,
    })
    .where(eq(sosStaffMembersTable.id, id))
    .returning();
  res.json(UpdateSosStaffMemberResponse.parse(serializeStaffMember(row)));
});

// Manual license attestation: a named verifier confirms the license on file.
// Recorded verifier + timestamp make the attestation auditable; there is no
// automated state-board check by design.
router.post("/sos/staff/:id/license-verification", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = VerifySosStaffLicenseBody.parse(req.body);
  const [existing] = await db
    .select()
    .from(sosStaffMembersTable)
    .where(
      and(
        eq(sosStaffMembersTable.id, id),
        tenantMatch(sosStaffMembersTable.tenantId, tenantIdFrom(req)),
      ),
    );
  if (!existing) {
    res.status(404).json({ message: "Staff member not found" });
    return;
  }
  if (!existing.licenseNumber) {
    res.status(400).json({ message: "No license on file to verify — add a license number first" });
    return;
  }
  const [row] = await db
    .update(sosStaffMembersTable)
    .set({
      licenseVerificationStatus: "verified",
      licenseVerifiedBy: body.verifiedBy.trim(),
      licenseVerifiedAt: new Date(),
    })
    .where(eq(sosStaffMembersTable.id, id))
    .returning();
  res.json(VerifySosStaffLicenseResponse.parse(serializeStaffMember(row)));
});

router.get("/sos/staff-earnings", async (req, res): Promise<void> => {
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  if (!from || !to || isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
    res.status(400).json({ message: "Valid from/to period is required (from < to)" });
    return;
  }
  const tenantId = tenantIdFrom(req);

  const staff = await db
    .select()
    .from(sosStaffMembersTable)
    .where(tenantMatch(sosStaffMembersTable.tenantId, tenantId))
    .orderBy(sosStaffMembersTable.id);

  // Revenue attributed per staff member: sum of the payment amounts PERSISTED
  // at checkout on visits checked out inside the period. Never recomputed
  // from anything current except the staff member's split rate.
  const revenue = await db
    .select({
      staffId: sosVisitsTable.staffId,
      visits: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${sosVisitsTable.paymentAmount}), 0)`,
    })
    .from(sosVisitsTable)
    .where(
      and(
        tenantMatch(sosVisitsTable.tenantId, tenantId),
        isNotNull(sosVisitsTable.staffId),
        eq(sosVisitsTable.status, "checked_out"),
        gte(sosVisitsTable.checkedOutAt, from),
        sql`${sosVisitsTable.checkedOutAt} < ${to}`,
      ),
    )
    .groupBy(sosVisitsTable.staffId);
  const byStaff = new Map(revenue.map((r) => [r.staffId, r]));

  // Pooled tips allocated in the period, itemized separately — tips are
  // NEVER part of attributedRevenue or the commission base. Two ledgers feed
  // this: the per-tenant gratuity pool ledger and the rule-based tip-pool
  // (partnership/group-event) ledger; a given tip is written to exactly one.
  const tips = await db
    .select({
      staffId: sosGratuityLedgerTable.staffId,
      total: sql<string>`coalesce(sum(${sosGratuityLedgerTable.amount}), 0)`,
    })
    .from(sosGratuityLedgerTable)
    .where(
      and(
        tenantMatch(sosGratuityLedgerTable.tenantId, tenantId),
        gte(sosGratuityLedgerTable.createdAt, from),
        sql`${sosGratuityLedgerTable.createdAt} < ${to}`,
      ),
    )
    .groupBy(sosGratuityLedgerTable.staffId);
  const tipsByStaff = new Map(tips.map((t) => [t.staffId, parseFloat(t.total)]));

  // Shared gratuities from the rule-based tip-pool ledger — a distinct line
  // item, never folded into commission or service revenue.
  const sharedTips = await db
    .select({
      staffId: sosTipPoolLedgerTable.recipientStaffId,
      total: sql<string>`coalesce(sum(${sosTipPoolLedgerTable.allocatedShare}), 0)`,
    })
    .from(sosTipPoolLedgerTable)
    .where(
      and(
        tenantMatch(sosTipPoolLedgerTable.recipientTenantId, tenantId),
        gte(sosTipPoolLedgerTable.createdAt, from),
        sql`${sosTipPoolLedgerTable.createdAt} < ${to}`,
      ),
    )
    .groupBy(sosTipPoolLedgerTable.recipientStaffId);
  const sharedTipsByStaff = new Map(sharedTips.map((r) => [r.staffId, parseFloat(r.total)]));

  // Cadence periods due inside [from, to): whole weeks/months, minimum 1 —
  // a shorter selection still owes one cadence period.
  const periodsDue = (cadence: string | null): number => {
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    const len = cadence === "weekly" ? 7 : 30.4375; // avg month length
    return Math.max(1, Math.round(days / len));
  };

  res.json(
    GetSosStaffEarningsResponse.parse(
      staff.map((s) => {
        const rev = byStaff.get(s.id);
        const attributedRevenue = rev ? parseFloat(rev.total) : 0;
        const isCommission = s.compensationType === "commission";
        const amount = s.amount == null ? null : parseFloat(s.amount);
        return {
          staffId: s.id,
          name: s.name,
          isActive: s.isActive,
          compensationType: s.compensationType,
          commissionPercent: s.commissionPercent,
          amount,
          cadence: s.cadence,
          attributedVisits: rev?.visits ?? 0,
          attributedRevenue,
          commissionEarned: isCommission
            ? Math.round(attributedRevenue * (s.commissionPercent ?? 0)) / 100
            : null,
          amountDue: !isCommission && amount != null
            ? Math.round(amount * periodsDue(s.cadence) * 100) / 100
            : null,
          tipsEarned: tipsByStaff.get(s.id) ?? 0,
          sharedTipsEarned: sharedTipsByStaff.get(s.id) ?? 0,
        };
      }),
    ),
  );
});

// ── gratuity / tip pooling ───────────────────────────────────────────────────

async function serializeGratuityConfig(tenantId: number | null) {
  const settings = await resolveSettings(tenantId);
  const staff = await db
    .select()
    .from(sosStaffMembersTable)
    .where(tenantMatch(sosStaffMembersTable.tenantId, tenantId))
    .orderBy(sosStaffMembersTable.id);
  return {
    tipSplitRule: isTipSplitRule(settings.tipSplitRule) ? settings.tipSplitRule : "equal",
    staff: staff.map((s) => ({
      staffId: s.id,
      name: s.name,
      isActive: s.isActive,
      tipPercent: s.tipPercent,
      tipRoleWeight: s.tipRoleWeight,
    })),
  };
}

router.get("/sos/gratuity-config", async (req, res): Promise<void> => {
  res.json(
    GetSosGratuityConfigResponse.parse(await serializeGratuityConfig(tenantIdFrom(req))),
  );
});

router.patch("/sos/gratuity-config", async (req, res): Promise<void> => {
  const body = UpdateSosGratuityConfigBody.parse(req.body);
  const tenantId = tenantIdFrom(req);

  if (body.tipSplitRule != null) {
    const settings = await resolveSettings(tenantId);
    await db
      .update(sosSettingsTable)
      .set({ tipSplitRule: body.tipSplitRule, updatedAt: new Date() })
      .where(eq(sosSettingsTable.id, settings.id));
  }

  for (const share of body.staffShares ?? []) {
    const [row] = await db
      .update(sosStaffMembersTable)
      .set({
        ...(share.tipPercent !== undefined ? { tipPercent: share.tipPercent } : {}),
        ...(share.tipRoleWeight !== undefined ? { tipRoleWeight: share.tipRoleWeight } : {}),
      })
      .where(
        and(
          eq(sosStaffMembersTable.id, share.staffId),
          tenantMatch(sosStaffMembersTable.tenantId, tenantId),
        ),
      )
      .returning({ id: sosStaffMembersTable.id });
    if (!row) {
      res.status(404).json({ message: `Staff member ${share.staffId} not found` });
      return;
    }
  }

  res.json(
    UpdateSosGratuityConfigResponse.parse(await serializeGratuityConfig(tenantId)),
  );
});

// Auditable per-period gratuity ledger + per-staff totals (tax/end-of-shift).
router.get("/sos/gratuity-ledger", async (req, res): Promise<void> => {
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  if (!from || !to || isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
    res.status(400).json({ message: "Valid from/to period is required (from < to)" });
    return;
  }
  const tenantId = tenantIdFrom(req);

  const rows = await db
    .select({ entry: sosGratuityLedgerTable, staffName: sosStaffMembersTable.name })
    .from(sosGratuityLedgerTable)
    .innerJoin(
      sosStaffMembersTable,
      eq(sosGratuityLedgerTable.staffId, sosStaffMembersTable.id),
    )
    .where(
      and(
        tenantMatch(sosGratuityLedgerTable.tenantId, tenantId),
        gte(sosGratuityLedgerTable.createdAt, from),
        sql`${sosGratuityLedgerTable.createdAt} < ${to}`,
      ),
    )
    .orderBy(desc(sosGratuityLedgerTable.createdAt), desc(sosGratuityLedgerTable.id));

  const totals = new Map<number, { staffId: number; name: string; total: number }>();
  let totalDistributed = 0;
  for (const { entry, staffName } of rows) {
    const amount = parseFloat(entry.amount);
    totalDistributed += amount;
    const t = totals.get(entry.staffId) ?? { staffId: entry.staffId, name: staffName, total: 0 };
    t.total += amount;
    totals.set(entry.staffId, t);
  }

  res.json(
    GetSosGratuityLedgerResponse.parse({
      entries: rows.map(({ entry, staffName }) => ({
        id: entry.id,
        visitId: entry.visitId,
        staffId: entry.staffId,
        staffName,
        ruleApplied: entry.ruleApplied,
        amount: parseFloat(entry.amount),
        createdAt: entry.createdAt.toISOString(),
      })),
      totalsByStaff: [...totals.values()].map((t) => ({
        ...t,
        total: Math.round(t.total * 100) / 100,
      })),
      totalDistributed: Math.round(totalDistributed * 100) / 100,
    }),
  );
});

// ── visits (customer journey state machine) ──────────────────────────────────

async function serializeVisits(activeOnly: boolean, tenantId: number | null) {
  const rows = await db
    .select({
      visit: sosVisitsTable,
      customerName: sosCustomersTable.name,
      resourceName: sosResourcesTable.name,
      staffName: sosStaffMembersTable.name,
    })
    .from(sosVisitsTable)
    .innerJoin(sosCustomersTable, eq(sosVisitsTable.customerId, sosCustomersTable.id))
    .leftJoin(sosResourcesTable, eq(sosVisitsTable.resourceId, sosResourcesTable.id))
    .leftJoin(sosStaffMembersTable, eq(sosVisitsTable.staffId, sosStaffMembersTable.id))
    .where(
      and(
        activeOnly ? ne(sosVisitsTable.status, "checked_out") : undefined,
        tenantMatch(sosVisitsTable.tenantId, tenantId),
      ),
    )
    .orderBy(sosVisitsTable.checkedInAt);
  return rows.map((r) => serializeVisit(r.visit, r.customerName, r.resourceName, r.staffName));
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
    if (body.tipAmount != null) {
      updates.tipAmount = body.tipAmount.toFixed(2);
    }
    // Optional staff attribution captured at payment/checkout. Must be an
    // active staff member in the same tenant scope as the visit.
    if (body.staffId != null) {
      const [staff] = await db
        .select({ id: sosStaffMembersTable.id, isActive: sosStaffMembersTable.isActive })
        .from(sosStaffMembersTable)
        .where(
          and(
            eq(sosStaffMembersTable.id, body.staffId),
            tenantMatch(sosStaffMembersTable.tenantId, tenantIdFrom(req)),
          ),
        );
      if (!staff) {
        res.status(404).json({ message: "Staff member not found" });
        return;
      }
      if (!staff.isActive) {
        res.status(409).json({ message: "Staff member is deactivated" });
        return;
      }
      updates.staffId = body.staffId;
    }
  }

  // Optional plan benefit at checkout: redeem a prepaid credit or apply a
  // membership discount. Read-only validation happens here; the mutating
  // writes are deferred into the checkout transaction below so a losing
  // concurrent checkout can never spend a credit or record a discount.
  let benefitPlan: Awaited<ReturnType<typeof getCustomerPlanWithPlan>> | undefined;
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
    if (body.benefitType === "redeem_credit" && found.plan.planType === "membership") {
      res.status(409).json({ message: "Memberships have no credits to redeem" });
      return;
    }
    if (body.benefitType !== "redeem_credit" && found.plan.planType !== "membership") {
      res.status(409).json({ message: "Only memberships grant a discount" });
      return;
    }
    benefitPlan = found;
  }

  // Gratuity capture at checkout. Exactly ONE engine handles a given tip:
  // a rule-based tip-pool rule (co-op bundle partnership or group event)
  // takes precedence and writes the tip-pool ledger; otherwise the tenant's
  // gratuity pool config splits it across the tenant's staff. Ledger rows
  // are written atomically with the checkout below.
  const checkoutTip =
    body.action === "check_out"
      ? body.tipAmount != null
        ? body.tipAmount
        : visit.tipAmount != null
          ? parseFloat(visit.tipAmount)
          : null
      : null;
  let usesTipPoolRule = false;
  let tipLedgerRows:
    | { tenantId: number | null; staffId: number; ruleApplied: string; amount: string }[]
    | null = null;
  if (checkoutTip != null && checkoutTip > 0) {
    if (body.tipAmount != null) updates.tipAmount = body.tipAmount.toFixed(2);
    const ruleResolves =
      (await resolveTipRuleForVisit({
        bundleId: visit.bundleId,
        tenantId: visit.tenantId,
      })) != null;
    // The tip-pool engine also owns the no-rule fallback (whole tip to the
    // servicing staff member) for businesses in a live co-op partnership —
    // their staff expect the tip-pool ledger to be the single source of
    // truth. Standalone businesses keep the tenant gratuity pool config.
    const servicingStaffId = (body.staffId ?? visit.staffId) as number | null;
    usesTipPoolRule =
      ruleResolves ||
      (servicingStaffId != null &&
        (visit.bundleId != null || (await tenantHasLivePartnership(visit.tenantId))));
    if (!usesTipPoolRule) {
      // No explicit rule. Two engines could claim this tip:
      //  - the rule-based tip-pool engine's default (whole tip to the
      //    servicing staff member, written to the tip-pool ledger) — the
      //    contract for tenants participating in the co-op network;
      //  - the classic per-tenant gratuity pool (split across active staff).
      // A crossover-driven shared pool (participants from a partner tenant)
      // always uses the gratuity splitter so cross-business rows land on
      // each tenant's own ledger. Otherwise, co-op member tenants get the
      // tip-pool default; standalone tenants keep the classic splitter.
      const poolParticipants = await resolveTipParticipants(tenantIdFrom(req));
      const crossTenantPool = poolParticipants.some((p) => p.tenantId !== visit.tenantId);
      if (
        !crossTenantPool &&
        visit.tenantId != null &&
        (await tenantHasCoopPartnership(visit.tenantId))
      ) {
        // writeGratuityLedger's no-rule fallback allocates the whole tip to
        // the servicing staff member on the tip-pool ledger.
        usesTipPoolRule = true;
      }
    }
    if (!usesTipPoolRule) {
      const settings = await resolveSettings(tenantIdFrom(req));
      const rule: TipSplitRule =
        body.tipSplitRule != null && isTipSplitRule(body.tipSplitRule)
          ? body.tipSplitRule
          : isTipSplitRule(settings.tipSplitRule)
            ? settings.tipSplitRule
            : "equal";
      const participants = await resolveTipParticipants(tenantIdFrom(req));
      if (participants.length === 0) {
        res.status(409).json({
          message: "Cannot record a tip: no active staff members to allocate it to",
        });
        return;
      }
      const { rule: appliedRule, allocations } = computeTipAllocations(
        rule,
        checkoutTip,
        participants,
      );
      tipLedgerRows = allocations.map((a) => ({
        tenantId: a.tenantId,
        staffId: a.staffId,
        ruleApplied: appliedRule,
        amount: a.amount,
      }));
    }
  }

  if (body.action === "check_out") {
    updates.checkedOutAt = new Date();
  }

  // Checkout is atomic: the conditional status transition (so two concurrent
  // advances of the same visit can't both succeed — the loser sees no row and
  // gets a 409), the plan-benefit writes, and the itemized gratuity ledger
  // rows all commit together or not at all. This also guarantees each
  // single-winner side effect happens at most once per checkout.
  const NO_CREDITS = Symbol("no-credits");
  let txOutcome: typeof sosVisitsTable.$inferSelect | undefined | typeof NO_CREDITS;
  try {
    txOutcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(sosVisitsTable)
        .set(updates)
        .where(and(eq(sosVisitsTable.id, id), inArray(sosVisitsTable.status, transition.from)))
        .returning();
      if (!row) return undefined;
      if (body.action === "check_out" && benefitPlan) {
        const { cp, plan } = benefitPlan;
        if (body.benefitType === "redeem_credit") {
          // Conditional decrement guards against two concurrent redemptions
          // spending the same last credit.
          const [spent] = await tx
            .update(sosCustomerPlansTable)
            .set({ remainingCredits: sql`${sosCustomerPlansTable.remainingCredits} - 1` })
            .where(
              and(
                eq(sosCustomerPlansTable.id, cp.id),
                gte(sosCustomerPlansTable.remainingCredits, 1),
              ),
            )
            .returning({ remaining: sosCustomerPlansTable.remainingCredits });
          if (!spent) {
            // Abort the whole checkout — the visit must not check out while
            // claiming a credit that could not be redeemed.
            throw NO_CREDITS;
          }
          await tx.insert(sosPlanTransactionsTable).values({
            customerPlanId: cp.id,
            customerId: visit.customerId,
            visitId: visit.id,
            transactionType: "redemption",
            creditsDelta: -1,
            note: `Redeemed 1 credit from ${plan.name} for ${visit.serviceType} (${spent.remaining} left)`,
          });
        } else {
          await tx.insert(sosPlanTransactionsTable).values({
            customerPlanId: cp.id,
            customerId: visit.customerId,
            visitId: visit.id,
            transactionType: "discount",
            amount: body.paymentAmount != null ? body.paymentAmount.toFixed(2) : null,
            note: `${plan.discountPercent}% ${plan.name} discount applied to ${visit.serviceType}`,
          });
        }
      }
      if (checkoutTip != null && checkoutTip > 0) {
        if (usesTipPoolRule) {
          await writeGratuityLedger(
            tx,
            { id: row.id, tenantId: row.tenantId, bundleId: row.bundleId },
            checkoutTip,
            row.staffId,
          );
        } else if (tipLedgerRows && tipLedgerRows.length > 0) {
          await tx
            .insert(sosGratuityLedgerTable)
            .values(tipLedgerRows.map((r) => ({ ...r, visitId: row.id })));
        }
      }
      return row;
    });
  } catch (err) {
    if (err !== NO_CREDITS) throw err;
    txOutcome = NO_CREDITS;
  }

  if (txOutcome === NO_CREDITS) {
    res.status(409).json({ message: "No credits remaining on this plan" });
    return;
  }
  if (!txOutcome) {
    // Lost the race: another request advanced this visit first.
    res.status(409).json({
      message: `Cannot ${body.action} a visit in status "${visit.status}"`,
    });
    return;
  }
  const updated = txOutcome;

  if (body.action === "check_out") {
    // Post-commit, winner-only side effects. Co-op analytics: if a partner's
    // customer recently scanned a perk pass here (a cross-over event),
    // attribute this checkout's revenue to it for the revenue-influenced
    // estimate. Best-effort; never blocks checkout.
    const effectivePayment =
      updated.paymentAmount != null ? parseFloat(updated.paymentAmount) : null;
    await attachRevenueToRecentCrossoverSafe(tenantIdFrom(req), effectivePayment);
    if (visit.resourceId) {
      await db
        .update(sosResourcesTable)
        .set({ status: "cleaning", currentVisitId: null })
        .where(eq(sosResourcesTable.id, visit.resourceId));
    }
  }

  if (body.action === "check_out") {
    // Compliance ledger: record the checkout payment (idempotent on the
    // visit reference — a re-emitted checkout can never double-count).
    if (updated.paymentAmount != null && parseFloat(updated.paymentAmount) > 0) {
      await recordLedgerEventsSafe([{
        source: "visit_checkout",
        sourceRef: `sos_visits:${updated.id}`,
        tenantId: updated.tenantId,
        category: "Visits",
        description: `Visit checkout — ${updated.serviceType}`,
        amount: updated.paymentAmount,
        occurredAt: updated.checkedOutAt ?? new Date(),
      }]);
    }
    // Keep the operational last-visit stamp on the customer fresh, then
    // recompute the linked concierge profile's cadence (last visit + average
    // cycle) from real completed-visit history so the rebooking automation
    // sees up-to-date data. Establish the profile link first if missing.
    await db
      .update(sosCustomersTable)
      .set({ lastVisitAt: updated.checkedOutAt })
      .where(eq(sosCustomersTable.id, customer.id));
    const linkedProfileId =
      customer.clientProfileId ?? (await autoLinkCustomer(customer))?.id ?? null;
    await updateProfileCadence(linkedProfileId);
    // Deposit co-op perk passes into the customer's Local Perks wallet the
    // moment service completes. Safe: a grant problem never blocks checkout.
    await grantPerkPassesSafe({ tenantId: visit.tenantId, customerId: customer.id });
    // Ambassador program: a completed booking is a qualifying visit — it can
    // convert a pending referral and advances tier evaluation. Never blocks.
    const ambassadorTenantId = updated.tenantId ?? tenantIdFrom(req);
    if (ambassadorTenantId != null) {
      await recordAmbassadorActivitySafe({
        tenantId: ambassadorTenantId,
        person: { phone: customer.phone, email: customer.email, name: customer.name },
      });
    }
    // Checkout receipt email (complement to SMS). Opt-in and address checks
    // live in the email pipeline; a failure never blocks the checkout.
    const receiptSettings = await resolveSettings(updated.tenantId);
    await sendReceiptEmailSafe({
      tenantId: updated.tenantId,
      customer,
      businessName: receiptSettings.businessName,
      serviceType: updated.serviceType,
      paymentAmount: updated.paymentAmount,
      checkedOutAt: updated.checkedOutAt ?? new Date(),
      visitId: updated.id,
    });
  }

  const resourceName = updated.resourceId
    ? ((
        await db
          .select({ name: sosResourcesTable.name })
          .from(sosResourcesTable)
          .where(eq(sosResourcesTable.id, updated.resourceId))
      )[0]?.name ?? null)
    : null;

  const staffName = updated.staffId
    ? ((
        await db
          .select({ name: sosStaffMembersTable.name })
          .from(sosStaffMembersTable)
          .where(eq(sosStaffMembersTable.id, updated.staffId))
      )[0]?.name ?? null)
    : null;

  res.json(
    AdvanceSosVisitResponse.parse(
      serializeVisit(updated, customer.name, resourceName, staffName),
    ),
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

  // Booking confirmation email (complement to SMS). Opt-in and address
  // checks live in the email pipeline; a failure never blocks the booking.
  const apptSettings = await resolveSettings(row.tenantId);
  let staffName: string | null = null;
  if (row.resourceId != null) {
    const [resource] = await db
      .select({ name: sosResourcesTable.name })
      .from(sosResourcesTable)
      .where(eq(sosResourcesTable.id, row.resourceId));
    staffName = resource?.name ?? null;
  }
  const [apptTenant] = row.tenantId
    ? await db
        .select({ subdomain: tenantsTable.subdomain })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, row.tenantId))
    : [];
  await sendBookingConfirmationEmailSafe({
    tenantId: row.tenantId,
    customer,
    businessName: apptSettings.businessName,
    slug: apptTenant?.subdomain ?? null,
    serviceType: row.serviceType,
    startsAt: row.startsAt,
    staffName,
    appointmentId: row.id,
  });

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
    toEmail: msg.toEmail,
    channel: msg.channel,
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

/**
 * Tenant scope resolved from the Twilio number an inbound text was sent TO.
 *
 * Each tenant can be assigned its own Twilio "from" number via
 * sos_settings.sms_from_number; inbound replies to that number arrive with it
 * as the To param, which identifies the business unambiguously. `resolved`
 * is true only when exactly one settings row claims the number — a number
 * shared by several settings rows (misconfiguration) or claimed by none (the
 * shared/legacy connector line) stays unresolved and keeps the historical
 * fail-safe behavior.
 */
type InboundTenantScope =
  | { resolved: true; tenantId: number | null }
  | { resolved: false };

async function resolveTenantScopeFromToNumber(
  to: string | null,
): Promise<InboundTenantScope> {
  if (!to) return { resolved: false };
  const rows = await db
    .select({
      tenantId: sosSettingsTable.tenantId,
      smsFromNumber: sosSettingsTable.smsFromNumber,
    })
    .from(sosSettingsTable)
    .where(sql`${sosSettingsTable.smsFromNumber} is not null`);
  const matches = rows.filter((r) => normalizeToE164(r.smsFromNumber) === to);
  if (matches.length !== 1) return { resolved: false };
  return { resolved: true, tenantId: matches[0].tenantId };
}

/**
 * Resolve the inbound sender to an SOS customer.
 *
 * With a resolved tenant scope (the text arrived on a number assigned to
 * exactly one settings row), matching is scoped strictly to that tenant
 * (or the legacy NULL-tenant scope) — a phone shared across businesses is no
 * longer ambiguous because the To number tells us which business was texted.
 *
 * Without tenant scope (shared/legacy number), the historical fail-safe
 * stands: a phone number that matches customers in more than one tenant
 * scope is ambiguous and we return null (log-only, no opt-in change or
 * claim) rather than mutate the wrong tenant's customer.
 */
async function findCustomerByPhone(from: string | null, scope: InboundTenantScope) {
  if (!from) return null;
  const candidates = await db
    .select()
    .from(sosCustomersTable)
    .where(
      scope.resolved
        ? and(
            sql`${sosCustomersTable.phone} is not null`,
            tenantMatch(sosCustomersTable.tenantId, scope.tenantId),
          )
        : sql`${sosCustomersTable.phone} is not null`,
    );
  const matches = candidates.filter((c) => normalizeToE164(c.phone) === from);
  if (matches.length === 0) return null;
  if (scope.resolved) return matches[0];
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
 *
 * DECISION (multi-tenant phone matches): the profile update intentionally
 * spans ALL tenants whose concierge profiles share the sender's phone number,
 * even when the SOS customer match was ambiguous (multiple tenant scopes) and
 * therefore skipped. STOP is a consent revocation attached to the phone
 * number itself — TCPA/carrier compliance requires that no tenant on this
 * platform keeps texting that number from our shared inbound line. Unlike
 * other webhook actions this is safe cross-tenant because it only ever
 * silences future sends (smsOptIn flag); it never reads, exposes, or mutates
 * one tenant's data on behalf of another. START symmetrically re-enables all
 * phone-matched profiles, restoring the pre-STOP state.
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
router.post("/sos/twilio/inbound", webhookRateLimit, async (req, res): Promise<void> => {
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
  // Per-tenant Twilio numbers: the number the text was sent TO identifies
  // the business, letting customer matching act unambiguously in that scope.
  const scope = await resolveTenantScopeFromToNumber(normalizeToE164(params.To));
  const customer = await findCustomerByPhone(normalizeToE164(params.From), scope);

  // Every inbound text is recorded in the unified messages table, matched to
  // a customer when possible; when the To number resolved a tenant, unknown
  // senders are still stamped with that tenant's scope.
  await recordInboundMessage({
    tenantId: customer?.tenantId ?? (scope.resolved ? scope.tenantId : null),
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

  // Co-op post-redemption feedback replies ("<1-5> [Y/N] comments") are
  // matched by sender phone to their newest open feedback request. Checked
  // before customer-scoped keywords because perk-wallet customers may not
  // exist as SOS customers, and a leading 1-5 rating never collides with
  // STOP/START/YES keywords (already handled above).
  if (await handleInboundCoopFeedback(fromNumber, body)) {
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

// ── Twilio inbound voice webhook ─────────────────────────────────────────────

/** Escape a string for safe interpolation into TwiML text nodes/attributes. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Verify a Twilio webhook request. Returns "ok" when the signature is valid,
 * "invalid" when a token is configured but the signature doesn't check out,
 * and "simulated" when no Twilio auth token exists at all — in that mode no
 * real Twilio traffic can arrive, so the endpoint stays usable for local/dev
 * simulation, consistent with the simulated-SMS pattern.
 */
async function checkTwilioVoiceSignature(
  req: Request,
): Promise<"ok" | "invalid" | "simulated"> {
  const authToken = await getTwilioAuthToken();
  if (!authToken) return "simulated";
  const signature = req.header("X-Twilio-Signature") ?? "";
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;
  return twilio.validateRequest(authToken, signature, url, params) ? "ok" : "invalid";
}

// Public endpoint Twilio calls when a phone call arrives ("A call comes in").
// Greets the caller with the business's branding, bridges them to the SMS
// receptionist (texts a booking link so the existing SMS intelligence takes
// over), and falls back to recording a voicemail surfaced to staff.
router.post("/sos/twilio/voice", async (req, res): Promise<void> => {
  const sigCheck = await checkTwilioVoiceSignature(req);
  if (sigCheck === "invalid") {
    logger.warn("Rejected inbound voice webhook: invalid Twilio signature");
    res.status(403).json({ message: "Invalid Twilio signature" });
    return;
  }
  if (sigCheck === "simulated") {
    logger.info("Inbound voice webhook handled in simulated mode (no Twilio credentials)");
  }

  const params = (req.body ?? {}) as Record<string, string>;
  const fromNumber = normalizeToE164(params.From) ?? params.From ?? null;
  // Same tenant resolution as inbound SMS: the number the call was placed TO
  // identifies the business.
  const scope = await resolveTenantScopeFromToNumber(normalizeToE164(params.To));
  const customer = await findCustomerByPhone(normalizeToE164(params.From), scope);
  const tenantId = customer?.tenantId ?? (scope.resolved ? scope.tenantId : null);
  const settings = await resolveSettings(tenantId);
  const businessName = settings.businessName?.trim() || "our team";

  // The call itself is an interaction on the customer timeline.
  await recordInboundMessage({
    tenantId,
    customerId: customer?.id ?? null,
    clientProfileId: customer?.clientProfileId ?? null,
    fromNumber,
    body: `Inbound phone call answered by the AI receptionist`,
    providerSid: params.CallSid ?? null,
    kind: "voice_call",
    channel: "voice",
    payload: { callSid: params.CallSid ?? null, toNumber: params.To ?? null },
  });

  // Bridge to the SMS receptionist: text the caller a booking link so the
  // existing SMS flow does the heavy lifting. Gated on the receptionist
  // toggle; opt-outs and missing numbers are handled by the shared guards.
  let smsBridged = false;
  if (settings.aiReceptionistEnabled && fromNumber) {
    let bookingUrl = publicAppBaseUrl();
    if (tenantId != null) {
      const [tenant] = await db
        .select({ subdomain: tenantsTable.subdomain })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId));
      if (tenant?.subdomain) bookingUrl = `${bookingUrl}/book/${tenant.subdomain}`;
    }
    const greetName = customer?.name ? ` ${customer.name}` : "";
    const sent = await sendMessageSafe({
      tenantId,
      customerId: customer?.id ?? null,
      clientProfileId: customer?.clientProfileId ?? null,
      toNumber: fromNumber,
      kind: "ai_followup",
      body: `Hi${greetName}! Thanks for calling ${businessName}. Book a time that works for you here: ${bookingUrl} — or just reply to this text and we'll help you out.`,
      context: { trigger: "inbound_voice_call", callSid: params.CallSid ?? null },
    });
    smsBridged = sent != null && sent.status !== "skipped" && sent.status !== "failed";
  }

  const greeting = smsBridged
    ? `Thanks for calling ${businessName}. We just texted you a booking link, and you can reply to that text any time — our virtual receptionist will take it from there.`
    : `Thanks for calling ${businessName}.`;

  const voiceTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(greeting)} If you'd like to leave a message instead, stay on the line and speak after the tone. Press the pound key when you're done.</Say><Record action="/api/sos/twilio/voice/recording" method="POST" maxLength="120" finishOnKey="#" playBeep="true"/><Say>We didn't catch a message. Goodbye!</Say></Response>`;
  res.type("text/xml").send(voiceTwiml);
});

// Public endpoint Twilio POSTs the voicemail recording details to (the
// <Record action> URL above). Logs the voicemail on the customer timeline so
// staff can follow up.
router.post("/sos/twilio/voice/recording", async (req, res): Promise<void> => {
  const sigCheck = await checkTwilioVoiceSignature(req);
  if (sigCheck === "invalid") {
    logger.warn("Rejected voice recording callback: invalid Twilio signature");
    res.status(403).json({ message: "Invalid Twilio signature" });
    return;
  }

  const params = (req.body ?? {}) as Record<string, string>;
  const fromNumber = normalizeToE164(params.From) ?? params.From ?? null;
  const scope = await resolveTenantScopeFromToNumber(normalizeToE164(params.To));
  const customer = await findCustomerByPhone(normalizeToE164(params.From), scope);
  const recordingUrl = params.RecordingUrl?.trim() || null;
  const duration = params.RecordingDuration ?? null;

  await recordInboundMessage({
    tenantId: customer?.tenantId ?? (scope.resolved ? scope.tenantId : null),
    customerId: customer?.id ?? null,
    clientProfileId: customer?.clientProfileId ?? null,
    fromNumber,
    body: `Voicemail${duration ? ` (${duration}s)` : ""}${recordingUrl ? `: ${recordingUrl}` : ""}`,
    providerSid: params.RecordingSid ?? params.CallSid ?? null,
    kind: "voicemail",
    channel: "voice",
    payload: {
      callSid: params.CallSid ?? null,
      recordingSid: params.RecordingSid ?? null,
      recordingUrl,
      durationSeconds: duration != null ? Number(duration) || null : null,
    },
  });

  const byeTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks, we got your message. Someone will follow up with you soon. Goodbye!</Say><Hangup/></Response>`;
  res.type("text/xml").send(byeTwiml);
});

// ── Twilio delivery-status callback ─────────────────────────────────────────

// Public endpoint Twilio POSTs per-message delivery updates to (the
// StatusCallback URL passed on every send). Authenticated by Twilio's
// request signature, not the session.
router.post("/sos/twilio/status", webhookRateLimit, async (req, res): Promise<void> => {
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

  // Service vocabulary comes from the structured catalog (legacy serviceNames
  // string only as fallback for scopes not yet backfilled) — the same source
  // the staff booking UI suggests from, so parsing can't drift.
  const serviceNames = await getServiceNamesForScope(tenantId, settings.serviceNames);
  const parsed = await parseCallIntent(
    body.inquiry,
    body.callerName ?? null,
    new Date().toISOString(),
    serviceNames,
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
      // Use the catalog's estimated duration for the matched service when it
      // has one; otherwise fall back to the historical 60-minute default.
      let durationMinutes = 60;
      if (parsed.serviceType) {
        const catalog = await listServicesForScope(tenantId);
        const matched = catalog.find(
          (s) => s.isActive && s.name.toLowerCase() === parsed.serviceType!.toLowerCase(),
        );
        if (matched?.durationMinutes) durationMinutes = matched.durationMinutes;
      }
      const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);
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

router.get("/sos/reports/summary", async (req, res): Promise<void> => {
  const since = new Date();
  since.setDate(since.getDate() - 13);
  since.setHours(0, 0, 0, 0);

  // Strict business scope, same semantics as the dashboard: with tenant
  // context only that tenant's operational rows; otherwise legacy
  // (NULL-tenant) rows only. Concierge automation messages always belong to
  // a tenant, so the automation section filters by tenant when scoped and
  // stays agency-wide on the legacy view.
  const tenantId = tenantIdFrom(req);
  const scope = (col: PgColumn) => tenantMatch(col, tenantId);
  const automationScope =
    tenantId == null ? undefined : eq(messagesTable.tenantId, tenantId);

  const [
    visitsByDay,
    waitRows,
    filled,
    cancelledCount,
    callOutcomes,
    revenue,
    tipsCollectedRows,
    tipsByStaffRows,
    automationByJobStatus,
    automationByDay,
    automationFailureReasons,
  ] = await Promise.all([
      db
        .select({
          day: sql<string>`to_char(${sosVisitsTable.checkedInAt}, 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(sosVisitsTable)
        .where(and(gte(sosVisitsTable.checkedInAt, since), scope(sosVisitsTable.tenantId)))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({
          avg: sql<string>`coalesce(avg(extract(epoch from (${sosVisitsTable.serviceStartedAt} - ${sosVisitsTable.checkedInAt})) / 60), 0)`,
        })
        .from(sosVisitsTable)
        .where(and(sql`${sosVisitsTable.serviceStartedAt} is not null`, scope(sosVisitsTable.tenantId))),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosAppointmentsTable)
        .where(and(eq(sosAppointmentsTable.source, "waitlist_fill"), scope(sosAppointmentsTable.tenantId))),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosAppointmentsTable)
        .where(and(eq(sosAppointmentsTable.status, "cancelled"), scope(sosAppointmentsTable.tenantId))),
      db
        .select({
          outcome: sosCallsTable.outcome,
          count: sql<number>`count(*)::int`,
        })
        .from(sosCallsTable)
        .where(scope(sosCallsTable.tenantId))
        .groupBy(sosCallsTable.outcome),
      db
        .select({
          total: sql<string>`coalesce(sum(${sosVisitsTable.paymentAmount}), 0)`,
        })
        .from(sosVisitsTable)
        .where(scope(sosVisitsTable.tenantId)),
      // Tips collected at checkout over the window — kept strictly separate
      // from totalRevenue (tips never inflate service revenue).
      db
        .select({
          total: sql<string>`coalesce(sum(${sosVisitsTable.tipAmount}), 0)`,
        })
        .from(sosVisitsTable)
        .where(
          and(
            gte(sosVisitsTable.checkedOutAt, since),
            scope(sosVisitsTable.tenantId),
          ),
        ),
      // Tips distributed to this scope's staff via the gratuity ledger.
      db
        .select({
          staffId: sosGratuityLedgerTable.staffId,
          name: sosStaffMembersTable.name,
          total: sql<string>`coalesce(sum(${sosGratuityLedgerTable.amount}), 0)`,
        })
        .from(sosGratuityLedgerTable)
        .innerJoin(
          sosStaffMembersTable,
          eq(sosGratuityLedgerTable.staffId, sosStaffMembersTable.id),
        )
        .where(
          and(
            gte(sosGratuityLedgerTable.createdAt, since),
            scope(sosGratuityLedgerTable.tenantId),
          ),
        )
        .groupBy(sosGratuityLedgerTable.staffId, sosStaffMembersTable.name),
      db
        .select({
          jobType: messagesTable.kind,
          status: messagesTable.status,
          count: sql<number>`count(*)::int`,
        })
        .from(messagesTable)
        .where(and(gte(messagesTable.createdAt, since), eq(messagesTable.origin, "concierge"), automationScope))
        .groupBy(messagesTable.kind, messagesTable.status),
      db
        .select({
          day: sql<string>`to_char(${messagesTable.createdAt}, 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(messagesTable)
        .where(and(gte(messagesTable.createdAt, since), eq(messagesTable.origin, "concierge"), automationScope))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      // Failed/skipped reason breakdown over the same 14-day window: group by
      // the stored error code so the business can see *why* automation sends
      // didn't go out (opt-outs, missing phone numbers, provider errors).
      db
        .select({
          status: messagesTable.status,
          errorCode: messagesTable.errorCode,
          count: sql<number>`count(*)::int`,
        })
        .from(messagesTable)
        .where(
          and(
            gte(messagesTable.createdAt, since),
            eq(messagesTable.origin, "concierge"),
            inArray(messagesTable.status, ["failed", "skipped"]),
            automationScope,
          ),
        )
        .groupBy(messagesTable.status, messagesTable.errorCode),
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

  // Human-readable labels for the internal guard codes written by the
  // messaging layer; anything else is a provider (Twilio) error code.
  const REASON_LABELS: Record<string, string> = {
    opted_out: "Customer opted out of texts",
    no_phone: "No phone number on file",
    unsupported_channel: "Unsupported contact channel",
    invalid_number: "Invalid phone number",
  };
  const reasonLabel = (code: string | null): string => {
    if (code == null) return "No reason recorded";
    if (REASON_LABELS[code]) return REASON_LABELS[code];
    return /^\d+$/.test(code) ? `Provider error ${code}` : code.replace(/_/g, " ");
  };
  const failureReasons = automationFailureReasons
    .map((r) => ({
      errorCode: r.errorCode,
      label: reasonLabel(r.errorCode),
      status: r.status as "failed" | "skipped",
      count: r.count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const automation = {
    remindersSent: jobStats.get("send_reminder")?.delivered ?? 0,
    nudgesSent: jobStats.get("rebooking_nudge")?.delivered ?? 0,
    deliveredCount: byJobType.reduce((n, s) => n + s.delivered, 0),
    failedCount: byJobType.reduce((n, s) => n + s.failed, 0),
    skippedCount: byJobType.reduce((n, s) => n + s.skipped, 0),
    byJobType,
    messagesByDay: automationByDay,
    failureReasons,
  };

  const tipsByStaff = tipsByStaffRows.map((r) => ({
    staffId: r.staffId,
    name: r.name,
    total: parseFloat(r.total),
  }));
  const tips = {
    collected: parseFloat(tipsCollectedRows[0].total),
    distributed: Math.round(tipsByStaff.reduce((n, t) => n + t.total, 0) * 100) / 100,
    byStaff: tipsByStaff,
  };

  const slotsFilled = filled[0].n;
  const cancelled = cancelledCount[0].n;
  res.json(
    GetSosReportsSummaryResponse.parse({
      tips,
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
