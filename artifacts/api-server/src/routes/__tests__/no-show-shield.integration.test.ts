import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

// ── Stripe mock ──────────────────────────────────────────────────────────────
// Deposit holds are backed by real Stripe Checkout authorizations; tests run
// against a fake Stripe client that records calls.
const stripeCalls = {
  sessionsCreated: [] as Array<Record<string, unknown>>,
  captures: [] as Array<{ id: string; amount_to_capture: number }>,
  cancels: [] as string[],
  expired: [] as string[],
};
let sessionCounter = 0;
let failNextSessionCreate: string | null = null;
vi.mock("../../lib/stripeClient", () => ({
  isStripeConfigured: () => true,
  getUncachableStripeClient: async () => ({
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          if (failNextSessionCreate) {
            const msg = failNextSessionCreate;
            failNextSessionCreate = null;
            throw new Error(msg);
          }
          stripeCalls.sessionsCreated.push(params);
          const id = `cs_test_${++sessionCounter}_${Date.now()}`;
          return { id, url: `https://checkout.stripe.test/${id}`, payment_intent: null };
        },
        expire: async (id: string) => {
          stripeCalls.expired.push(id);
          return { id, status: "expired" };
        },
      },
    },
    paymentIntents: {
      capture: async (id: string, opts: { amount_to_capture: number }) => {
        stripeCalls.captures.push({ id, amount_to_capture: opts.amount_to_capture });
        return { id, status: "succeeded" };
      },
      cancel: async (id: string) => {
        stripeCalls.cancels.push(id);
        return { id, status: "canceled" };
      },
    },
  }),
  getStripeSync: async () => {
    throw new Error("not used in tests");
  },
}));
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  sosSettingsTable,
  sosCustomersTable,
  sosAppointmentsTable,
  sosDepositHoldsTable,
  sosWaitlistTable,
  messagesTable,
} from "@workspace/db";
import { eq, inArray, isNull } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the No-Show Shield & Deposits engine:
//  - deposit hold creation on every booking source (staff, AI receptionist,
//    waitlist fill)
//  - window-based release vs. capture on cancellation
//  - no-show capture
//  - unchanged behavior when the policy is disabled or the module is not
//    provisioned
//
// Isolation: throwaway tenant + tenant_modules row per run; the legacy/global
// settings record's policy fields are snapshotted and restored.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL; // force fallback parser
delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

