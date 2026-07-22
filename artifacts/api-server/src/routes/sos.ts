import { Router, type IRouter } from "express";
import {
  db,
  sosSettingsTable,
  sosResourcesTable,
  sosCustomersTable,
  sosVisitsTable,
  sosAppointmentsTable,
  sosWaitlistTable,
  sosMessagesTable,
  sosCallsTable,
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
} from "@workspace/api-zod";
import { and, desc, eq, gte, ilike, inArray, lte, ne, sql } from "drizzle-orm";
import { sendSms } from "../lib/sms";
import { parseCallIntent } from "../lib/receptionist";

const router: IRouter = Router();

// ── serializers ──────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

type CustomerRow = typeof sosCustomersTable.$inferSelect;
type VisitRow = typeof sosVisitsTable.$inferSelect;
type AppointmentRow = typeof sosAppointmentsTable.$inferSelect;

function serializeCustomer(c: CustomerRow) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    smsOptIn: c.smsOptIn,
    visitCount: c.visitCount,
    lastVisitAt: iso(c.lastVisitAt),
    createdAt: c.createdAt.toISOString(),
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

function serializeAppointment(a: AppointmentRow, customerName: string) {
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
    createdAt: a.createdAt.toISOString(),
  };
}

async function getAppointmentWithName(id: number) {
  const [row] = await db
    .select({ appt: sosAppointmentsTable, customerName: sosCustomersTable.name })
    .from(sosAppointmentsTable)
    .innerJoin(
      sosCustomersTable,
      eq(sosAppointmentsTable.customerId, sosCustomersTable.id),
    )
    .where(eq(sosAppointmentsTable.id, id));
  return row ?? null;
}

async function getSettings() {
  const [existing] = await db.select().from(sosSettingsTable).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(sosSettingsTable).values({}).returning();
  return created;
}

// ── waitlist fill engine ─────────────────────────────────────────────────────

async function broadcastOpenSlot(slotStart: Date, slotEnd: Date, service: string) {
  // Only notify entries waiting for a matching service (case-insensitive).
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
      await sendSms({
        customerId: customer.id,
        toNumber: customer.phone,
        kind: "slot_open",
        body: `Good news ${customer.name}! A ${service} slot just opened at ${slotStart.toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}. Reply YES or tap your link to claim it — first come, first served.`,
      });
      messagesSent++;
    }
  }
  return { waitlistNotified, messagesSent };
}

// ── dashboard ────────────────────────────────────────────────────────────────

router.get("/sos/dashboard", async (_req, res): Promise<void> => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [visits, resources, waitlist] = await Promise.all([
    db.select().from(sosVisitsTable).where(ne(sosVisitsTable.status, "checked_out")),
    db.select().from(sosResourcesTable),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sosWaitlistTable)
      .where(eq(sosWaitlistTable.status, "waiting")),
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
          ),
        ),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosMessagesTable)
        .where(gte(sosMessagesTable.createdAt, startOfDay)),
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(sosCallsTable)
        .where(gte(sosCallsTable.createdAt, startOfDay)),
      db
        .select({
          total: sql<string>`coalesce(sum(${sosVisitsTable.paymentAmount}), 0)`,
        })
        .from(sosVisitsTable)
        .where(gte(sosVisitsTable.checkedInAt, startOfDay)),
      db
        .select({
          avg: sql<string>`coalesce(avg(extract(epoch from (${sosVisitsTable.serviceStartedAt} - ${sosVisitsTable.checkedInAt})) / 60), 0)`,
        })
        .from(sosVisitsTable)
        .where(sql`${sosVisitsTable.serviceStartedAt} is not null`),
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

router.get("/sos/settings", async (_req, res): Promise<void> => {
  const s = await getSettings();
  res.json(
    GetSosSettingsResponse.parse({
      id: s.id,
      businessName: s.businessName,
      industryType: s.industryType,
      resourceLabel: s.resourceLabel,
      aiReceptionistEnabled: s.aiReceptionistEnabled,
      waitlistAutoFillEnabled: s.waitlistAutoFillEnabled,
      smsFromNumber: s.smsFromNumber,
      updatedAt: s.updatedAt.toISOString(),
    }),
  );
});

