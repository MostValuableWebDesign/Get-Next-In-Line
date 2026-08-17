import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosServicesTable,
  sosResourcesTable,
  sosSettingsTable,
  sosCustomersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Public booking API: unauthenticated, tenant-slug-scoped booking flow.
//  - config exposes only the public surface (services, staff, hours)
//  - availability respects business hours and existing bookings
//  - booking creates a customer + appointment (source self_book) with
//    duplicate and slot-conflict guards
//  - publicly created bookings surface in the staff appointments list
//
// Isolation: one throwaway tenant per run (rows cascade on delete); no
// legacy (NULL-tenant) rows are touched.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

const RUN = `pubbook-${Date.now()}-${process.pid}`;
const SLUG = `${RUN}-a`;

let app: import("express").Express;
let anon: ReturnType<typeof request.agent>; // no session — the whole point
let staff: ReturnType<typeof request.agent>;
let tenantId: number;
let serviceId: number;
let resourceId: number;

// A weekday ~7 days out, so slots are always in the future.
function bookingDate(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

beforeAll(async () => {
  const { __resetPublicBookingRateLimit } = await import("../publicBooking");
  __resetPublicBookingRateLimit();
  app = (await import("../../app")).default;
  anon = request.agent(app);
  staff = request.agent(app);
  await staff
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values([{ brandName: `PubBook ${RUN}`, subdomain: SLUG, status: "active" }])
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  await db.insert(sosSettingsTable).values({
    tenantId,
    businessName: `PubBook Salon ${RUN}`,
    openTime: "09:00",
    closeTime: "17:00",
  });

  const [svc] = await db
    .insert(sosServicesTable)
    .values({
      tenantId,
      name: `Public Cut ${RUN}`,
      durationMinutes: 60,
      price: "45.00",
      isActive: true,
    })
    .returning({ id: sosServicesTable.id });
  serviceId = svc.id;
  // An inactive service must never appear publicly.
  await db.insert(sosServicesTable).values({
    tenantId,
    name: `Retired Service ${RUN}`,
    isActive: false,
  });

  const [resource] = await db
    .insert(sosResourcesTable)
    .values({ tenantId, name: `Alex ${RUN}`, resourceType: "chair" })
    .returning({ id: sosResourcesTable.id });
  resourceId = resource.id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

// The per-IP booking rate limit (10/hour) would otherwise trip across this
// suite's many bookings from the same test IP.
beforeEach(async () => {
  const { __resetPublicBookingRateLimit } = await import("../publicBooking");
  __resetPublicBookingRateLimit();
});

describe("public booking config", () => {
  it("serves branding, active services, and staff without a session", async () => {
    const res = await anon.get(`/api/public/booking/${SLUG}`).expect(200);
    expect(res.body.businessName).toBe(`PubBook Salon ${RUN}`);
    expect(res.body.openTime).toBe("09:00");
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].name).toBe(`Public Cut ${RUN}`);
    expect(res.body.staff).toEqual([{ id: resourceId, name: `Alex ${RUN}` }]);
  });

  it("404s for an unknown slug", async () => {
    await anon.get(`/api/public/booking/no-such-business-${RUN}`).expect(404);
  });
});

describe("availability", () => {
  it("offers slots inside business hours only", async () => {
    const res = await anon
      .post(`/api/public/booking/${SLUG}/availability`)
      .send({ serviceId, date: bookingDate() })
      .expect(200);
    const slots: { startsAt: string; endsAt: string }[] = res.body.slots;
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const start = new Date(s.startsAt);
      const end = new Date(s.endsAt);
      expect(start.getHours()).toBeGreaterThanOrEqual(9);
      // 60-min service must end by 17:00
      expect(end.getHours() * 60 + end.getMinutes()).toBeLessThanOrEqual(17 * 60);
    }
  });

  it("404s for an inactive/unknown service", async () => {
    await anon
      .post(`/api/public/booking/${SLUG}/availability`)
      .send({ serviceId: 999999, date: bookingDate() })
      .expect(404);
  });
});