const RUN = `nss-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;
let moduleId: number;
let moduleCreated = false;
let customerId: number;
let legacySettingsId: number;
let legacyBefore: {
  noShowShieldEnabled: boolean;
  noShowDepositAmount: string;
  noShowCancellationWindowHours: number;
  noShowFee: string;
  aiReceptionistEnabled: boolean;
};

const createdAppointmentIds: number[] = [];

async function bookAppointment(startsAt: Date, service = `svc-${RUN}`) {
  const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
  const res = await agent
    .post("/api/sos/appointments")
    .send({
      customerId,
      serviceType: service,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      source: "staff",
    })
    .expect(201);
  createdAppointmentIds.push(res.body.id);
  return res.body;
}

async function setPolicy(update: Record<string, unknown>) {
  await agent.patch("/api/sos/settings").send(update).expect(200);
}

async function holdForAppointment(appointmentId: number) {
  const [hold] = await db
    .select()
    .from(sosDepositHoldsTable)
    .where(eq(sosDepositHoldsTable.appointmentId, appointmentId));
  return hold ?? null;
}

/**
 * Simulate the customer completing the Stripe Checkout session: apply the
 * (signature-verified in prod) checkout.session.completed webhook event,
 * which flips the hold from pending_authorization to held.
 */
async function authorizeHold(appointmentId: number) {
  const { applyStripeDepositEvent } = await import("../../lib/noShowShield");
  const hold = await holdForAppointment(appointmentId);
  if (!hold?.stripeCheckoutSessionId) throw new Error("hold has no checkout session");
  await applyStripeDepositEvent({
    type: "checkout.session.completed",
    data: {
      object: { id: hold.stripeCheckoutSessionId, payment_intent: `pi_test_${hold.id}` },
    },
  });
  return (await holdForAppointment(appointmentId))!;
}

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  // Module row (seeded by the running server; created here if absent).
  const [existingModule] = await db
    .select()
    .from(modulesTable)
    .where(eq(modulesTable.slug, "no_show_shield"));
  if (existingModule) {
    moduleId = existingModule.id;
  } else {
    const [created] = await db
      .insert(modulesTable)
      .values({
        name: "No-Show Shield & Deposits",
        category: "Public Core Service Modules",
        categorySlug: "operations",
        description: "test",
        wholesalePrice: "49.00",
        isActive: true,
        slug: "no_show_shield",
      })
      .returning();
    moduleId = created.id;
    moduleCreated = true;
  }

  // Provision the module for a throwaway tenant.
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `NSS ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
  await db.insert(tenantModulesTable).values({ tenantId, moduleId });

  // Snapshot the legacy settings we mutate.
  const [legacy] = await db
    .select()
    .from(sosSettingsTable)
    .where(isNull(sosSettingsTable.tenantId))
    .orderBy(sosSettingsTable.id)
    .limit(1);
  const row =
    legacy ??
    (await db.insert(sosSettingsTable).values({}).returning())[0];
  legacySettingsId = row.id;
  legacyBefore = {
    noShowShieldEnabled: row.noShowShieldEnabled,
    noShowDepositAmount: row.noShowDepositAmount,
    noShowCancellationWindowHours: row.noShowCancellationWindowHours,
    noShowFee: row.noShowFee,
    aiReceptionistEnabled: row.aiReceptionistEnabled,
  };
  // Note: waitlist auto-fill is deliberately left untouched — every booking
  // in this file uses a unique per-run service name, so cancellations never
  // match anyone else's waitlist entries even when auto-fill is on. Other
  // test files run in parallel and depend on the auto-fill flag staying true.
  await db
    .update(sosSettingsTable)
    .set({ aiReceptionistEnabled: true })
    .where(eq(sosSettingsTable.id, legacySettingsId));

  const [customer] = await db
    .insert(sosCustomersTable)
    .values({ name: `NSS Customer ${RUN}`, phone: null, smsOptIn: false })
    .returning();
  customerId = customer.id;
});

afterAll(async () => {
  // Restore the legacy settings record.
  await db
    .update(sosSettingsTable)
    .set(legacyBefore)
    .where(eq(sosSettingsTable.id, legacySettingsId));

  // Appointments cascade-delete their deposit holds.
  const aiCustomers = await db
    .select({ id: sosCustomersTable.id })
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.phone, `+1999${RUN.slice(-7).replace(/\D/g, "0")}`));
  const customerIds = [customerId, ...aiCustomers.map((c) => c.id)];
  const appts = await db
    .select({ id: sosAppointmentsTable.id })
    .from(sosAppointmentsTable)
    .where(inArray(sosAppointmentsTable.customerId, customerIds));
  // sos_calls references appointments; clear the reference rows first.
  const { sosCallsTable } = await import("@workspace/db");
  if (appts.length > 0) {
    await db
      .delete(sosCallsTable)
      .where(inArray(sosCallsTable.appointmentId, appts.map((a) => a.id)));
    await db
      .delete(sosAppointmentsTable)
      .where(inArray(sosAppointmentsTable.id, appts.map((a) => a.id)));
  }
  await db
    .delete(sosCallsTable)
    .where(eq(sosCallsTable.fromNumber, aiFromNumber));
  await db.delete(sosWaitlistTable).where(inArray(sosWaitlistTable.customerId, customerIds));
  await db.delete(messagesTable).where(inArray(messagesTable.customerId, customerIds));
  await db.delete(sosCustomersTable).where(inArray(sosCustomersTable.id, customerIds));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId)); // cascades tenant_modules
  if (moduleCreated) await db.delete(modulesTable).where(eq(modulesTable.id, moduleId));
});