router.patch("/sos/settings", async (req, res): Promise<void> => {
  const body = UpdateSosSettingsBody.parse(req.body);
  const s = await getSettings();
  const [updated] = await db
    .update(sosSettingsTable)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(sosSettingsTable.id, s.id))
    .returning();
  res.json(
    UpdateSosSettingsResponse.parse({
      id: updated.id,
      businessName: updated.businessName,
      industryType: updated.industryType,
      resourceLabel: updated.resourceLabel,
      aiReceptionistEnabled: updated.aiReceptionistEnabled,
      waitlistAutoFillEnabled: updated.waitlistAutoFillEnabled,
      smsFromNumber: updated.smsFromNumber,
      updatedAt: updated.updatedAt.toISOString(),
    }),
  );
});

// ── resources ────────────────────────────────────────────────────────────────

async function serializeResources() {
  const rows = await db.select().from(sosResourcesTable).orderBy(sosResourcesTable.id);
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

router.get("/sos/resources", async (_req, res): Promise<void> => {
  res.json(ListSosResourcesResponse.parse(await serializeResources()));
});

router.post("/sos/resources", async (req, res): Promise<void> => {
  const body = CreateSosResourceBody.parse(req.body);
  const [row] = await db.insert(sosResourcesTable).values(body).returning();
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
    .where(eq(sosResourcesTable.id, id))
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
    .where(eq(sosResourcesTable.id, id))
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
  const rows = await db
    .select()
    .from(sosCustomersTable)
    .where(search ? ilike(sosCustomersTable.name, `%${search}%`) : undefined)
    .orderBy(desc(sosCustomersTable.createdAt));
  res.json(ListSosCustomersResponse.parse(rows.map(serializeCustomer)));
});

router.post("/sos/customers", async (req, res): Promise<void> => {
  const body = CreateSosCustomerBody.parse(req.body);
  const [row] = await db.insert(sosCustomersTable).values(body).returning();
  res.status(201).json(CreateSosCustomerResponse.parse(serializeCustomer(row)));
});

router.patch("/sos/customers/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = UpdateSosCustomerBody.parse(req.body);
  const [row] = await db
    .update(sosCustomersTable)
    .set(body)
    .where(eq(sosCustomersTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  res.json(UpdateSosCustomerResponse.parse(serializeCustomer(row)));
});

// ── visits (customer journey state machine) ──────────────────────────────────

async function serializeVisits(activeOnly: boolean) {
  const rows = await db
    .select({
      visit: sosVisitsTable,
      customerName: sosCustomersTable.name,
      resourceName: sosResourcesTable.name,
    })
    .from(sosVisitsTable)
    .innerJoin(sosCustomersTable, eq(sosVisitsTable.customerId, sosCustomersTable.id))
    .leftJoin(sosResourcesTable, eq(sosVisitsTable.resourceId, sosResourcesTable.id))
    .where(activeOnly ? ne(sosVisitsTable.status, "checked_out") : undefined)
    .orderBy(sosVisitsTable.checkedInAt);
  return rows.map((r) => serializeVisit(r.visit, r.customerName, r.resourceName));
}

router.get("/sos/visits", async (req, res): Promise<void> => {
  const active = req.query.active === "true";
  res.json(ListSosVisitsResponse.parse(await serializeVisits(active)));
});

router.post("/sos/visits", async (req, res): Promise<void> => {
  const body = CheckInSosVisitBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, body.customerId));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const [row] = await db
    .insert(sosVisitsTable)
    .values({
      customerId: body.customerId,
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
    .where(eq(sosVisitsTable.id, id));
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
    await sendSms({
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
  const conditions = [];
  if (from && !isNaN(from.getTime())) conditions.push(gte(sosAppointmentsTable.startsAt, from));
  if (to && !isNaN(to.getTime())) conditions.push(lte(sosAppointmentsTable.startsAt, to));

  const rows = await db
    .select({ appt: sosAppointmentsTable, customerName: sosCustomersTable.name })
    .from(sosAppointmentsTable)
    .innerJoin(sosCustomersTable, eq(sosAppointmentsTable.customerId, sosCustomersTable.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sosAppointmentsTable.startsAt);

  res.json(
    ListSosAppointmentsResponse.parse(
      rows.map((r) => serializeAppointment(r.appt, r.customerName)),
    ),
  );
});

router.post("/sos/appointments", async (req, res): Promise<void> => {
  const body = CreateSosAppointmentBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, body.customerId));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const [row] = await db
    .insert(sosAppointmentsTable)
    .values({
      customerId: body.customerId,
      serviceType: body.serviceType,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      resourceId: body.resourceId ?? null,
      notes: body.notes ?? null,
      source: body.source ?? "staff",
    })
    .returning();
  res
    .status(201)
    .json(CreateSosAppointmentResponse.parse(serializeAppointment(row, customer.name)));
});

router.post("/sos/appointments/:id/cancel", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const found = await getAppointmentWithName(id);
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

  const settings = await getSettings();
  let waitlistNotified = 0;
  let messagesSent = 0;
  if (settings.waitlistAutoFillEnabled) {
    const result = await broadcastOpenSlot(
      cancelled.startsAt,
      cancelled.endsAt,
      cancelled.serviceType,
    );
    waitlistNotified = result.waitlistNotified;
    messagesSent = result.messagesSent;
  }

  res.json(
    CancelSosAppointmentResponse.parse({
      appointment: serializeAppointment(cancelled, found.customerName),
      waitlistNotified,
      messagesSent,
    }),
  );
});

// ── waitlist ─────────────────────────────────────────────────────────────────

async function serializeWaitlist() {
  const rows = await db
    .select({ entry: sosWaitlistTable, customer: sosCustomersTable })
    .from(sosWaitlistTable)
    .innerJoin(sosCustomersTable, eq(sosWaitlistTable.customerId, sosCustomersTable.id))
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

router.get("/sos/waitlist", async (_req, res): Promise<void> => {
  res.json(ListSosWaitlistResponse.parse(await serializeWaitlist()));
});

router.post("/sos/waitlist", async (req, res): Promise<void> => {
  const body = CreateSosWaitlistEntryBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, body.customerId));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const [row] = await db.insert(sosWaitlistTable).values(body).returning();
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
  const [found] = await db
    .select({ entry: sosWaitlistTable, customer: sosCustomersTable })
    .from(sosWaitlistTable)
    .innerJoin(sosCustomersTable, eq(sosWaitlistTable.customerId, sosCustomersTable.id))
    .where(eq(sosWaitlistTable.id, id));
  if (!found) {
    res.status(404).json({ message: "Waitlist entry not found" });
    return;
  }
  const { entry, customer } = found;
  if (entry.status !== "notified" || !entry.openSlotStartsAt || !entry.openSlotEndsAt) {
    res.status(409).json({ message: "No open slot is held for this entry" });
    return;
  }
  const slotStart = entry.openSlotStartsAt;
  const slotEnd = entry.openSlotEndsAt;

  // Atomic claim: only wins if the entry is still notified (first come, first served).
  const [won] = await db
    .update(sosWaitlistTable)
    .set({ status: "booked" })
    .where(and(eq(sosWaitlistTable.id, id), eq(sosWaitlistTable.status, "notified")))
    .returning({ id: sosWaitlistTable.id });
  if (!won) {
    res.status(409).json({ message: "Slot was already claimed" });
    return;
  }

  const [appointment] = await db
    .insert(sosAppointmentsTable)
    .values({
      customerId: entry.customerId,
      serviceType: entry.desiredService,
      startsAt: slotStart,
      endsAt: slotEnd,
      source: "waitlist_fill",
    })
    .returning();

  // Everyone else who was notified for this same slot goes back to waiting.
  await db
    .update(sosWaitlistTable)
    .set({ status: "waiting", notifiedAt: null, openSlotStartsAt: null, openSlotEndsAt: null })
    .where(
      and(
        eq(sosWaitlistTable.status, "notified"),
        eq(sosWaitlistTable.openSlotStartsAt, slotStart),
        ne(sosWaitlistTable.id, id),
      ),
    );

  res.json(
    ClaimSosWaitlistSlotResponse.parse(serializeAppointment(appointment, customer.name)),
  );
});

// ── messages ─────────────────────────────────────────────────────────────────

router.get("/sos/messages", async (req, res): Promise<void> => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await db
    .select({ msg: sosMessagesTable, customerName: sosCustomersTable.name })
    .from(sosMessagesTable)
    .leftJoin(sosCustomersTable, eq(sosMessagesTable.customerId, sosCustomersTable.id))
    .orderBy(desc(sosMessagesTable.createdAt))
    .limit(limit);
  res.json(
    ListSosMessagesResponse.parse(
      rows.map(({ msg, customerName }) => ({
        id: msg.id,
        customerId: msg.customerId,
        customerName,
        toNumber: msg.toNumber,
        direction: msg.direction,
        body: msg.body,
        kind: msg.kind,
        deliveryStatus: msg.deliveryStatus,
        createdAt: msg.createdAt.toISOString(),
      })),
    ),
  );
});