describe("booking creation", () => {
  let bookedStartsAt: string;

  it("books with just name + phone and surfaces in the staff appointment list", async () => {
    const avail = await anon
      .post(`/api/public/booking/${SLUG}/availability`)
      .send({ serviceId, date: bookingDate(), resourceId })
      .expect(200);
    bookedStartsAt = avail.body.slots[0].startsAt;

    const res = await anon
      .post(`/api/public/booking/${SLUG}/appointments`)
      .send({
        serviceId,
        startsAt: bookedStartsAt,
        resourceId,
        name: `Pat Public ${RUN}`,
        phone: "+15559871234",
      })
      .expect(201);
    expect(res.body.serviceType).toBe(`Public Cut ${RUN}`);
    expect(res.body.staffName).toBe(`Alex ${RUN}`);

    // Customer record was created under this tenant.
    const customers = await db
      .select()
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.tenantId, tenantId));
    expect(customers).toHaveLength(1);
    expect(customers[0].name).toBe(`Pat Public ${RUN}`);

    // The booking shows up in the internal (staff) appointments view.
    const list = await staff
      .get("/api/sos/appointments")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    const mine = list.body.filter(
      (a: { serviceType: string }) => a.serviceType === `Public Cut ${RUN}`,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].source).toBe("self_book");
    expect(mine[0].customerName).toBe(`Pat Public ${RUN}`);
  });

  it("rejects a duplicate re-submission of the same slot", async () => {
    await anon
      .post(`/api/public/booking/${SLUG}/appointments`)
      .send({
        serviceId,
        startsAt: bookedStartsAt,
        resourceId,
        name: `Pat Public ${RUN}`,
        phone: "+15559871234",
      })
      .expect(409);
  });

  it("rejects a conflicting booking when capacity is exhausted", async () => {
    // Single resource ⇒ capacity 1: another customer can't take the same slot.
    await anon
      .post(`/api/public/booking/${SLUG}/appointments`)
      .send({
        serviceId,
        startsAt: bookedStartsAt,
        name: `Sam Second ${RUN}`,
        phone: "+15550005555",
      })
      .expect(409);
  });

  it("no longer offers the booked slot in availability", async () => {
    const res = await anon
      .post(`/api/public/booking/${SLUG}/availability`)
      .send({ serviceId, date: bookingDate() })
      .expect(200);
    const overlapping = res.body.slots.filter(
      (s: { startsAt: string; endsAt: string }) =>
        new Date(s.startsAt).getTime() <
          new Date(bookedStartsAt).getTime() + 60 * 60 * 1000 &&
        new Date(s.endsAt).getTime() > new Date(bookedStartsAt).getTime(),
    );
    expect(overlapping).toHaveLength(0);
  });

  it("requires a phone or email", async () => {
    await anon
      .post(`/api/public/booking/${SLUG}/appointments`)
      .send({ serviceId, startsAt: bookedStartsAt, name: "No Contact" })
      .expect(400);
  });

  it("requires a phone number when SMS consent is checked", async () => {
    await anon
      .post(`/api/public/booking/${SLUG}/appointments`)
      .send({
        serviceId,
        startsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        name: `Email Only Opt In ${RUN}`,
        email: `email-only-${RUN}@example.com`,
        smsOptIn: true,
      })
      .expect(400);
  });

  it("under concurrent contention, exactly one booking wins the same slot", async () => {
    // A different future slot (day after the earlier bookings) with 5
    // simultaneous customers racing for it. Capacity is 1 resource, so the
    // advisory-lock transaction must let exactly one through.
    const d = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    d.setHours(13, 0, 0, 0);
    const contestedStartsAt = d.toISOString();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post(`/api/public/booking/${SLUG}/appointments`)
          .send({
            serviceId,
            startsAt: contestedStartsAt,
            name: `Racer ${i} ${RUN}`,
            phone: `+1555700${1000 + i}`,
          }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

  it("under concurrent duplicate submission, the same customer books only once", async () => {
    const d = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    d.setHours(14, 0, 0, 0);
    const dupStartsAt = d.toISOString();

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app)
          .post(`/api/public/booking/${SLUG}/appointments`)
          .send({
            serviceId,
            startsAt: dupStartsAt,
            name: `Double Click ${RUN}`,
            phone: "+15557778888",
          }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);

    // Only one customer row was created for the racing identical submissions.
    const customers = await db
      .select()
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.tenantId, tenantId));
    expect(customers.filter((c) => c.name === `Double Click ${RUN}`)).toHaveLength(1);
  });

  it("rejects bookings in the past", async () => {
    await anon
      .post(`/api/public/booking/${SLUG}/appointments`)
      .send({
        serviceId,
        startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        name: `Past Person ${RUN}`,
        phone: "+15551112222",
      })
      .expect(409);
  });
});