const aiFromNumber = `+1999${RUN.slice(-7).replace(/\D/g, "0")}`;

describe("policy inactive → booking behaves exactly as today", () => {
  it("creates no hold when the policy is disabled", async () => {
    await setPolicy({ noShowShieldEnabled: false });
    const appt = await bookAppointment(new Date(Date.now() + 72 * 3600_000));
    expect(appt.deposit).toBeNull();
    expect(await holdForAppointment(appt.id)).toBeNull();

    // Cancellation stays plain too.
    const res = await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    expect(res.body.appointment.status).toBe("cancelled");
    expect(res.body.appointment.deposit).toBeNull();
  });

  it("creates no hold when the module is not provisioned, even if enabled", async () => {
    // Provisioning is global for the legacy SOS record — snapshot and remove
    // every subscription to the module, then restore them afterwards.
    const existing = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.moduleId, moduleId));
    await db.delete(tenantModulesTable).where(eq(tenantModulesTable.moduleId, moduleId));
    try {
      await setPolicy({ noShowShieldEnabled: true });

      const settings = await agent.get("/api/sos/settings").expect(200);
      expect(settings.body.noShowShieldEnabled).toBe(true);
      expect(settings.body.noShowShieldProvisioned).toBe(false);

      const appt = await bookAppointment(new Date(Date.now() + 72 * 3600_000));
      expect(appt.deposit).toBeNull();
    } finally {
      if (existing.length > 0) {
        await db.insert(tenantModulesTable).values(
          existing.map(({ id: _id, ...row }) => row),
        );
      }
    }
  });
});

describe("policy active → holds on every booking source", () => {
  beforeAll(async () => {
    await setPolicy({
      noShowShieldEnabled: true,
      noShowDepositAmount: 30,
      noShowCancellationWindowHours: 24,
      noShowFee: 20,
    });
  });

  it("exposes the policy (and provisioning state) on settings", async () => {
    const res = await agent.get("/api/sos/settings").expect(200);
    expect(res.body.noShowShieldEnabled).toBe(true);
    expect(res.body.noShowShieldProvisioned).toBe(true);
    expect(res.body.noShowDepositAmount).toBe(30);
    expect(res.body.noShowCancellationWindowHours).toBe(24);
    expect(res.body.noShowFee).toBe(20);
  });

  it("staff booking creates a real Stripe authorization with snapshotted terms", async () => {
    const appt = await bookAppointment(new Date(Date.now() + 72 * 3600_000));
    expect(appt.deposit).not.toBeNull();
    expect(appt.deposit.status).toBe("pending_authorization");
    expect(appt.deposit.checkoutUrl).toContain("https://checkout.stripe.test/");
    expect(appt.deposit.depositAmount).toBe(30);
    expect(appt.deposit.feeAmount).toBe(20);
    expect(appt.deposit.cancellationWindowHours).toBe(24);
    expect(appt.deposit.outcomeReason).toContain("card authorization");

    // The Checkout session is a manual-capture card authorization for the
    // deposit amount in cents.
    const session = stripeCalls.sessionsCreated.at(-1) as any;
    expect(session.mode).toBe("payment");
    expect(session.payment_intent_data.capture_method).toBe("manual");
    expect(session.line_items[0].price_data.unit_amount).toBe(3000);

    // The customer completing checkout (webhook) flips the hold to held.
    const held = await authorizeHold(appt.id);
    expect(held.status).toBe("held");
    expect(held.stripePaymentIntentId).toBe(`pi_test_${held.id}`);

    // Visible on the appointments list too.
    const list = await agent.get("/api/sos/appointments").expect(200);
    const found = list.body.find((a: { id: number }) => a.id === appt.id);
    expect(found.deposit.status).toBe("held");
  });

  it("surfaces a Stripe authorization failure instead of recording a paper hold", async () => {
    failNextSessionCreate = "card network unreachable";
    const appt = await bookAppointment(new Date(Date.now() + 72 * 3600_000));
    expect(appt.deposit).not.toBeNull();
    expect(appt.deposit.status).toBe("failed");
    expect(appt.deposit.outcomeReason).toContain("FAILED");
    expect(appt.deposit.outcomeReason).toContain("card network unreachable");
    expect(appt.deposit.checkoutUrl).toBeNull();
  });

  it("AI receptionist booking places a hold", async () => {
    const res = await agent
      .post("/api/sos/calls")
      .send({
        fromNumber: aiFromNumber,
        callerName: `NSS AI ${RUN}`,
        inquiry: "I'd like to book an appointment tomorrow",
      })
      .expect(201);
    expect(res.body.outcome).toBe("booked");
    expect(res.body.appointmentId).not.toBeNull();
    createdAppointmentIds.push(res.body.appointmentId);
    const hold = await holdForAppointment(res.body.appointmentId);
    expect(hold?.status).toBe("pending_authorization");
    expect(hold?.checkoutUrl).toContain("https://checkout.stripe.test/");
  });

  it("waitlist fill places a hold", async () => {
    const slotStart = new Date(Date.now() + 48 * 3600_000);
    const slotEnd = new Date(slotStart.getTime() + 3600_000);
    const [entry] = await db
      .insert(sosWaitlistTable)
      .values({
        customerId,
        desiredService: `wl-${RUN}`,
        status: "notified",
        notifiedAt: new Date(),
        openSlotStartsAt: slotStart,
        openSlotEndsAt: slotEnd,
      })
      .returning();
    const res = await agent.post(`/api/sos/waitlist/${entry.id}/claim`).expect(200);
    createdAppointmentIds.push(res.body.id);
    expect(res.body.source).toBe("waitlist_fill");
    expect(res.body.deposit?.status).toBe("pending_authorization");
    const hold = await holdForAppointment(res.body.id);
    expect(hold?.status).toBe("pending_authorization");
    expect(hold?.checkoutUrl).toContain("https://checkout.stripe.test/");
  });
});

