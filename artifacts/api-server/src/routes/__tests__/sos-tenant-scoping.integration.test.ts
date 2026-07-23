import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for tenant scoping of the SOS operational flows: incoming
// AI receptionist calls, waitlist auto-fill on cancellation, and scoped reads.
// Tenant context is passed via the `x-tenant-id` header; requests without it
// see only legacy (NULL-tenant) rows — never another tenant's data.
//
// Isolation: two throwaway tenants per run (rows cascade on tenant delete),
// unique per-run service names and phone numbers, and no mutation of the
// legacy/global settings record.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL; // force fallback parser
delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

const RUN = `tscope-${Date.now()}-${process.pid}`;
const SERVICE = `Glowfacial ${RUN}`;

let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;

const asTenant = (id: number) => ({ "x-tenant-id": String(id) });

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Scope A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Scope B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;

  // Tenant A: receptionist off. Tenant B: receptionist on with its own
  // service vocabulary. (Auto-fill stays on by default for both.)
  await agent
    .patch(`/api/tenants/${tenantA}/settings`)
    .send({ aiReceptionistEnabled: false })
    .expect(200);
  await agent
    .patch(`/api/tenants/${tenantB}/settings`)
    .send({ aiReceptionistEnabled: true, serviceNames: SERVICE })
    .expect(200);
});

afterAll(async () => {
  // Operational rows (customers, visits, appointments, waitlist, calls,
  // resources, settings) cascade on tenant delete.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("AI receptionist calls are governed by the calling tenant's settings", () => {
  it("rejects calls for a tenant whose receptionist is disabled", async () => {
    const res = await agent
      .post("/api/sos/calls")
      .set(asTenant(tenantA))
      .send({ fromNumber: "+15550100001", inquiry: "Can I book an appointment tomorrow?" });
    expect(res.status).toBe(409);
  });

  it("handles calls for an enabled tenant using that tenant's service names", async () => {
    const res = await agent
      .post("/api/sos/calls")
      .set(asTenant(tenantB))
      .send({
        fromNumber: "+15550100002",
        callerName: "Scoped Caller",
        inquiry: `I'd like to book a ${SERVICE} tomorrow`,
      })
      .expect(201);
    expect(res.body.intent).toBe("book_appointment");
    // The fallback parser only recognizes this service because tenant B's
    // settings define it.
    expect(res.body.transcriptSummary.toLowerCase()).toContain(
      SERVICE.toLowerCase(),
    );
    expect(res.body.outcome).toBe("booked");
  });

  it("scopes the call log per tenant", async () => {
    const forB = await agent.get("/api/sos/calls").set(asTenant(tenantB)).expect(200);
    expect(
      forB.body.some((c: { fromNumber: string }) => c.fromNumber === "+15550100002"),
    ).toBe(true);

    const forA = await agent.get("/api/sos/calls").set(asTenant(tenantA)).expect(200);
    expect(forA.body).toHaveLength(0);
  });

  it("scopes the AI-booked appointment and auto-created customer to the tenant", async () => {
    const apptsB = await agent
      .get("/api/sos/appointments")
      .set(asTenant(tenantB))
      .expect(200);
    expect(
      apptsB.body.some((a: { serviceType: string }) => a.serviceType === SERVICE),
    ).toBe(true);
    const apptsA = await agent
      .get("/api/sos/appointments")
      .set(asTenant(tenantA))
      .expect(200);
    expect(apptsA.body).toHaveLength(0);

    const customersA = await agent
      .get("/api/sos/customers")
      .set(asTenant(tenantA))
      .expect(200);
    expect(
      customersA.body.some((c: { phone: string | null }) => c.phone === "+15550100002"),
    ).toBe(false);
  });
});