router.post("/sos/messages", async (req, res): Promise<void> => {
  const body = SendSosMessageBody.parse(req.body);
  const [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, body.customerId));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  const { id } = await sendSms({
    customerId: customer.id,
    toNumber: customer.phone,
    kind: body.kind ?? "manual",
    body: body.body,
  });
  const [msg] = await db.select().from(sosMessagesTable).where(eq(sosMessagesTable.id, id));
  res.status(201).json(
    SendSosMessageResponse.parse({
      id: msg.id,
      customerId: msg.customerId,
      customerName: customer.name,
      toNumber: msg.toNumber,
      direction: msg.direction,
      body: msg.body,
      kind: msg.kind,
      deliveryStatus: msg.deliveryStatus,
      createdAt: msg.createdAt.toISOString(),
    }),
  );
});

// ── AI receptionist calls ────────────────────────────────────────────────────

function serializeCall(c: typeof sosCallsTable.$inferSelect) {
  return {
    id: c.id,
    fromNumber: c.fromNumber,
    callerName: c.callerName,
    intent: c.intent,
    transcriptSummary: c.transcriptSummary,
    outcome: c.outcome,
    appointmentId: c.appointmentId,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/sos/calls", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(sosCallsTable)
    .orderBy(desc(sosCallsTable.createdAt))
    .limit(100);
  res.json(ListSosCallsResponse.parse(rows.map(serializeCall)));
});

