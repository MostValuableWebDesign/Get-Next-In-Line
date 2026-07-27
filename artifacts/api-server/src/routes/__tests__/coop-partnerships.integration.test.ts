import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  merchantCoopPartnershipsTable,
} from "@workspace/db";
import { eq, inArray, or } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Merchant co-op partnerships (/coop/*), against the real dev DB. Covers:
// session protection, industry-barrier enforcement + explicit override,
// redemption-code auto-generation/uniqueness, code validation (active vs
// inactive vs unknown), deactivate/reactivate, and tenant-filtered listing.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coop-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
// Salon A and Salon B share a module category (competitors); Cafe has a
// different category.
let salonAId: number;
let salonBId: number;
let cafeId: number;
let moduleAId: number;
let moduleBId: number;
let cafeModuleId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  anon = request(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Coop Salon A ${RUN}`, subdomain: `${RUN}-salon-a`, status: "active" },
      { brandName: `Coop Salon B ${RUN}`, subdomain: `${RUN}-salon-b`, status: "active" },
      { brandName: `Coop Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [salonAId, salonBId, cafeId] = tenants.map((t) => t.id);

  const modules = await db
    .insert(modulesTable)
    .values([
      {
        name: `Coop Salon Suite ${RUN}`,
        category: `Coop Salon Ops ${RUN}`,
        categorySlug: `coop-salon-ops-${RUN}`,
        description: "test",
        wholesalePrice: "10",
      },
      {
        name: `Coop Salon Suite B ${RUN}`,
        category: `Coop Salon Ops ${RUN}`,
        categorySlug: `coop-salon-ops-${RUN}`,
        description: "test",
        wholesalePrice: "10",
      },
      {
        name: `Coop Cafe Suite ${RUN}`,
        category: `Coop Cafe Ops ${RUN}`,
        categorySlug: `coop-cafe-ops-${RUN}`,
        description: "test",
        wholesalePrice: "10",
      },
    ])
    .returning({ id: modulesTable.id });
  [moduleAId, moduleBId, cafeModuleId] = modules.map((m) => m.id);

  await db.insert(tenantModulesTable).values([
    { tenantId: salonAId, moduleId: moduleAId },
    { tenantId: salonBId, moduleId: moduleBId },
    { tenantId: cafeId, moduleId: cafeModuleId },
  ]);
});

afterAll(async () => {
  const tenantIds = [salonAId, salonBId, cafeId].filter((n) => Number.isInteger(n));
  if (tenantIds.length) {
    // Cascades clean up tenant_modules and partnerships.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  }
  const moduleIds = [moduleAId, moduleBId, cafeModuleId].filter((n) => Number.isInteger(n));
  if (moduleIds.length) {
    await db.delete(modulesTable).where(inArray(modulesTable.id, moduleIds));
  }
});

describe("merchant co-op partnerships", () => {
  it("requires a session on every /coop endpoint", async () => {
    await anon.get("/api/coop/partnerships").expect(401);
    await anon
      .post("/api/coop/partnerships")
      .send({ hostTenantId: 1, partnerTenantId: 2, perkTitle: "x" })
      .expect(401);
    await anon.patch("/api/coop/partnerships/1").send({ isActive: false }).expect(401);
    await anon.get("/api/coop/redemptions/SOMECODE").expect(401);
  });

  it("blocks two tenants in the same module category (industry barrier)", async () => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: salonAId, partnerTenantId: salonBId, perkTitle: "Free blowout" })
      .expect(409);
    expect(res.body.message).toMatch(/Industry barrier/i);
    expect(res.body.sharedCategories).toContain(`Coop Salon Ops ${RUN}`);
  });

  it("allows the same pairing with an explicit override, flagged as overridden", async () => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: salonAId,
        partnerTenantId: salonBId,
        perkTitle: "Free blowout",
        overrideIndustryBarrier: true,
      })
      .expect(201);
    expect(res.body.industryBarrierOverridden).toBe(true);
    expect(res.body.isActive).toBe(true);
    // Clean up so listing assertions below stay focused.
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, res.body.id));
  });

  it("rejects self-partnership and unknown tenants", async () => {
    await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: salonAId, partnerTenantId: salonAId, perkTitle: "x" })
      .expect(400);
    await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: salonAId, partnerTenantId: 99999999, perkTitle: "x" })
      .expect(404);
  });

  let partnershipId: number;
  let autoCode: string;

  it("creates a cross-category partnership with an auto-generated unique code", async () => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: salonAId,
        partnerTenantId: cafeId,
        perkTitle: "Free espresso with any cut",
        perkDescription: "Show the code at the register",
      })
      .expect(201);
    partnershipId = res.body.id;
    autoCode = res.body.redemptionCode;
    expect(autoCode).toMatch(/^COOP-[A-Z2-9]{8}$/);
    expect(res.body.industryBarrierOverridden).toBe(false);
    expect(res.body.hostTenantName).toBe(`Coop Salon A ${RUN}`);
    expect(res.body.partnerTenantName).toBe(`Coop Cafe ${RUN}`);
  });

  it("rejects an explicit duplicate redemption code", async () => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: cafeId,
        partnerTenantId: salonBId,
        perkTitle: "Dup code",
        redemptionCode: autoCode,
      })
      .expect(400);
    expect(res.body.message).toMatch(/already in use/i);
  });

  it("lists partnerships filtered by tenant (host or partner)", async () => {
    const asHost = await agent.get(`/api/coop/partnerships?tenantId=${salonAId}`).expect(200);
    expect(asHost.body.some((p: { id: number }) => p.id === partnershipId)).toBe(true);
    const asPartner = await agent.get(`/api/coop/partnerships?tenantId=${cafeId}`).expect(200);
    expect(asPartner.body.some((p: { id: number }) => p.id === partnershipId)).toBe(true);
    const uninvolved = await agent.get(`/api/coop/partnerships?tenantId=${salonBId}`).expect(200);
    expect(uninvolved.body.some((p: { id: number }) => p.id === partnershipId)).toBe(false);
  });

  it("validates an active redemption code", async () => {
    const res = await agent.get(`/api/coop/redemptions/${autoCode}`).expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.reason).toBeNull();
    expect(res.body.partnership.id).toBe(partnershipId);
    expect(res.body.partnership.perkTitle).toBe("Free espresso with any cut");
  });

  it("fails validation for unknown codes", async () => {
    const res = await agent.get(`/api/coop/redemptions/NOPE-${RUN}`).expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.partnership).toBeNull();
  });

  it("edits the perk and deactivates; inactive codes fail validation", async () => {
    const upd = await agent
      .patch(`/api/coop/partnerships/${partnershipId}`)
      .send({ perkTitle: "Free latte with any cut", isActive: false })
      .expect(200);
    expect(upd.body.perkTitle).toBe("Free latte with any cut");
    expect(upd.body.isActive).toBe(false);

    const res = await agent.get(`/api/coop/redemptions/${autoCode}`).expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toMatch(/no longer active/i);

    // Reactivation restores validation.
    await agent
      .patch(`/api/coop/partnerships/${partnershipId}`)
      .send({ isActive: true })
      .expect(200);
    const again = await agent.get(`/api/coop/redemptions/${autoCode}`).expect(200);
    expect(again.body.valid).toBe(true);
  });

  it("404s when updating a missing partnership", async () => {
    await agent.patch("/api/coop/partnerships/99999999").send({ isActive: false }).expect(404);
  });
});