describe("waitlist auto-fill only reaches the cancelling tenant's entries", () => {
  let waitlistA: number;
  let waitlistB: number;

  it("notifies only the same tenant's waiting entries on cancellation", async () => {
    // A waiting customer + entry in each tenant, for the same service name.
    const custA = await agent
      .post("/api/sos/customers")
      .set(asTenant(tenantA))
      .send({ name: `Waiter A ${RUN}`, phone: "+15550100003", smsOptIn: false })
      .expect(201);
    const custB = await agent
      .post("/api/sos/customers")
      .set(asTenant(tenantB))
      .send({ name: `Waiter B ${RUN}`, phone: "+15550100004", smsOptIn: false })
      .expect(201);
    waitlistA = (
      await agent
        .post("/api/sos/waitlist")
        .set(asTenant(tenantA))
        .send({ customerId: custA.body.id, desiredService: SERVICE })
        .expect(201)
    ).body.id;
    waitlistB = (
      await agent
        .post("/api/sos/waitlist")
        .set(asTenant(tenantB))
        .send({ customerId: custB.body.id, desiredService: SERVICE })
        .expect(201)
    ).body.id;

    // Book and cancel an appointment in tenant A.
    const appt = await agent
      .post("/api/sos/appointments")
      .set(asTenant(tenantA))
      .send({
        customerId: custA.body.id,
        serviceType: SERVICE,
        startsAt: new Date(Date.now() + 48 * 3600e3).toISOString(),
        endsAt: new Date(Date.now() + 49 * 3600e3).toISOString(),
      })
      .expect(201);
    const cancelled = await agent
      .post(`/api/sos/appointments/${appt.body.id}/cancel`)
      .set(asTenant(tenantA))
      .expect(200);

    // Only tenant A's entry is notified.
    expect(cancelled.body.waitlistNotified).toBe(1);
    const listA = await agent.get("/api/sos/waitlist").set(asTenant(tenantA)).expect(200);
    expect(listA.body.find((e: { id: number }) => e.id === waitlistA)?.status).toBe(
      "notified",
    );
    const listB = await agent.get("/api/sos/waitlist").set(asTenant(tenantB)).expect(200);
    expect(listB.body.find((e: { id: number }) => e.id === waitlistB)?.status).toBe(
      "waiting",
    );
    // The tenant-scoped views only contain their own entry.
    expect(listA.body.every((e: { id: number }) => e.id !== waitlistB)).toBe(true);
    expect(listB.body.every((e: { id: number }) => e.id !== waitlistA)).toBe(true);
  });

  it("keeps a claimed slot's booking inside the entry's tenant", async () => {
    // Claiming without tenant context (or as another tenant) must fail.
    await agent.post(`/api/sos/waitlist/${waitlistA}/claim`).expect(404);
    await agent
      .post(`/api/sos/waitlist/${waitlistA}/claim`)
      .set(asTenant(tenantB))
      .expect(404);
    const claim = await agent
      .post(`/api/sos/waitlist/${waitlistA}/claim`)
      .set(asTenant(tenantA))
      .expect(200);
    expect(claim.body.serviceType).toBe(SERVICE);
    const apptsA = await agent
      .get("/api/sos/appointments")
      .set(asTenant(tenantA))
      .expect(200);
    expect(apptsA.body.some((a: { id: number }) => a.id === claim.body.id)).toBe(true);
    const apptsB = await agent
      .get("/api/sos/appointments")
      .set(asTenant(tenantB))
      .expect(200);
    expect(apptsB.body.some((a: { id: number }) => a.id === claim.body.id)).toBe(false);
  });

  it("legacy (no tenant) cancellations never reach tenant-scoped entries", async () => {
    // Legacy customer + appointment for the same service, no tenant header.
    const legacyCust = await agent
      .post("/api/sos/customers")
      .send({ name: `Legacy ${RUN}`, phone: "+15550100005", smsOptIn: false })
      .expect(201);
    const appt = await agent
      .post("/api/sos/appointments")
      .send({
        customerId: legacyCust.body.id,
        serviceType: SERVICE,
        startsAt: new Date(Date.now() + 72 * 3600e3).toISOString(),
        endsAt: new Date(Date.now() + 73 * 3600e3).toISOString(),
      })
      .expect(201);
    const cancelled = await agent
      .post(`/api/sos/appointments/${appt.body.id}/cancel`)
      .expect(200);

    // Tenant B's entry is still waiting — the legacy broadcast can't see it.
    expect(cancelled.body.waitlistNotified).toBe(0);
    const listB = await agent.get("/api/sos/waitlist").set(asTenant(tenantB)).expect(200);
    expect(listB.body.find((e: { id: number }) => e.id === waitlistB)?.status).toBe(
      "waiting",
    );
  });
});

