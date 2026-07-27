import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  posIntegrationsTable,
  sosCustomersTable,
  sosVisitsTable,
  sosStaffMembersTable,
  merchantCoopPartnershipsTable,
  perkPassesTable,
  coopAttributionEventsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// External POS webhook connectors (Square, Clover, Boulevard, Vagaro).
//
//   - merchant setup: enable → webhook URL + signing secret; session required
//   - signature verification per vendor scheme; bad signatures rejected 401
//   - check-in → platform visit created; completion → visit checked out with
//     payment + staff attribution and perk passes granted (native effects)
//   - idempotency: vendor retry of the same event id is a duplicate no-op
//   - malformed / unrecognized payloads are logged, never silently dropped
//   - perk redemption locks the wallet pass exactly once
//   - dev simulator drives the full pipeline end to end
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `poswh-${Date.now()}-${process.pid}`;

let app: import("express").Express;
let tenantId: number;
let partnerTenantId: number;
let staffId: number;

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

interface Integ {
  vendor: string;
  status: string;
  webhookUrl: string | null;
  signingSecret: string | null;
  signatureHeader: string;
}

async function enableVendor(vendor: string): Promise<Integ> {
  const agent = await loggedInAgent();
  const res = await agent
    .post(`/api/pos/integrations/${vendor}/enable`)
    .set("x-tenant-id", String(tenantId));
  expect(res.status).toBe(200);
  return res.body as Integ;
}

function webhookPath(integ: Integ): string {
  // The serialized URL is absolute; the path part is what supertest needs.
  return new URL(integ.webhookUrl!).pathname;
}

function sign(vendor: string, body: string, secret: string): string {
  if (vendor === "clover") return secret;
  if (vendor === "custom") return createHmac("sha256", secret).update(body).digest("hex");
  const h = createHmac("sha256", secret).update(body);
  return vendor === "boulevard" ? h.digest("hex") : h.digest("base64");
}

async function deliver(integ: Integ, payload: unknown, opts: { badSig?: boolean; rawBody?: string } = {}) {
  const body = opts.rawBody ?? JSON.stringify(payload);
  const sig = opts.badSig ? "bogus-signature" : sign(integ.vendor, body, integ.signingSecret!);
  return request(app)
    .post(webhookPath(integ))
    .set("content-type", "application/json")
    .set(integ.signatureHeader, sig)
    .send(body);
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `POS Tenant ${RUN}`, subdomain: `${RUN}-a` })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
  const [partner] = await db
    .insert(tenantsTable)
    .values({ brandName: `POS Partner ${RUN}`, subdomain: `${RUN}-b` })
    .returning({ id: tenantsTable.id });
  partnerTenantId = partner.id;

  const [staff] = await db
    .insert(sosStaffMembersTable)
    .values({
      tenantId,
      name: `Stylist ${RUN}`,
      compensationType: "commission",
      commissionPercent: 40,
    })
    .returning({ id: sosStaffMembersTable.id });
  staffId = staff.id;

  // Accepted+active partnership so a POS-completed visit grants perk passes.
  await db.insert(merchantCoopPartnershipsTable).values({
    hostTenantId: tenantId,
    partnerTenantId,
    perkTitle: `POS perk ${RUN}`,
    redemptionCode: `POSPERK-${RUN}`,
    status: "accepted",
    isActive: true,
  });
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, partnerTenantId));
});

describe("POS integration setup", () => {
  it("requires a session for merchant configuration surfaces", async () => {
    expect((await request(app).get("/api/pos/integrations")).status).toBe(401);
    expect((await request(app).post("/api/pos/integrations/square/enable")).status).toBe(401);
  });

  it("lists all five vendors, initially not configured", async () => {
    const agent = await loggedInAgent();
    const res = await agent.get("/api/pos/integrations").set("x-tenant-id", String(tenantId));
    expect(res.status).toBe(200);
    expect(res.body.map((i: Integ) => i.vendor).sort()).toEqual([
      "boulevard",
      "clover",
      "custom",
      "square",
      "vagaro",
    ]);
    for (const i of res.body as Integ[]) {
      expect(["not_configured", "active", "disabled"]).toContain(i.status);
    }
  });

  it("enable provisions a webhook endpoint URL and signing secret", async () => {
    const integ = await enableVendor("square");
    expect(integ.status).toBe("active");
    expect(integ.webhookUrl).toMatch(/\/api\/pos\/webhooks\/square\/pwh_/);
    expect(integ.signingSecret).toMatch(/^possk_/);
    expect(integ.signatureHeader).toBe("x-square-hmacsha256-signature");
    // Secret is stored encrypted, never in plaintext.
    const [row] = await db
      .select()
      .from(posIntegrationsTable)
      .where(
        and(eq(posIntegrationsTable.tenantId, tenantId), eq(posIntegrationsTable.vendor, "square"))
      );
    expect(row.signingSecretEncrypted).not.toContain(integ.signingSecret!);
    expect(row.signingSecretEncrypted).toMatch(/^v1:/);
  });

  it("rejects unknown vendors", async () => {
    const agent = await loggedInAgent();
    const res = await agent
      .post("/api/pos/integrations/toast/enable")
      .set("x-tenant-id", String(tenantId));
    expect(res.status).toBe(404);
  });
});

