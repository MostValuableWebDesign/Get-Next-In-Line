import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosServicesTable, sosSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Structured service catalog (sos_services): CRUD + reorder with strict
// tenant scoping, and the one-time backfill from the legacy comma-separated
// serviceNames setting.
//
// Isolation: two throwaway tenants per run (their rows cascade on delete);
// no legacy (NULL-tenant) rows are created so parallel suites are unaffected.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL; // deterministic fallback parser

const RUN = `svc-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;

const asTenant = (id: number) => ({ "x-tenant-id": String(id) });

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

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `SvcCat A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `SvcCat B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;
});

afterAll(async () => {
  // Tenants cascade to their settings and service rows.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("service catalog CRUD is scoped per business", () => {
  let svcA: number;
  let svcA2: number;
  let svcB: number;

  it("creates services under the calling tenant's scope with full fields", async () => {
    const created = await agent
      .post("/api/sos/services")
      .set(asTenant(tenantA))
      .send({
        name: "Balayage",
        category: "Hair",
        description: "Full balayage with toner",
        price: 180.5,
        durationMinutes: 120,
      })
      .expect(201);
    svcA = created.body.id;
    expect(created.body).toMatchObject({
      name: "Balayage",
      category: "Hair",
      price: 180.5,
      durationMinutes: 120,
      isActive: true,
      sortOrder: 0,
    });

    svcA2 = (
      await agent
        .post("/api/sos/services")
        .set(asTenant(tenantA))
        .send({ name: "Quick Trim" })
        .expect(201)
    ).body.id;
    svcB = (
      await agent
        .post("/api/sos/services")
        .set(asTenant(tenantB))
        .send({ name: "Oil Change", price: 49.99, durationMinutes: 30 })
        .expect(201)
    ).body.id;
  });

  it("rejects duplicate names case-insensitively within a scope", async () => {
    await agent
      .post("/api/sos/services")
      .set(asTenant(tenantA))
      .send({ name: "balayage" })
      .expect(409);
    // Same name in another scope is fine.
    await agent
      .post("/api/sos/services")
      .set(asTenant(tenantB))
      .send({ name: "Balayage" })
      .expect(201);
  });

  it("lists only the selected tenant's services, in sort order", async () => {
    const forA = await agent.get("/api/sos/services").set(asTenant(tenantA)).expect(200);
    expect(forA.body.map((s: { id: number }) => s.id)).toEqual([svcA, svcA2]);
    const ids = forA.body.map((s: { id: number }) => s.id);
    expect(ids).not.toContain(svcB);
  });

  it("refuses cross-tenant updates and deletes", async () => {
    await agent
      .patch(`/api/sos/services/${svcA}`)
      .set(asTenant(tenantB))
      .send({ price: 1 })
      .expect(404);
    await agent.delete(`/api/sos/services/${svcA}`).set(asTenant(tenantB)).expect(404);
    // Legacy scope can't touch it either.
    await agent.patch(`/api/sos/services/${svcA}`).send({ price: 1 }).expect(404);
  });

  it("updates fields, including clearing price and toggling active", async () => {
    const updated = await agent
      .patch(`/api/sos/services/${svcA}`)
      .set(asTenant(tenantA))
      .send({ price: null, isActive: false, category: null, description: "updated" })
      .expect(200);
    expect(updated.body).toMatchObject({
      price: null,
      isActive: false,
      category: null,
      description: "updated",
    });
    // restore
    await agent
      .patch(`/api/sos/services/${svcA}`)
      .set(asTenant(tenantA))
      .send({ isActive: true, price: 180.5 })
      .expect(200);
  });

  it("reorders within the scope and rejects invalid permutations", async () => {
    const reordered = await agent
      .post("/api/sos/services/reorder")
      .set(asTenant(tenantA))
      .send({ orderedIds: [svcA2, svcA] })
      .expect(200);
    expect(reordered.body.map((s: { id: number }) => s.id)).toEqual([svcA2, svcA]);

    // Foreign id, missing id, duplicates — all rejected.
    await agent
      .post("/api/sos/services/reorder")
      .set(asTenant(tenantA))
      .send({ orderedIds: [svcA2, svcB] })
      .expect(400);
    await agent
      .post("/api/sos/services/reorder")
      .set(asTenant(tenantA))
      .send({ orderedIds: [svcA] })
      .expect(400);
    await agent
      .post("/api/sos/services/reorder")
      .set(asTenant(tenantA))
      .send({ orderedIds: [svcA, svcA] })
      .expect(400);
  });

  it("deletes a service in-scope", async () => {
    await agent.delete(`/api/sos/services/${svcA2}`).set(asTenant(tenantA)).expect(204);
    const forA = await agent.get("/api/sos/services").set(asTenant(tenantA)).expect(200);
    expect(forA.body.map((s: { id: number }) => s.id)).not.toContain(svcA2);
  });
});

describe("legacy serviceNames backfill", () => {
  it("creates catalog rows from the comma-separated setting, once, and never overwrites", async () => {
    // Give tenant B a legacy serviceNames string but wipe its catalog first.
    await agent
      .patch(`/api/tenants/${tenantB}/settings`)
      .send({ serviceNames: "Tire Rotation, Brake Check , tire rotation" })
      .expect(200);
    await db.delete(sosServicesTable).where(eq(sosServicesTable.tenantId, tenantB));

    const { backfillServiceCatalog } = await import("../../lib/serviceCatalog");
    await backfillServiceCatalog();

    const rows = await db
      .select()
      .from(sosServicesTable)
      .where(eq(sosServicesTable.tenantId, tenantB));
    // De-duped: "tire rotation" duplicate dropped.
    expect(rows.map((r) => r.name).sort()).toEqual(["Brake Check", "Tire Rotation"]);

    // Second run is a no-op even after the owner edits the catalog.
    await agent
      .patch(`/api/sos/services/${rows[0].id}`)
      .set(asTenant(tenantB))
      .send({ price: 25 })
      .expect(200);
    await backfillServiceCatalog();
    const again = await db
      .select()
      .from(sosServicesTable)
      .where(eq(sosServicesTable.tenantId, tenantB));
    expect(again).toHaveLength(2);
    expect(again.find((r) => r.id === rows[0].id)?.price).toBe("25.00");
  });
});

describe("AI receptionist uses the structured catalog vocabulary", () => {
  it("recognizes a catalog service name in a simulated call (fallback parser)", async () => {
    await agent
      .patch(`/api/tenants/${tenantA}/settings`)
      .send({ aiReceptionistEnabled: true })
      .expect(200);
    const res = await agent
      .post("/api/sos/calls")
      .set(asTenant(tenantA))
      .send({
        fromNumber: "+15550009999",
        callerName: "Cat Alog",
        inquiry: "Hi, I'd like to book a balayage tomorrow",
      })
      .expect(201);
    // Fallback parser matches the catalog name case-insensitively and uses
    // the catalog's exact casing lookup for duration; intent is a booking.
    expect(res.body.intent).toBe("book_appointment");
  });

  it("books with the catalog's estimated duration for the matched service", async () => {
    const res = await agent
      .post("/api/sos/calls")
      .set(asTenant(tenantA))
      .send({
        fromNumber: "+15550009999",
        inquiry: "Please book a Balayage tomorrow",
      })
      .expect(201);
    expect(res.body.outcome).toBe("booked");
    const appts = await agent.get("/api/sos/appointments").set(asTenant(tenantA)).expect(200);
    const appt = appts.body.find((a: { serviceType: string }) => a.serviceType === "Balayage");
    expect(appt).toBeTruthy();
    const minutes =
      (new Date(appt.endsAt).getTime() - new Date(appt.startsAt).getTime()) / 60000;
    expect(minutes).toBe(120);
  });
});