describe("cross-tenant collision cases", () => {
  it("claiming a slot never resets another tenant's notified entry for the same timestamp", async () => {
    // Same slot timestamp notified in both tenants.
    const slotStart = new Date(Date.now() + 96 * 3600e3).toISOString();
    const slotEnd = new Date(Date.now() + 97 * 3600e3).toISOString();
    const service = `Collision ${RUN}`;

    const ids: Record<string, { customer: number; entry: number }> = {};
    for (const [key, tenant] of [
      ["a", tenantA],
      ["b", tenantB],
    ] as const) {
      const cust = await agent
        .post("/api/sos/customers")
        .set(asTenant(tenant))
        .send({ name: `Collide ${key} ${RUN}`, phone: `+1555010010${key === "a" ? 6 : 7}`, smsOptIn: false })
        .expect(201);
      const entry = await agent
        .post("/api/sos/waitlist")
        .set(asTenant(tenant))
        .send({ customerId: cust.body.id, desiredService: service })
        .expect(201);
      ids[key] = { customer: cust.body.id, entry: entry.body.id };
      // Book + cancel an identical slot in each tenant to notify its entry.
      const appt = await agent
        .post("/api/sos/appointments")
        .set(asTenant(tenant))
        .send({ customerId: cust.body.id, serviceType: service, startsAt: slotStart, endsAt: slotEnd })
        .expect(201);
      await agent
        .post(`/api/sos/appointments/${appt.body.id}/cancel`)
        .set(asTenant(tenant))
        .expect(200);
    }

    // Claim tenant A's entry; tenant B's notified entry must be untouched.
    await agent
      .post(`/api/sos/waitlist/${ids.a.entry}/claim`)
      .set(asTenant(tenantA))
      .expect(200);
    const listB = await agent.get("/api/sos/waitlist").set(asTenant(tenantB)).expect(200);
    expect(listB.body.find((e: { id: number }) => e.id === ids.b.entry)?.status).toBe(
      "notified",
    );
  });

  it("a shared phone number never links a call to another tenant's customer", async () => {
    const sharedPhone = "+15550100008";
    // Legacy customer with the same phone as tenant B's caller.
    const legacy = await agent
      .post("/api/sos/customers")
      .send({ name: `Legacy Shared ${RUN}`, phone: sharedPhone, smsOptIn: false })
      .expect(201);
    await agent
      .post("/api/sos/calls")
      .set(asTenant(tenantB))
      .send({ fromNumber: sharedPhone, inquiry: "Just a question about hours" })
      .expect(201);

    const callsB = await agent.get("/api/sos/calls").set(asTenant(tenantB)).expect(200);
    const call = callsB.body.find((c: { fromNumber: string }) => c.fromNumber === sharedPhone);
    expect(call).toBeDefined();
    // Matched to tenant B's own customer, never the legacy one.
    expect(call.customerId).not.toBe(legacy.body.id);

    // The legacy customer's timeline must not contain tenant B's call.
    const timeline = await agent
      .get(`/api/sos/customers/${legacy.body.id}/timeline`)
      .expect(200);
    expect(
      timeline.body.some((e: { channel: string }) => e.channel === "ai_call"),
    ).toBe(false);
  });
});