describe("signature verification", () => {
  it("rejects deliveries with a missing or invalid signature", async () => {
    const integ = await enableVendor("square");
    const payload = { event_id: `${RUN}-badsig`, type: "booking.updated", data: {} };
    const noSig = await request(app)
      .post(webhookPath(integ))
      .set("content-type", "application/json")
      .send(JSON.stringify(payload));
    expect(noSig.status).toBe(401);
    const badSig = await deliver(integ, payload, { badSig: true });
    expect(badSig.status).toBe(401);
  });

  it("rejects deliveries to a disabled integration", async () => {
    const integ = await enableVendor("square");
    const agent = await loggedInAgent();
    await agent.post("/api/pos/integrations/square/disable").set("x-tenant-id", String(tenantId));
    const res = await deliver(integ, { event_id: `${RUN}-disabled`, type: "booking.updated" });
    expect(res.status).toBe(409);
    await agent.post("/api/pos/integrations/square/enable").set("x-tenant-id", String(tenantId));
  });
});

describe("normalized event pipeline", () => {
  it("Square check-in creates a platform visit and the customer", async () => {
    const integ = await enableVendor("square");
    const res = await deliver(integ, {
      event_id: `${RUN}-sq-checkin`,
      type: "booking.updated",
      data: {
        object: {
          booking: {
            status: "CHECKED_IN",
            customer: { name: `Ada ${RUN}`, phone_number: "555-201-0001" },
            service_name: "Haircut",
          },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processed");

    const [customer] = await db
      .select()
      .from(sosCustomersTable)
      .where(and(eq(sosCustomersTable.tenantId, tenantId), eq(sosCustomersTable.name, `Ada ${RUN}`)));
    expect(customer).toBeTruthy();
    const [visit] = await db
      .select()
      .from(sosVisitsTable)
      .where(eq(sosVisitsTable.customerId, customer.id));
    expect(visit.status).toBe("checked_in");
    expect(visit.serviceType).toBe("Haircut");
  });

  it("Square completion advances that visit with payment, staff attribution, and perk grant", async () => {
    const integ = await enableVendor("square");
    const res = await deliver(integ, {
      event_id: `${RUN}-sq-complete`,
      type: "booking.updated",
      data: {
        object: {
          booking: {
            status: "COMPLETED",
            customer: { name: `Ada ${RUN}`, phone_number: "555-201-0001" },
            service_name: "Haircut",
            team_member_name: `Stylist ${RUN}`,
            amount_money: { amount: 4500, currency: "USD" },
          },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processed");

    const [customer] = await db
      .select()
      .from(sosCustomersTable)
      .where(and(eq(sosCustomersTable.tenantId, tenantId), eq(sosCustomersTable.name, `Ada ${RUN}`)));
    const visits = await db
      .select()
      .from(sosVisitsTable)
      .where(eq(sosVisitsTable.customerId, customer.id));
    // The check-in visit was advanced, not duplicated.
    expect(visits).toHaveLength(1);
    expect(visits[0].status).toBe("checked_out");
    expect(visits[0].paymentAmount).toBe("45.00");
    expect(visits[0].staffId).toBe(staffId);

    // Downstream co-op effect: the customer's wallet received a perk pass.
    const passes = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.customerPhone, "+15552010001"));
    expect(passes.length).toBe(1);
  });

  it("is idempotent: a vendor retry of the same event id is a duplicate no-op", async () => {
    const integ = await enableVendor("clover");
    const payload = {
      eventId: `${RUN}-cl-checkin`,
      type: "CUSTOMER_CHECKIN",
      object: { customer: { name: `Bob ${RUN}`, phone: "555-201-0002" }, service: "Shave" },
    };
    const first = await deliver(integ, payload);
    expect(first.body.status).toBe("processed");
    const retry = await deliver(integ, payload);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("duplicate");

    const [customer] = await db
      .select()
      .from(sosCustomersTable)
      .where(and(eq(sosCustomersTable.tenantId, tenantId), eq(sosCustomersTable.name, `Bob ${RUN}`)));
    const visits = await db
      .select()
      .from(sosVisitsTable)
      .where(eq(sosVisitsTable.customerId, customer.id));
    expect(visits).toHaveLength(1);
  });

  it("Boulevard and Vagaro check-ins verify and process with their own schemes", async () => {
    const blvd = await enableVendor("boulevard");
    const b = await deliver(blvd, {
      id: `${RUN}-bl-arrived`,
      event: "appointment.state_changed",
      data: {
        appointment: {
          state: "arrived",
          client: { name: `Cyd ${RUN}`, mobile_phone: "555-201-0003" },
          service_name: "Color",
        },
      },
    });
    expect(b.body.status).toBe("processed");

    const vagaro = await enableVendor("vagaro");
    const v = await deliver(vagaro, {
      eventId: `${RUN}-vg-complete`,
      eventType: "appointment.completed",
      data: {
        customer: { name: `Dee ${RUN}`, phone: "555-201-0004" },
        serviceTitle: "Massage",
        price: 80,
      },
    });
    expect(v.body.status).toBe("processed");
    const [dee] = await db
      .select()
      .from(sosCustomersTable)
      .where(and(eq(sosCustomersTable.tenantId, tenantId), eq(sosCustomersTable.name, `Dee ${RUN}`)));
    const [visit] = await db.select().from(sosVisitsTable).where(eq(sosVisitsTable.customerId, dee.id));
    expect(visit.status).toBe("checked_out");
    expect(visit.paymentAmount).toBe("80.00");
  });

  it("custom/legacy connector normalizes the generic envelope end to end", async () => {
    const custom = await enableVendor("custom");
    expect(custom.signatureHeader).toBe("x-gnil-signature");
    const res = await deliver(custom, {
      eventId: `${RUN}-custom-complete`,
      type: "service_completed",
      customer: { name: `Edy ${RUN}`, phone: "555-201-0005" },
      serviceType: "Facial",
      staffName: `Stylist ${RUN}`,
      paymentAmount: 65,
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processed");
    const [edy] = await db
      .select()
      .from(sosCustomersTable)
      .where(and(eq(sosCustomersTable.tenantId, tenantId), eq(sosCustomersTable.name, `Edy ${RUN}`)));
    const [visit] = await db.select().from(sosVisitsTable).where(eq(sosVisitsTable.customerId, edy.id));
    expect(visit.status).toBe("checked_out");
    expect(visit.paymentAmount).toBe("65.00");
    // Bad signature on the custom scheme is rejected like every other vendor.
    const bad = await deliver(custom, { eventId: `${RUN}-custom-bad`, type: "check_in" }, { badSig: true });
    expect(bad.status).toBe(401);
  });

  it("logs malformed and unrecognized events instead of dropping them", async () => {
    const integ = await enableVendor("square");
    const malformed = await deliver(integ, null, { rawBody: "this is not json{{" });
    expect(malformed.status).toBe(200);
    expect(malformed.body.status).toBe("invalid");

    const unrecognized = await deliver(integ, {
      event_id: `${RUN}-sq-unknown`,
      type: "inventory.count.updated",
    });
    expect(unrecognized.status).toBe(200);
    expect(unrecognized.body.status).toBe("unrecognized");

    const agent = await loggedInAgent();
    const log = await agent.get("/api/pos/events").set("x-tenant-id", String(tenantId));
    expect(log.status).toBe(200);
    const statuses = log.body.map((e: { status: string }) => e.status);
    expect(statuses).toContain("invalid");
    expect(statuses).toContain("unrecognized");
    expect(statuses).toContain("processed");
    // The signing secret never leaks into the event log payload surface.
    expect(JSON.stringify(log.body)).not.toContain("possk_");
  });

  it("redeems a wallet perk pass exactly once via POS redemption events", async () => {
    // The completion test granted Ada a pass — redeem it from the partner side.
    const [pass] = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.customerPhone, "+15552010001"));
    expect(pass).toBeTruthy();

    // Enable the connector for the PARTNER tenant (the redeeming business).
    const agent = await loggedInAgent();
    const enabled = await agent
      .post("/api/pos/integrations/vagaro/enable")
      .set("x-tenant-id", String(partnerTenantId));
    const integ = enabled.body as Integ;

    const payload = (id: string) => ({
      eventId: id,
      eventType: "promotion.redeemed",
      data: { promoCode: pass.token },
    });
    const first = await deliver(integ, payload(`${RUN}-vg-redeem-1`));
    expect(first.body.status).toBe("processed");

    const [redeemed] = await db.select().from(perkPassesTable).where(eq(perkPassesTable.id, pass.id));
    expect(redeemed.redeemedAt).not.toBeNull();
    expect(redeemed.redeemedByTenantId).toBe(partnerTenantId);

    // A second redemption attempt (new event id) is ignored, not re-applied.
    const second = await deliver(integ, payload(`${RUN}-vg-redeem-2`));
    expect(second.body.status).toBe("ignored");

    // Exactly one attribution event exists for this redemption, with the
    // redeeming (partner) tenant as the receiver.
    const events = await db
      .select()
      .from(coopAttributionEventsTable)
      .where(eq(coopAttributionEventsTable.partnershipId, pass.partnershipId));
    expect(events.length).toBe(1);
    expect(events[0].receivingTenantId).toBe(partnerTenantId);
    expect(events[0].direction).toBe("host_to_partner");
  });

  it("rejects a POS redemption from a tenant outside the pass's partnership", async () => {
    // Grant a fresh pass for the same partnership, then present its token
    // through an OUTSIDER tenant's POS integration.
    const [pass] = await db
      .select()
      .from(perkPassesTable)
      .where(eq(perkPassesTable.customerPhone, "+15552010001"));
    const [fresh] = await db
      .insert(perkPassesTable)
      .values({
        partnershipId: pass.partnershipId,
        grantedByTenantId: pass.grantedByTenantId,
        customerPhone: "+15552010002",
        token: `WPASS-${RUN}-OUTSIDER`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning();
    const [outsider] = await db
      .insert(tenantsTable)
      .values([{ brandName: `POS Outsider ${RUN}`, subdomain: `${RUN}-posout`, status: "active" }])
      .returning({ id: tenantsTable.id });
    try {
      const agent = await loggedInAgent();
      const enabled = await agent
        .post("/api/pos/integrations/vagaro/enable")
        .set("x-tenant-id", String(outsider.id));
      const integ = enabled.body as Integ;
      const res = await deliver(integ, {
        eventId: `${RUN}-vg-outsider-1`,
        eventType: "promotion.redeemed",
        data: { promoCode: fresh.token },
      });
      expect(res.body.status).toBe("error");

      // No writes: the pass is still unredeemed and no attribution recorded.
      const [after] = await db
        .select()
        .from(perkPassesTable)
        .where(eq(perkPassesTable.id, fresh.id));
      expect(after.redeemedAt).toBeNull();
      const events = await db
        .select()
        .from(coopAttributionEventsTable)
        .where(eq(coopAttributionEventsTable.partnershipId, pass.partnershipId));
      expect(events.length).toBe(1);
    } finally {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, outsider.id));
      await db.delete(perkPassesTable).where(eq(perkPassesTable.id, fresh.id));
    }
  });
});

describe("dev simulator", () => {
  it("posts a vendor-shaped payload through the full pipeline", async () => {
    await enableVendor("boulevard");
    const agent = await loggedInAgent();
    const res = await agent
      .post("/api/pos/simulate")
      .set("x-tenant-id", String(tenantId))
      .send({
        vendor: "boulevard",
        kind: "service_completed",
        customerName: `Sim ${RUN}`,
        customerPhone: "555-201-0009",
        serviceType: "Blowout",
        paymentAmount: 65,
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processed");
    // The simulated payload is vendor-shaped (Boulevard envelope).
    expect(JSON.parse(res.body.payload).event).toBe("appointment.state_changed");

    const [customer] = await db
      .select()
      .from(sosCustomersTable)
      .where(and(eq(sosCustomersTable.tenantId, tenantId), eq(sosCustomersTable.name, `Sim ${RUN}`)));
    const [visit] = await db
      .select()
      .from(sosVisitsTable)
      .where(eq(sosVisitsTable.customerId, customer.id));
    expect(visit.status).toBe("checked_out");
    expect(visit.paymentAmount).toBe("65.00");
  });

  it("requires the integration to be enabled first", async () => {
    const agent = await loggedInAgent();
    const res = await agent
      .post("/api/pos/simulate")
      .set("x-tenant-id", String(partnerTenantId))
      .send({ vendor: "clover", kind: "check_in", customerName: "Nobody" });
    expect(res.status).toBe(409);
  });
});
