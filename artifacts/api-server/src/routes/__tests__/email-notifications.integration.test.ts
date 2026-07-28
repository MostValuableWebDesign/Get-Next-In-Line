import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosServicesTable,
  sosSettingsTable,
  sosCustomersTable,
  messagesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Transactional email channel (additive to SMS):
//  - unconfigured provider → sends are recorded as "simulated" email messages
//  - booking confirmation email on public + staff booking creation
//  - receipt email on checkout completion
//  - gated on the customer's email being present AND emailOptIn
//  - recorded in the unified messages table (channel "email") and surfaced
//    in the customer's communications timeline as channel "email"
//
// Isolation: one throwaway tenant per run (rows cascade on delete).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.RESEND_API_KEY;
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

const RUN = `emailtx-${Date.now()}-${process.pid}`;
const SLUG = `${RUN}-a`;

let app: import("express").Express;
let anon: ReturnType<typeof request.agent>;
let staff: ReturnType<typeof request.agent>;
let tenantId: number;
let serviceId: number;
let serviceName: string;

const asTenant = () => ({ "x-tenant-id": String(tenantId) });

function futureSlot(hour: number): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function emailMessagesFor(customerId: number) {
  return db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.customerId, customerId),
        eq(messagesTable.channel, "email"),
      ),
    )
    .orderBy(messagesTable.id);
}

