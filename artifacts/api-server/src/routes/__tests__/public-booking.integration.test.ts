import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosServicesTable,
  sosResourcesTable,
  sosSettingsTable,
  sosCustomersTable,
  sosSmsConsentRecordsTable,
  sosVisitsTable,
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
let firstPublicVisitId: number;
let firstPublicTrackingToken: string;

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

describe("public digital queue check-in", () => {
  const CHECK_IN_PHONE = "+15556660000";

  it("serves active-business check-in context without a session", async () => {
    const res = await anon.get(`/api/public/check-in/${SLUG}`).expect(200);
    expect(res.body.businessName).toBe(`PubBook Salon ${RUN}`);
    expect(res.body.services).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: serviceId, name: `Public Cut ${RUN}` })]),
    );

    await anon.get(`/api/public/check-in/no-such-business-${RUN}`).expect(404);
  });

  it("creates an unchecked-consent queue visit that staff can see", async () => {
    const res = await anon
      .post(`/api/public/check-in/${SLUG}`)
      .send({
        serviceId,
        name: `Queue Guest ${RUN}`,
        phone: CHECK_IN_PHONE,
        partySize: 3,
        smsOptIn: false,
      })
      .expect(201);

    expect(res.body.serviceType).toBe(`Public Cut ${RUN}`);
    expect(res.body.businessName).toBe(`PubBook Salon ${RUN}`);
    expect(res.body.queuePosition).toBe(1);
    expect(res.body.estimatedWaitMinutes).toBe(0);
    const trackingToken = res.body.trackingUrl.split("#").at(-1);
    expect(trackingToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.trackingUrl).toContain(`/check-in/${SLUG}/status/${res.body.visitId}#${trackingToken}`);
    firstPublicVisitId = res.body.visitId;
    firstPublicTrackingToken = trackingToken;

    const [customer] = await db
      .select()
      .from(sosCustomersTable)
      .where(
        eq(sosCustomersTable.phone, CHECK_IN_PHONE),
      );
    expect(customer.tenantId).toBe(tenantId);
    expect(customer.smsOptIn).toBe(false);
    expect(customer.visitCount).toBe(1);

    const [visit] = await db
      .select()
      .from(sosVisitsTable)
      .where(eq(sosVisitsTable.id, res.body.visitId));
    expect(visit).toMatchObject({
      tenantId,
      customerId: customer.id,
      serviceType: `Public Cut ${RUN}`,
      partySize: 3,
      status: "checked_in",
    });

    const activeVisits = await staff
      .get("/api/sos/visits?active=true")
      .set("x-tenant-id", String(tenantId))
      .expect(200);
    expect(activeVisits.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: visit.id,
          customerName: `Queue Guest ${RUN}`,
          serviceType: `Public Cut ${RUN}`,
        }),
      ]),
    );

    const status = await anon
      .get(`/api/public/check-in/${SLUG}/status/${res.body.visitId}`)
      .set("x-check-in-token", trackingToken)
      .expect(200);
    expect(status.body).toMatchObject({
      visitId: res.body.visitId,
      businessName: `PubBook Salon ${RUN}`,
      serviceType: `Public Cut ${RUN}`,
      status: "checked_in",
      queuePosition: 1,
      estimatedWaitMinutes: 0,
    });

    await anon.get(`/api/public/check-in/${SLUG}/status/${res.body.visitId}`).expect(404);
    await anon
      .get(`/api/public/check-in/${SLUG}/status/${res.body.visitId}`)
      .set("x-check-in-token", "wrong-tracking-token")
      .expect(404);
  });

  it("records affirmative SMS consent but rejects submissions without a mobile number", async () => {
    const optedInPhone = "+15556660001";
    await anon
      .post(`/api/public/check-in/${SLUG}`)
      .send({
        serviceId,
        name: `Opted In Guest ${RUN}`,
        phone: optedInPhone,
        smsOptIn: true,
      })
      .expect(201);

    const [optedIn] = await db
      .select()
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.phone, optedInPhone));
    expect(optedIn).toMatchObject({ tenantId, smsOptIn: true });

    const [consentRecord] = await db
      .select()
      .from(sosSmsConsentRecordsTable)
      .where(eq(sosSmsConsentRecordsTable.customerId, optedIn.id));
    expect(consentRecord).toMatchObject({
      tenantId,
      phone: optedInPhone,
      source: "public_check_in",
      disclosureVersion: "public-check-in-v1",
    });
    expect(consentRecord.disclosureText).toContain(`PubBook Salon ${RUN}`);
    expect(consentRecord.consentedAt).toBeInstanceOf(Date);

    await anon
      .post(`/api/public/check-in/${SLUG}`)
      .send({
        serviceId,
        name: `Missing Phone Consent ${RUN}`,
        smsOptIn: true,
      })
      .expect(400);
  });

  it("does not let a public browser re-enable an opted-out number", async () => {
    const optedOutPhone = "+15556660002";
    await db.insert(sosCustomersTable).values({
      tenantId,
      name: `Opted Out Guest ${RUN}`,
      phone: optedOutPhone,
      smsOptIn: false,
    });

    await anon
      .post(`/api/public/check-in/${SLUG}`)
      .send({
        serviceId,
        name: `Opted Out Guest ${RUN}`,
        phone: optedOutPhone,
        smsOptIn: true,
      })
      .expect(409);

    const [optedOut] = await db
      .select()
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.phone, optedOutPhone));
    expect(optedOut.smsOptIn).toBe(false);
  });

  it("records CTA consent evidence for an existing opted-in customer", async () => {
    const existingPhone = "+15556660004";
    const [existingCustomer] = await db
      .insert(sosCustomersTable)
      .values({
        tenantId,
        name: `Existing Opted In Guest ${RUN}`,
        phone: existingPhone,
        smsOptIn: true,
      })
      .returning();

    await anon
      .post(`/api/public/check-in/${SLUG}`)
      .set("user-agent", "public-checkin-consent-test")
      .send({
        serviceId,
        name: `Existing Opted In Guest ${RUN}`,
        phone: existingPhone,
        smsOptIn: true,
      })
      .expect(201);

    const [consentRecord] = await db
      .select()
      .from(sosSmsConsentRecordsTable)
      .where(eq(sosSmsConsentRecordsTable.customerId, existingCustomer.id));
    expect(consentRecord).toMatchObject({
      source: "public_check_in",
      disclosureVersion: "public-check-in-v1",
      userAgent: "public-checkin-consent-test",
    });
  });

  it("rejects a whitespace-only customer name", async () => {
    await anon
      .post(`/api/public/check-in/${SLUG}`)
      .send({
        serviceId,
        name: "   ",
        phone: "+15556660003",
      })
      .expect(400);
  });

  it("rejects duplicate active check-ins for the same customer and service", async () => {
    await anon
      .post(`/api/public/check-in/${SLUG}`)
      .send({
        serviceId,
        name: `Queue Guest ${RUN}`,
        phone: CHECK_IN_PHONE,
      })
      .expect(409);
  });

  it("keeps matching phone numbers isolated by tenant slug", async () => {
    const otherSlug = `${RUN}-checkin-b`;
    const [otherTenant] = await db
      .insert(tenantsTable)
      .values({ brandName: `Other ${RUN}`, subdomain: otherSlug, status: "active" })
      .returning({ id: tenantsTable.id });

    try {
      await db.insert(sosSettingsTable).values({
        tenantId: otherTenant.id,
        businessName: `Other Check In ${RUN}`,
      });
      const [otherService] = await db
        .insert(sosServicesTable)
        .values({ tenantId: otherTenant.id, name: `Other Service ${RUN}`, isActive: true })
        .returning({ id: sosServicesTable.id });

      await anon
        .post(`/api/public/check-in/${otherSlug}`)
        .send({
          serviceId: otherService.id,
          name: `Same Phone Different Tenant ${RUN}`,
          phone: CHECK_IN_PHONE,
        })
        .expect(201);

      await anon
        .get(`/api/public/check-in/${otherSlug}/status/${firstPublicVisitId}`)
        .set("x-check-in-token", firstPublicTrackingToken)
        .expect(404);

      const matchingCustomers = await db
        .select()
        .from(sosCustomersTable)
        .where(eq(sosCustomersTable.phone, CHECK_IN_PHONE));
      expect(matchingCustomers.map((customer) => customer.tenantId).sort()).toEqual(
        [tenantId, otherTenant.id].sort(),
      );
    } finally {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, otherTenant.id));
    }
  });

  it("schedules mixed-service work against the earliest available resource", async () => {
    const queueSlug = `${RUN}-workload`;
    const [queueTenant] = await db
      .insert(tenantsTable)
      .values({ brandName: `Workload ${RUN}`, subdomain: queueSlug, status: "active" })
      .returning({ id: tenantsTable.id });

    try {
      await db.insert(sosSettingsTable).values({
        tenantId: queueTenant.id,
        businessName: `Workload Queue ${RUN}`,
      });
      const [longService, shortService] = await db
        .insert(sosServicesTable)
        .values([
          { tenantId: queueTenant.id, name: `Long Service ${RUN}`, durationMinutes: 90, isActive: true },
          { tenantId: queueTenant.id, name: `Short Service ${RUN}`, durationMinutes: 15, isActive: true },
        ])
        .returning({ id: sosServicesTable.id });
      const [firstResource, secondResource] = await db
        .insert(sosResourcesTable)
        .values([
          { tenantId: queueTenant.id, name: `Queue Chair A ${RUN}`, resourceType: "chair" },
          { tenantId: queueTenant.id, name: `Queue Chair B ${RUN}`, resourceType: "chair" },
        ])
        .returning({ id: sosResourcesTable.id });

      const first = await anon
        .post(`/api/public/check-in/${queueSlug}`)
        .send({
          serviceId: longService.id,
          name: `Long Queue Guest ${RUN}`,
          phone: "+15554440001",
        })
        .expect(201);
      const second = await anon
        .post(`/api/public/check-in/${queueSlug}`)
        .send({
          serviceId: shortService.id,
          name: `Short Queue Guest ${RUN}`,
          phone: "+15554440002",
        })
        .expect(201);

      // The long service takes one available chair, so the short-service
      // customer can immediately start at the other chair.
      expect(second.body).toMatchObject({ queuePosition: 2, estimatedWaitMinutes: 0 });

      await db
        .update(sosVisitsTable)
        .set({
          status: "in_service",
          resourceId: firstResource.id,
          serviceStartedAt: new Date(),
        })
        .where(eq(sosVisitsTable.id, first.body.visitId));
      await db
        .update(sosResourcesTable)
        .set({ status: "occupied", currentVisitId: first.body.visitId })
        .where(eq(sosResourcesTable.id, firstResource.id));
      await db
        .update(sosVisitsTable)
        .set({
          status: "in_service",
          resourceId: secondResource.id,
          serviceStartedAt: new Date(),
        })
        .where(eq(sosVisitsTable.id, second.body.visitId));
      await db
        .update(sosResourcesTable)
        .set({ status: "occupied", currentVisitId: second.body.visitId })
        .where(eq(sosResourcesTable.id, secondResource.id));

      const third = await anon
        .post(`/api/public/check-in/${queueSlug}`)
        .send({
          serviceId: shortService.id,
          name: `Next Queue Guest ${RUN}`,
          phone: "+15554440003",
        })
        .expect(201);

      // The two occupied chairs have 90 and 15 minutes of work remaining.
      // The next visitor waits for the 15-minute service, not their average.
      expect(third.body).toMatchObject({ queuePosition: 1, estimatedWaitMinutes: 15 });
    } finally {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, queueTenant.id));
    }
  });
});