router.post("/sos/calls", async (req, res): Promise<void> => {
  const body = SimulateSosCallBody.parse(req.body);
  const settings = await getSettings();
  if (!settings.aiReceptionistEnabled) {
    res.status(409).json({ message: "AI receptionist is disabled in settings" });
    return;
  }

  const parsed = await parseCallIntent(
    body.inquiry,
    body.callerName ?? null,
    new Date().toISOString(),
  );

  // Find or create the customer by phone number.
  let [customer] = await db
    .select()
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.phone, body.fromNumber));
  if (!customer) {
    [customer] = await db
      .insert(sosCustomersTable)
      .values({ name: body.callerName ?? "New Caller", phone: body.fromNumber })
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
          serviceType: parsed.serviceType ?? "General service",
          startsAt,
          endsAt,
          source: "ai_receptionist",
          notes: `Booked by AI receptionist. Caller said: "${body.inquiry.slice(0, 200)}"`,
        })
        .returning();
      appointmentId = appt.id;
      outcome = "booked";
      await sendSms({
        customerId: customer.id,
        toNumber: body.fromNumber,
        kind: "ai_followup",
        body: `Hi ${customer.name}! Your ${appt.serviceType} is confirmed for ${startsAt.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Reply CHANGE to reschedule.`,
      });
    } else {
      outcome = "followup_sms";
      await sendSms({
        customerId: customer.id,
        toNumber: body.fromNumber,
        kind: "ai_followup",
        body: `Hi ${customer.name}! Thanks for calling ${settings.businessName}. Tap here to pick a time that works for you, or reply with a preferred day and time.`,
      });
    }
  } else if (parsed.intent === "question" || parsed.intent === "reschedule") {
    outcome = "followup_sms";
    await sendSms({
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
      callerName: body.callerName ?? null,
      intent: parsed.intent,
      transcriptSummary: parsed.summary,
      outcome,
      appointmentId,
    })
    .returning();

  res.status(201).json(SimulateSosCallResponse.parse(serializeCall(call)));
});

// ── reports ──────────────────────────────────────────────────────────────────

router.get("/sos/reports/summary", async (_req, res): Promise<void> => {
  const since = new Date();
  since.setDate(since.getDate() - 13);
  since.setHours(0, 0, 0, 0);

  const [visitsByDay, waitRows, filled, cancelledCount, callOutcomes, revenue] =
    await Promise.all([
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
    ]);

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
    }),
  );
});

export default router;