beforeAll(async () => {
  const { __resetPublicBookingRateLimit } = await import("../publicBooking");
  __resetPublicBookingRateLimit();
  const { __resetEmailCredsCache } = await import("../../lib/email");
  __resetEmailCredsCache();
  app = (await import("../../app")).default;
  anon = request.agent(app);
  staff = request.agent(app);
  await staff
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values([{ brandName: `EmailTx ${RUN}`, subdomain: SLUG, status: "active" }])
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  await db.insert(sosSettingsTable).values({
    tenantId,
    businessName: `EmailTx Salon ${RUN}`,
    openTime: "09:00",
    closeTime: "17:00",
  });

  serviceName = `Email Cut ${RUN}`;
  const [svc] = await db
    .insert(sosServicesTable)
    .values({
      tenantId,
      name: serviceName,
      durationMinutes: 60,
      price: "45.00",
      isActive: true,
    })
    .returning({ id: sosServicesTable.id });
  serviceId = svc.id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

beforeEach(async () => {
  const { __resetPublicBookingRateLimit } = await import("../publicBooking");
  __resetPublicBookingRateLimit();
});

describe("customer email fields", () => {
  it("stores email and emailOptIn on create and edit, and validates format", async () => {
    const created = await staff
      .post("/api/sos/customers")
      .set(asTenant())
      .send({
        name: `Fields ${RUN}`,
        email: `fields-${RUN}@example.com`,
        emailOptIn: false,
      })
      .expect(201);
    expect(created.body.email).toBe(`fields-${RUN}@example.com`);
    expect(created.body.emailOptIn).toBe(false);

    const updated = await staff
      .patch(`/api/sos/customers/${created.body.id}`)
      .set(asTenant())
      .send({ emailOptIn: true, email: `fields2-${RUN}@example.com` })
      .expect(200);
    expect(updated.body.emailOptIn).toBe(true);
    expect(updated.body.email).toBe(`fields2-${RUN}@example.com`);

    await staff
      .post("/api/sos/customers")
      .set(asTenant())
      .send({ name: `Bad ${RUN}`, email: "not-an-email" })
      .expect(400);
    await staff
      .patch(`/api/sos/customers/${created.body.id}`)
      .set(asTenant())
      .send({ email: "still@bad" })
      .expect(400);
  });
});

describe("booking confirmation emails", () => {
  it("public booking sends a simulated confirmation email with a fully-qualified URL", async () => {
    const email = `pub-${RUN}@example.com`;
    await anon
      .post(`/api/public/booking/${SLUG}/appointments`)
      .send({
        serviceId,
        startsAt: futureSlot(10),
        name: `Pub ${RUN}`,
        email,
      })
      .expect(201);

    const [customer] = await db
      .select()
      .from(sosCustomersTable)
      .where(
        and(
          eq(sosCustomersTable.tenantId, tenantId),
          eq(sosCustomersTable.email, email),
        ),
      );
    expect(customer).toBeTruthy();

    const emails = await emailMessagesFor(customer.id);
    expect(emails).toHaveLength(1);
    expect(emails[0].kind).toBe("booking_confirmation");
    expect(emails[0].status).toBe("simulated"); // no provider configured
    expect(emails[0].toEmail).toBe(email);
    expect(emails[0].body).toContain(serviceName);
    // Fully-qualified public URL, never a relative path.
    expect(emails[0].body).toMatch(/https?:\/\/[^\s]+/);
    expect((emails[0].payload as { subject?: string }).subject).toContain(
      "Appointment confirmed",
    );
  });

  it("staff booking sends a confirmation email to an opted-in customer", async () => {
    const customer = await staff
      .post("/api/sos/customers")
      .set(asTenant())
      .send({ name: `StaffBook ${RUN}`, email: `staffbook-${RUN}@example.com` })
      .expect(201);

    const startsAt = futureSlot(12);
    const endsAt = futureSlot(13);
    await staff
      .post("/api/sos/appointments")
      .set(asTenant())
      .send({
        customerId: customer.body.id,
        serviceType: serviceName,
        startsAt,
        endsAt,
      })
      .expect(201);

    const emails = await emailMessagesFor(customer.body.id);
    expect(emails).toHaveLength(1);
    expect(emails[0].kind).toBe("booking_confirmation");
    expect(emails[0].status).toBe("simulated");
  });

  it("does NOT send when the customer has opted out of email", async () => {
    const email = `optout-${RUN}@example.com`;
    const customer = await staff
      .post("/api/sos/customers")
      .set(asTenant())
      .send({ name: `OptOut ${RUN}`, email, emailOptIn: false })
      .expect(201);

    await staff
      .post("/api/sos/appointments")
      .set(asTenant())
      .send({
        customerId: customer.body.id,
        serviceType: serviceName,
        startsAt: futureSlot(14),
        endsAt: futureSlot(15),
      })
      .expect(201);

    const emails = await emailMessagesFor(customer.body.id);
    // The attempt is recorded but skipped — nothing dispatched.
    expect(emails).toHaveLength(1);
    expect(emails[0].status).toBe("skipped");
    expect(emails[0].errorCode).toBe("opted_out");
  });

  it("sends nothing at all when the customer has no email on file", async () => {
    const customer = await staff
      .post("/api/sos/customers")
      .set(asTenant())
      .send({ name: `NoEmail ${RUN}` })
      .expect(201);

    await staff
      .post("/api/sos/appointments")
      .set(asTenant())
      .send({
        customerId: customer.body.id,
        serviceType: serviceName,
        startsAt: futureSlot(15),
        endsAt: futureSlot(16),
      })
      .expect(201);

    expect(await emailMessagesFor(customer.body.id)).toHaveLength(0);
  });
});

describe("receipt emails and timeline", () => {
  it("checkout sends a receipt email and it appears in the timeline as email", async () => {
    const email = `receipt-${RUN}@example.com`;
    const customer = await staff
      .post("/api/sos/customers")
      .set(asTenant())
      .send({ name: `Receipt ${RUN}`, email })
      .expect(201);

    const visit = await staff
      .post("/api/sos/visits")
      .set(asTenant())
      .send({ customerId: customer.body.id, serviceType: serviceName })
      .expect(201);
    const resource = await staff
      .post("/api/sos/resources")
      .set(asTenant())
      .send({ name: `Chair ${RUN}`, resourceType: "chair" })
      .expect(201);
    await staff
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant())
      .send({ action: "assign", resourceId: resource.body.id })
      .expect(200);
    await staff
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant())
      .send({ action: "start_service" })
      .expect(200);
    await staff
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant())
      .send({ action: "check_out", paymentAmount: 45 })
      .expect(200);

    const emails = await emailMessagesFor(customer.body.id);
    expect(emails).toHaveLength(1);
    expect(emails[0].kind).toBe("receipt");
    expect(emails[0].status).toBe("simulated");
    expect(emails[0].toEmail).toBe(email);
    expect(emails[0].body).toContain("$45.00");
    expect(emails[0].body).toMatch(/https?:\/\/[^\s]+/);

    // Timeline surfaces the email, labeled as channel "email".
    const timeline = await staff
      .get(`/api/sos/customers/${customer.body.id}/timeline`)
      .set(asTenant())
      .expect(200);
    const emailEntries = timeline.body.filter(
      (e: { channel: string }) => e.channel === "email",
    );
    expect(emailEntries).toHaveLength(1);
    expect(emailEntries[0].kind).toBe("receipt");
    expect(emailEntries[0].direction).toBe("outbound");
    expect(emailEntries[0].id).toBe(`email-${emails[0].id}`);

    // The messages list serializes the new kind/channel without zod failures.
    const messages = await staff
      .get("/api/sos/messages")
      .set(asTenant())
      .expect(200);
    const mine = messages.body.find(
      (m: { id: number }) => m.id === emails[0].id,
    );
    expect(mine).toBeTruthy();
    expect(mine.kind).toBe("receipt");
    expect(mine.channel).toBe("email");
    expect(mine.toEmail).toBe(email);
  });
});