describe("tenant-scoped bookings use the owning tenant's own policy", () => {
  let scopedCustomerId: number;

  beforeAll(async () => {
    // The provisioned test tenant gets its own settings row with DIFFERENT
    // policy terms than the legacy record; both are enabled.
    await setPolicy({
      noShowShieldEnabled: true,
      noShowDepositAmount: 30,
      noShowCancellationWindowHours: 24,
      noShowFee: 20,
    });
    await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({
        noShowShieldEnabled: true,
        noShowDepositAmount: 55,
        noShowCancellationWindowHours: 48,
        noShowFee: 45,
      })
      .expect(200);
    const [customer] = await db
      .insert(sosCustomersTable)
      .values({ name: `NSS Scoped ${RUN}`, tenantId, smsOptIn: false })
      .returning();
    scopedCustomerId = customer.id;
  });

  afterAll(async () => {
    const appts = await db
      .select({ id: sosAppointmentsTable.id })
      .from(sosAppointmentsTable)
      .where(eq(sosAppointmentsTable.customerId, scopedCustomerId));
    if (appts.length > 0) {
      await db
        .delete(sosAppointmentsTable)
        .where(inArray(sosAppointmentsTable.id, appts.map((a) => a.id)));
    }
    await db.delete(sosCustomersTable).where(eq(sosCustomersTable.id, scopedCustomerId));
  });

  it("snapshots the tenant's own terms on the hold, not the legacy ones", async () => {
    const startsAt = new Date(Date.now() + 72 * 3600_000);
    const res = await agent
      .post("/api/sos/appointments")
      .set("x-tenant-id", String(tenantId))
      .send({
        customerId: scopedCustomerId,
        serviceType: `svc-scoped-${RUN}`,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3600_000).toISOString(),
        source: "staff",
      })
      .expect(201);
    createdAppointmentIds.push(res.body.id);
    expect(res.body.deposit).not.toBeNull();
    expect(res.body.deposit.depositAmount).toBe(55);
    expect(res.body.deposit.feeAmount).toBe(45);
    expect(res.body.deposit.cancellationWindowHours).toBe(48);
  });

  it("places no hold when the tenant's own toggle is off, even though legacy is on", async () => {
    await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ noShowShieldEnabled: false })
      .expect(200);
    const startsAt = new Date(Date.now() + 72 * 3600_000);
    const res = await agent
      .post("/api/sos/appointments")
      .set("x-tenant-id", String(tenantId))
      .send({
        customerId: scopedCustomerId,
        serviceType: `svc-scoped-off-${RUN}`,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 3600_000).toISOString(),
        source: "staff",
      })
      .expect(201);
    createdAppointmentIds.push(res.body.id);
    expect(res.body.deposit).toBeNull();
    await agent
      .patch(`/api/tenants/${tenantId}/settings`)
      .send({ noShowShieldEnabled: true })
      .expect(200);
  });

  it("requires the tenant's OWN module subscription, not someone else's", async () => {
    // A second tenant with shield enabled but no no_show_shield subscription.
    const [other] = await db
      .insert(tenantsTable)
      .values({ brandName: `NSS Other ${RUN}`, subdomain: `${RUN}-o`, status: "active" })
      .returning({ id: tenantsTable.id });
    try {
      await agent
        .patch(`/api/tenants/${other.id}/settings`)
        .send({ noShowShieldEnabled: true })
        .expect(200);
      const [otherCustomer] = await db
        .insert(sosCustomersTable)
        .values({ name: `NSS Other Cust ${RUN}`, tenantId: other.id, smsOptIn: false })
        .returning();
      const startsAt = new Date(Date.now() + 72 * 3600_000);
      const res = await agent
        .post("/api/sos/appointments")
        .set("x-tenant-id", String(other.id))
        .send({
          customerId: otherCustomer.id,
          serviceType: `svc-other-${RUN}`,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 3600_000).toISOString(),
          source: "staff",
        })
        .expect(201);
      expect(res.body.deposit).toBeNull();
    } finally {
      // Cascades settings, customers, appointments.
      await db.delete(tenantsTable).where(eq(tenantsTable.id, other.id));
    }
  });
});

