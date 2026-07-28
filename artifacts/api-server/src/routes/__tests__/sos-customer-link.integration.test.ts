import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  clientProfilesTable,
  sosCustomersTable,
  messagesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for the SOS customer ⇄ concierge client profile link:
// auto-linking by phone, the combined read model, write propagation, and
// opt-out consistency across the link.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `cust-link-${Date.now()}-${process.pid}`;
const PHONE_LINKED = "+15559310001";
const PHONE_AMBIG = "+15559310002";
const PHONE_NONE = "+15559310003";

let agent: ReturnType<typeof request.agent>;
let tenantId: number;
let profileId: number;
const createdCustomerIds: number[] = [];

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  // Tenant-scoped routes now require explicit tenant context; these tests
  // exercise the legacy (NULL-tenant) scope unless a request overrides it.
  agent.set("x-tenant-id", "legacy");
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `CustLink ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;

  const [profile] = await db
    .insert(clientProfilesTable)
    .values({
      tenantId,
      name: "Marketing Mia",
      phone: PHONE_LINKED,
      email: "mia@example.com",
      preferredChannel: "sms",
      nextVisitAt: new Date("2026-08-01T15:00:00Z"),
      averageCycleDays: 28,
    })
    .returning({ id: clientProfilesTable.id });
  profileId = profile.id;

  // Two profiles share PHONE_AMBIG — an ambiguous match must never auto-link.
  await db.insert(clientProfilesTable).values([
    { tenantId, name: "Ambig One", phone: PHONE_AMBIG },
    { tenantId, name: "Ambig Two", phone: PHONE_AMBIG },
  ]);
});

afterAll(async () => {
  if (createdCustomerIds.length > 0) {
    await db
      .delete(sosCustomersTable)
      .where(inArray(sosCustomersTable.id, createdCustomerIds));
  }
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db
    .delete(messagesTable)
    .where(inArray(messagesTable.toNumber, [PHONE_LINKED, PHONE_AMBIG, PHONE_NONE]));
});

async function createCustomer(body: Record<string, unknown>) {
  const res = await agent.post("/api/sos/customers").send(body).expect(201);
  createdCustomerIds.push(res.body.id);
  return res.body;
}

describe("SOS customer ⇄ concierge profile link", () => {
  it("auto-links a new customer to the unique phone-matching profile and returns marketing data", async () => {
    const c = await createCustomer({
      name: "Ops Mia",
      phone: "(555) 931-0001", // different formatting, same number
      smsOptIn: true,
    });
    expect(c.clientProfileId).toBe(profileId);
    expect(c.marketing).not.toBeNull();
    expect(c.marketing.clientProfileId).toBe(profileId);
    expect(c.marketing.preferredChannel).toBe("sms");
    expect(c.marketing.averageCycleDays).toBe(28);
    expect(c.marketing.nextVisitAt).toBe("2026-08-01T15:00:00.000Z");
  });

  it("GET /sos/customers/:id returns the combined record", async () => {
    const created = await createCustomer({ name: "Solo Sam", phone: PHONE_NONE });
    const res = await agent.get(`/api/sos/customers/${created.id}`).expect(200);
    expect(res.body.clientProfileId).toBeNull();
    expect(res.body.marketing).toBeNull();

    const linked = createdCustomerIds[0];
    const res2 = await agent.get(`/api/sos/customers/${linked}`).expect(200);
    expect(res2.body.marketing?.clientProfileId).toBe(profileId);
  });

  it("does not auto-link when the phone match is ambiguous", async () => {
    const c = await createCustomer({ name: "Ambig Andy", phone: PHONE_AMBIG });
    expect(c.clientProfileId).toBeNull();
    expect(c.marketing).toBeNull();
  });

  it("propagates contact/opt-in edits to the linked profile", async () => {
    const linkedId = createdCustomerIds[0];
    await agent
      .patch(`/api/sos/customers/${linkedId}`)
      .send({ name: "Mia Renamed", email: "mia-new@example.com", smsOptIn: false })
      .expect(200);

    const [profile] = await db
      .select()
      .from(clientProfilesTable)
      .where(eq(clientProfilesTable.id, profileId));
    expect(profile.name).toBe("Mia Renamed");
    expect(profile.email).toBe("mia-new@example.com");
    expect(profile.smsOptIn).toBe(false);
  });

  it("concierge dispatch skips as opted_out when the linked SOS customer opted out", async () => {
    // Re-opt-in the profile only, leaving the SOS customer opted out.
    await db
      .update(clientProfilesTable)
      .set({ smsOptIn: true })
      .where(eq(clientProfilesTable.id, profileId));

    const res = await agent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId, clientProfileId: profileId, body: `Nudge ${RUN}` })
      .expect(409);
    expect(res.body.status).toBe("skipped");
    expect(res.body.errorCode).toBe("opted_out");

    await db.delete(messagesTable).where(eq(messagesTable.id, res.body.id));
  });

  it("re-opting in via PATCH lets concierge dispatch go through again", async () => {
    const linkedId = createdCustomerIds[0];
    await agent
      .patch(`/api/sos/customers/${linkedId}`)
      .send({ smsOptIn: true })
      .expect(200);

    const res = await agent
      .post("/api/concierge/dispatch-message")
      .send({ tenantId, clientProfileId: profileId, body: `Nudge2 ${RUN}` })
      .expect(201);
    expect(res.body.status).toBe("simulated");
  });

  it("backfill links pre-existing unlinked customers by unambiguous phone match", async () => {
    const { backfillCustomerLinks } = await import("../../lib/customerLink");
    // Simulate pre-existing rows created before linking existed (direct insert,
    // no auto-link): one unambiguous match, one ambiguous, one no match.
    const inserted = await db
      .insert(sosCustomersTable)
      .values([
        { name: "Legacy Lin", phone: "555-931-0001" }, // matches PHONE_LINKED profile
        { name: "Legacy Ambig", phone: PHONE_AMBIG },
        { name: "Legacy None", phone: "+15559319999" },
      ])
      .returning({ id: sosCustomersTable.id });
    createdCustomerIds.push(...inserted.map((r) => r.id));

    const linked = await backfillCustomerLinks();
    expect(linked).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select()
      .from(sosCustomersTable)
      .where(inArray(sosCustomersTable.id, inserted.map((r) => r.id)));
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("Legacy Lin")?.clientProfileId).toBe(profileId);
    expect(byName.get("Legacy Ambig")?.clientProfileId).toBeNull();
    expect(byName.get("Legacy None")?.clientProfileId).toBeNull();

    // Idempotent: a second run links nothing new and changes nothing.
    await backfillCustomerLinks();
    const [again] = await db
      .select()
      .from(sosCustomersTable)
      .where(eq(sosCustomersTable.id, byName.get("Legacy Lin")!.id));
    expect(again.clientProfileId).toBe(profileId);
  });

  it("the link survives a phone edit", async () => {
    const linkedId = createdCustomerIds[0];
    const res = await agent
      .patch(`/api/sos/customers/${linkedId}`)
      .send({ phone: "+15559319999" })
      .expect(200);
    expect(res.body.clientProfileId).toBe(profileId);
    // And the new phone propagated to the profile.
    const [profile] = await db
      .select()
      .from(clientProfilesTable)
      .where(eq(clientProfilesTable.id, profileId));
    expect(profile.phone).toBe("+15559319999");
  });
});