describe("scoped reads", () => {
  it("direct-ID routes refuse cross-tenant and headerless access", async () => {
    // A tenant-A customer created earlier in this suite.
    const listA = await agent.get("/api/sos/customers").set(asTenant(tenantA)).expect(200);
    const custA = listA.body.find((c: { name: string }) => c.name === `Waiter A ${RUN}`);
    expect(custA).toBeDefined();

    // Read/mutate by ID as tenant B or with no header → 404, never data.
    await agent.get(`/api/sos/customers/${custA.id}`).set(asTenant(tenantB)).expect(404);
    await agent.get(`/api/sos/customers/${custA.id}`).expect(404);
    await agent.get(`/api/sos/customers/${custA.id}/timeline`).set(asTenant(tenantB)).expect(404);
    await agent
      .patch(`/api/sos/customers/${custA.id}`)
      .set(asTenant(tenantB))
      .send({ name: "Hijacked" })
      .expect(404);
    // The owner tenant still has full access.
    await agent.get(`/api/sos/customers/${custA.id}`).set(asTenant(tenantA)).expect(200);
  });

  it("requests without tenant context never see tenant-scoped rows", async () => {
    // Tenant B has customers, waitlist entries, appointments, and calls from
    // the earlier tests; none may leak into the legacy (headerless) views.
    const [customers, waitlist, calls] = await Promise.all([
      agent.get("/api/sos/customers").expect(200),
      agent.get("/api/sos/waitlist").expect(200),
      agent.get("/api/sos/calls").expect(200),
    ]);
    const names = customers.body.map((c: { name: string }) => c.name);
    expect(names).not.toContain(`Waiter A ${RUN}`);
    expect(names).not.toContain(`Waiter B ${RUN}`);
    expect(names).toContain(`Legacy ${RUN}`);
    expect(waitlist.body.some((e: { desiredService: string }) => e.desiredService === SERVICE)).toBe(false);
    expect(calls.body.some((c: { fromNumber: string }) => c.fromNumber === "+15550100002")).toBe(false);
  });

  it("scopes resources and the dashboard per tenant", async () => {
    await agent
      .post("/api/sos/resources")
      .set(asTenant(tenantA))
      .send({ name: `Chair A ${RUN}`, resourceType: "chair" })
      .expect(201);

    const resA = await agent.get("/api/sos/resources").set(asTenant(tenantA)).expect(200);
    const chair = resA.body.find((r: { name: string }) => r.name === `Chair A ${RUN}`);
    expect(chair).toBeDefined();

    // A tenant's visit can never claim another tenant's resource.
    const visitCust = await agent
      .post("/api/sos/customers")
      .set(asTenant(tenantB))
      .send({ name: `Visitor B ${RUN}`, phone: "+15550100009", smsOptIn: false })
      .expect(201);
    const visit = await agent
      .post("/api/sos/visits")
      .set(asTenant(tenantB))
      .send({ customerId: visitCust.body.id, serviceType: `Cut ${RUN}` })
      .expect(201);
    await agent
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant(tenantB))
      .send({ action: "assign", resourceId: chair.id })
      .expect(409);

    // Cross-tenant/headerless resource mutation is refused.
    await agent
      .patch(`/api/sos/resources/${chair.id}`)
      .set(asTenant(tenantB))
      .send({ name: "Stolen chair" })
      .expect(404);
    await agent.delete(`/api/sos/resources/${chair.id}`).expect(404);
    const resB = await agent.get("/api/sos/resources").set(asTenant(tenantB)).expect(200);
    expect(resB.body).toHaveLength(0);

    const dashA = await agent.get("/api/sos/dashboard").set(asTenant(tenantA)).expect(200);
    expect(dashA.body.totalResources).toBe(1);
    expect(dashA.body.callsHandledToday).toBe(0);
    const dashB = await agent.get("/api/sos/dashboard").set(asTenant(tenantB)).expect(200);
    expect(dashB.body.totalResources).toBe(0);
    // Two tenant-B calls were placed earlier in this suite.
    expect(dashB.body.callsHandledToday).toBe(2);
  });

  it("keeps one tenant's operational texts out of another tenant's message log, timeline, and dashboard count", async () => {
    // Tenant B already has its own operational texts (AI receptionist
    // follow-ups from earlier tests); its count must not move when A sends.
    const dashBBefore = await agent.get("/api/sos/dashboard").set(asTenant(tenantB)).expect(200);
    const dashABefore = await agent.get("/api/sos/dashboard").set(asTenant(tenantA)).expect(200);

    // Tenant A: an opted-in customer receives a manual staff text.
    const custA = await agent
      .post("/api/sos/customers")
      .set(asTenant(tenantA))
      .send({ name: `Texter A ${RUN}`, phone: "+15550100021", smsOptIn: true })
      .expect(201);
    await agent
      .post("/api/sos/messages")
      .set(asTenant(tenantA))
      .send({ customerId: custA.body.id, body: `Hello from A ${RUN}` })
      .expect(201);

    // Tenant A sees its message; tenant B and the legacy view do not.
    const [logA, logB, logLegacy] = await Promise.all([
      agent.get("/api/sos/messages").set(asTenant(tenantA)).expect(200),
      agent.get("/api/sos/messages").set(asTenant(tenantB)).expect(200),
      agent.get("/api/sos/messages").expect(200),
    ]);
    const bodyMatch = (m: { body: string }) => m.body === `Hello from A ${RUN}`;
    expect(logA.body.some(bodyMatch)).toBe(true);
    expect(logB.body.some(bodyMatch)).toBe(false);
    expect(logLegacy.body.some(bodyMatch)).toBe(false);

    // Dashboard message count is scoped by the message's own tenant stamp:
    // A's send increments only A's count, never B's.
    const dashB = await agent.get("/api/sos/dashboard").set(asTenant(tenantB)).expect(200);
    expect(dashB.body.messagesSentToday).toBe(dashBBefore.body.messagesSentToday);
    const dashA = await agent.get("/api/sos/dashboard").set(asTenant(tenantA)).expect(200);
    expect(dashA.body.messagesSentToday).toBe(dashABefore.body.messagesSentToday + 1);

    // Timeline: a tenant-B customer sharing the same phone number never sees
    // tenant A's texts (to-number matching stays inside the tenant scope).
    const custB = await agent
      .post("/api/sos/customers")
      .set(asTenant(tenantB))
      .send({ name: `Texter B ${RUN}`, phone: "+15550100021", smsOptIn: true })
      .expect(201);
    const [tlA, tlB] = await Promise.all([
      agent.get(`/api/sos/customers/${custA.body.id}/timeline`).set(asTenant(tenantA)).expect(200),
      agent.get(`/api/sos/customers/${custB.body.id}/timeline`).set(asTenant(tenantB)).expect(200),
    ]);
    expect(tlA.body.some((e: { body: string | null }) => e.body === `Hello from A ${RUN}`)).toBe(true);
    expect(tlB.body.some((e: { body: string | null }) => e.body === `Hello from A ${RUN}`)).toBe(false);
  });

  it("legacy (headerless) message log keeps showing NULL-tenant messages", async () => {
    // A legacy customer (no tenant header) receives a manual staff text.
    const legacyCust = await agent
      .post("/api/sos/customers")
      .send({ name: `Legacy texter ${RUN}`, phone: "+15550100022", smsOptIn: true })
      .expect(201);
    await agent
      .post("/api/sos/messages")
      .send({ customerId: legacyCust.body.id, body: `Legacy hello ${RUN}` })
      .expect(201);

    const [logLegacy, logA] = await Promise.all([
      agent.get("/api/sos/messages").expect(200),
      agent.get("/api/sos/messages").set(asTenant(tenantA)).expect(200),
    ]);
    const bodyMatch = (m: { body: string }) => m.body === `Legacy hello ${RUN}`;
    expect(logLegacy.body.some(bodyMatch)).toBe(true);
    // Legacy messages never leak into a tenant's scoped view either.
    expect(logA.body.some(bodyMatch)).toBe(false);
  });
});