describe("deposit notification texts", () => {
  let smsCustomerId: number;
  const smsPhone = `+1888${RUN.slice(-7).replace(/\D/g, "1")}`;

  async function bookForSmsCustomer(startsAt: Date) {
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const res = await agent
      .post("/api/sos/appointments")
      .send({
        customerId: smsCustomerId,
        serviceType: `svc-sms-${RUN}`,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        source: "staff",
      })
      .expect(201);
    createdAppointmentIds.push(res.body.id);
    return res.body;
  }

  async function depositMessages() {
    return db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.customerId, smsCustomerId));
  }

  beforeAll(async () => {
    await setPolicy({
      noShowShieldEnabled: true,
      noShowDepositAmount: 30,
      noShowCancellationWindowHours: 24,
      noShowFee: 20,
    });
    const [customer] = await db
      .insert(sosCustomersTable)
      .values({ name: `NSS Sms ${RUN}`, phone: smsPhone, smsOptIn: true })
      .returning();
    smsCustomerId = customer.id;
  });

  afterAll(async () => {
    await db.delete(messagesTable).where(eq(messagesTable.customerId, smsCustomerId));
    const appts = await db
      .select({ id: sosAppointmentsTable.id })
      .from(sosAppointmentsTable)
      .where(eq(sosAppointmentsTable.customerId, smsCustomerId));
    if (appts.length > 0) {
      await db
        .delete(sosAppointmentsTable)
        .where(inArray(sosAppointmentsTable.id, appts.map((a) => a.id)));
    }
    await db.delete(sosCustomersTable).where(eq(sosCustomersTable.id, smsCustomerId));
  });

  it("texts the deposit terms once the customer authorizes the card", async () => {
    const appt = await bookForSmsCustomer(new Date(Date.now() + 72 * 3600_000));
    // No text yet at booking: no money is held until the card is authorized.
    expect(appt.deposit.status).toBe("pending_authorization");
    expect(
      (await depositMessages()).filter((m) => m.kind === "deposit_update"),
    ).toHaveLength(0);
    const held = await authorizeHold(appt.id);
    expect(held.status).toBe("held");
    const msgs = await depositMessages();
    const heldMsgs = msgs.filter((m) => m.kind === "deposit_update");
    expect(heldMsgs).toHaveLength(1);
    expect(heldMsgs[0].body).toContain("$30.00 deposit hold");
    expect(heldMsgs[0].body).toContain("24h");
    expect(heldMsgs[0].body).toContain("$20.00 fee");
    expect(heldMsgs[0].origin).toBe("operational");
    expect(["simulated", "sent", "delivered"]).toContain(heldMsgs[0].status);
    // Visible in the SOS comms log.
    const log = await agent.get("/api/sos/messages").expect(200);
    expect(
      log.body.some(
        (m: { id: number; kind: string }) =>
          m.id === heldMsgs[0].id && m.kind === "deposit_update",
      ),
    ).toBe(true);
  });

  it("texts a release outcome when cancelling outside the window", async () => {
    const appt = await bookForSmsCustomer(new Date(Date.now() + 72 * 3600_000));
    await authorizeHold(appt.id);
    await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    const msgs = await depositMessages();
    const released = msgs.filter((m) => m.body.includes("fully released"));
    expect(released).toHaveLength(1);
    expect(released[0].kind).toBe("deposit_update");
    expect(released[0].body).toContain("no fee was charged");
  });

  it("texts the fee outcome when cancelling inside the window", async () => {
    const appt = await bookForSmsCustomer(new Date(Date.now() + 2 * 3600_000));
    await authorizeHold(appt.id);
    await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    const msgs = await depositMessages();
    const captured = msgs.filter((m) => m.body.includes("late-cancellation fee"));
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toContain("$20.00");
  });

  it("texts the no-show fee outcome when a no-show is captured", async () => {
    const appt = await bookForSmsCustomer(new Date(Date.now() - 3600_000));
    await authorizeHold(appt.id);
    await agent.post(`/api/sos/appointments/${appt.id}/no-show`).expect(200);
    const msgs = await depositMessages();
    const noShow = msgs.filter((m) => m.body.includes("no-show fee"));
    expect(noShow).toHaveLength(1);
    expect(noShow[0].body).toContain("$20.00");
  });

  it("sends nothing (not even a skipped row) for a customer without phone/opt-in", async () => {
    // The main test customer has phone=null and smsOptIn=false.
    const before = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.customerId, customerId));
    const appt = await bookAppointment(new Date(Date.now() + 72 * 3600_000));
    await authorizeHold(appt.id);
    await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    const after = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.customerId, customerId));
    expect(
      after.filter((m) => m.kind === "deposit_update"),
    ).toHaveLength(0);
    expect(after.length).toBe(before.length);
  });
});