describe("reports summary is scoped to the requesting tenant", () => {
  it("keeps each tenant's report to its own rows, with legacy still served", async () => {
    // By this point in the suite: tenant B has AI calls; tenant A has
    // waitlist-fill bookings (claims) and cancellations but no calls.
    const forA = await agent
      .get("/api/sos/reports/summary")
      .set(asTenant(tenantA))
      .expect(200);
    const forB = await agent
      .get("/api/sos/reports/summary")
      .set(asTenant(tenantB))
      .expect(200);

    const totalCalls = (r: { callOutcomes: { count: number }[] }) =>
      r.callOutcomes.reduce((n, o) => n + o.count, 0);
    expect(totalCalls(forB.body)).toBeGreaterThanOrEqual(1);
    expect(totalCalls(forA.body)).toBe(0);

    expect(forA.body.slotsFilled).toBeGreaterThanOrEqual(1);
    expect(forB.body.slotsFilled).toBe(0);

    // No visits were checked in for either tenant, so scoped revenue and
    // visit history stay empty instead of leaking agency-wide numbers.
    expect(forA.body.visitsByDay).toEqual([]);
    expect(forB.body.totalRevenue).toBe(0);

    // The legacy combined view still answers without tenant context.
    await agent.get("/api/sos/reports/summary").expect(200);
  });
});