describe("cancellation & no-show enforcement", () => {
  beforeAll(async () => {
    await setPolicy({
      noShowShieldEnabled: true,
      noShowDepositAmount: 30,
      noShowCancellationWindowHours: 24,
      noShowFee: 20,
    });
  });

  it("cancelling outside the window voids the Stripe authorization", async () => {
    const appt = await bookAppointment(new Date(Date.now() + 72 * 3600_000));
    const held = await authorizeHold(appt.id);
    const res = await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    expect(res.body.appointment.status).toBe("cancelled");
    expect(res.body.appointment.deposit.status).toBe("released");
    expect(res.body.appointment.deposit.outcomeReason).toContain("released");
    expect(stripeCalls.cancels).toContain(held.stripePaymentIntentId);
  });

  it("cancelling inside the window captures the fee from the authorization", async () => {
    const appt = await bookAppointment(new Date(Date.now() + 2 * 3600_000));
    const held = await authorizeHold(appt.id);
    const res = await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    expect(res.body.appointment.deposit.status).toBe("captured");
    expect(res.body.appointment.deposit.feeAmount).toBe(20);
    expect(res.body.appointment.deposit.outcomeReason).toContain("fee");
    expect(stripeCalls.captures).toContainEqual({
      id: held.stripePaymentIntentId,
      amount_to_capture: 2000,
    });
  });

  it("cancelling inside the window with an unauthorized card surfaces the failure", async () => {
    const appt = await bookAppointment(new Date(Date.now() + 2 * 3600_000));
    const pending = await holdForAppointment(appt.id);
    // Customer never completes checkout: no money exists to capture.
    const res = await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    expect(res.body.appointment.deposit.status).toBe("failed");
    expect(res.body.appointment.deposit.outcomeReason).toContain("could NOT be charged");
    // The payment link is expired so it can't be completed after the fact.
    expect(stripeCalls.expired).toContain(pending!.stripeCheckoutSessionId);
  });

  it("voids an orphan authorization when checkout completes after settlement", async () => {
    const { applyStripeDepositEvent } = await import("../../lib/noShowShield");
    const appt = await bookAppointment(new Date(Date.now() + 2 * 3600_000));
    const pending = await holdForAppointment(appt.id);
    // Settle first (late cancel with an unauthorized card → failed)...
    await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    // ...then the customer completes the (already-expired) checkout anyway.
    await applyStripeDepositEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: pending!.stripeCheckoutSessionId!,
          payment_intent: `pi_orphan_${pending!.id}`,
        },
      },
    });
    const after = await holdForAppointment(appt.id);
    // Hold stays settled — no untracked "held" money — and the orphan
    // authorization was voided on Stripe.
    expect(after!.status).toBe("failed");
    expect(stripeCalls.cancels).toContain(`pi_orphan_${pending!.id}`);
    expect(after!.outcomeReason).toContain("automatically voided");
  });

  it("enforces the terms agreed at booking time, not current settings", async () => {
    const appt = await bookAppointment(new Date(Date.now() + 72 * 3600_000));
    await authorizeHold(appt.id);
    // Tighten the window drastically after booking; 72h out is still outside
    // the 24h window snapshotted on the hold.
    await setPolicy({ noShowCancellationWindowHours: 1000 });
    const res = await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(200);
    expect(res.body.appointment.deposit.status).toBe("released");
    await setPolicy({ noShowCancellationWindowHours: 24 });
  });

  it("marking a no-show captures the held deposit as a penalty fee", async () => {
    const appt = await bookAppointment(new Date(Date.now() - 3600_000));
    const held = await authorizeHold(appt.id);
    const res = await agent.post(`/api/sos/appointments/${appt.id}/no-show`).expect(200);
    expect(res.body.status).toBe("no_show");
    expect(res.body.deposit.status).toBe("captured");
    expect(res.body.deposit.outcomeReason).toContain("no-show");
    expect(stripeCalls.captures).toContainEqual({
      id: held.stripePaymentIntentId,
      amount_to_capture: 2000,
    });

    // Already resolved appointments can't be marked again.
    await agent.post(`/api/sos/appointments/${appt.id}/no-show`).expect(409);
    await agent.post(`/api/sos/appointments/${appt.id}/cancel`).expect(409);
  });

  it("no-show on an appointment without a hold still works (no fee context)", async () => {
    await setPolicy({ noShowShieldEnabled: false });
    const appt = await bookAppointment(new Date(Date.now() - 3600_000));
    const res = await agent.post(`/api/sos/appointments/${appt.id}/no-show`).expect(200);
    expect(res.body.status).toBe("no_show");
    expect(res.body.deposit).toBeNull();
    await setPolicy({ noShowShieldEnabled: true });
  });
});
