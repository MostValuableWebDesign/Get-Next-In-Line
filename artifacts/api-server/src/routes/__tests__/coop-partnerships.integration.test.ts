import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "crypto";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  merchantCoopPartnershipsTable,
  usersTable,
  userTenantMembershipsTable,
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
  // Tenant-scoped routes now require explicit tenant context; these tests
  // exercise the legacy (NULL-tenant) scope unless a request overrides it.
  agent.set("x-tenant-id", "legacy");
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

  it("rejects a duplicate redemption code only within the same host business", async () => {
    // Same host reusing its own code → collision.
    const res = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: salonAId,
        partnerTenantId: cafeId,
        perkTitle: "Dup code",
        redemptionCode: autoCode,
      })
      .expect(400);
    expect(res.body.message).toMatch(/already in use/i);

    // A different host may use the identical code — uniqueness is per host,
    // so one business can't squat on another's codes.
    const reuse = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: cafeId,
        partnerTenantId: salonBId,
        perkTitle: "Same code, different host",
        redemptionCode: autoCode,
      })
      .expect(201);
    expect(reuse.body.redemptionCode).toBe(autoCode);
    // Clean up so validation assertions below resolve a single partnership.
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, reuse.body.id));
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
    const res = await agent
      .get(`/api/coop/redemptions/${autoCode}`)
      .set("x-tenant-id", String(salonAId))
      .expect(200);
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
      .set("x-tenant-id", String(salonAId))
      .send({ perkTitle: "Free latte with any cut", isActive: false })
      .expect(200);
    expect(upd.body.perkTitle).toBe("Free latte with any cut");
    expect(upd.body.isActive).toBe(false);

    const res = await agent
      .get(`/api/coop/redemptions/${autoCode}`)
      .set("x-tenant-id", String(salonAId))
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toMatch(/no longer active/i);

    // Reactivation restores validation.
    await agent
      .patch(`/api/coop/partnerships/${partnershipId}`)
      .set("x-tenant-id", String(salonAId))
      .send({ isActive: true })
      .expect(200);
    const again = await agent
      .get(`/api/coop/redemptions/${autoCode}`)
      .set("x-tenant-id", String(salonAId))
      .expect(200);
    expect(again.body.valid).toBe(true);
  });

  it("404s when updating a missing partnership", async () => {
    await agent
      .patch("/api/coop/partnerships/99999999")
      .set("x-tenant-id", String(salonAId))
      .send({ isActive: false })
      .expect(404);
  });
});

describe("co-op perk date windows, disclaimer, expiry sweep, and redemption locking", () => {
  const HOUR = 60 * 60 * 1000;

  async function createPartnership(extra: Record<string, unknown> = {}) {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: cafeId,
        partnerTenantId: salonBId,
        perkTitle: `Windowed perk ${RUN}`,
        ...extra,
      })
      .expect(201);
    return res.body as { id: number; redemptionCode: string };
  }

  it("rejects an end date before the start date on create, invite, and update", async () => {
    const start = new Date(Date.now() + 2 * HOUR).toISOString();
    const end = new Date(Date.now() + HOUR).toISOString();
    const res = await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: cafeId, partnerTenantId: salonBId, perkTitle: "bad window", perkStartsAt: start, perkEndsAt: end })
      .expect(400);
    expect(res.body.message).toMatch(/end date must be after/i);

    const inviteRes = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(cafeId))
      .send({ partnerTenantId: salonBId, perkTitle: "bad window", perkStartsAt: start, perkEndsAt: end })
      .expect(400);
    expect(inviteRes.body.message).toMatch(/end date must be after/i);

    const created = await createPartnership({ perkStartsAt: new Date(Date.now() - HOUR).toISOString() });
    // Updating only the end below the existing start must also be rejected.
    await agent
      .patch(`/api/coop/partnerships/${created.id}`)
      .set("x-tenant-id", String(cafeId))
      .send({ perkEndsAt: new Date(Date.now() - 2 * HOUR).toISOString() })
      .expect(400);
    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, created.id));
  });

  it("serves a window-open perk with the shared disclaimer, and filters scheduled/expired perks", async () => {
    const open = await createPartnership({
      perkStartsAt: new Date(Date.now() - HOUR).toISOString(),
      perkEndsAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const scheduled = await createPartnership({
      perkTitle: `Scheduled perk ${RUN}`,
      redemptionCode: `SCHED-${Date.now()}`,
      perkStartsAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const expired = await createPartnership({
      perkTitle: `Expired perk ${RUN}`,
      redemptionCode: `EXPRD-${Date.now()}`,
      perkEndsAt: new Date(Date.now() - HOUR).toISOString(),
    });

    const perksRes = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(perksRes.body.disclaimer).toMatch(/operates independently/i);
    expect(perksRes.body.disclaimer).toMatch(/solely responsible and liable/i);
    const ids = perksRes.body.perks.map((p: { id: number }) => p.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(scheduled.id);
    expect(ids).not.toContain(expired.id);

    // The public landing perks JSON carries the same disclaimer and filters too.
    const publicRes = await anon.get(`/api/public/landing/${RUN}-cafe/perks`).expect(200);
    expect(publicRes.body.disclaimer).toMatch(/operates independently/i);
    const titles = publicRes.body.perks.map((p: { perkTitle: string }) => p.perkTitle);
    expect(titles).toContain(`Windowed perk ${RUN}`);
    expect(titles).not.toContain(`Scheduled perk ${RUN}`); // outside window — excluded
    expect(titles).not.toContain(`Expired perk ${RUN}`);

    // Validation endpoint respects the window (scoped to a participant).
    const validRes = await agent
      .get(`/api/coop/redemptions/${open.redemptionCode}`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(validRes.body.valid).toBe(true);
    const schedRes = await agent
      .get(`/api/coop/redemptions/${scheduled.redemptionCode}`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(schedRes.body.valid).toBe(false);
    expect(schedRes.body.reason).toMatch(/not active yet/i);
    const expRes = await agent
      .get(`/api/coop/redemptions/${expired.redemptionCode}`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(expRes.body.valid).toBe(false);
    expect(expRes.body.reason).toMatch(/expired/i);

    // The scheduled sweep archives the expired perk (isActive false) without deleting it.
    const { sweepExpiredCoopPerks } = await import("../../workers/concierge");
    await sweepExpiredCoopPerks();
    const [expiredRow] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, expired.id));
    expect(expiredRow).toBeDefined();
    expect(expiredRow.isActive).toBe(false);
    const [openRow] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, open.id));
    expect(openRow.isActive).toBe(true);

    await db
      .delete(merchantCoopPartnershipsTable)
      .where(inArray(merchantCoopPartnershipsTable.id, [open.id, scheduled.id, expired.id]));
  });

  it("redeems a pass once, rejects double redemption (including concurrent scans)", async () => {
    const p = await createPartnership();
    const passCode = `C-${RUN}-pass1`;

    const first = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonBId))
      .send({ code: p.redemptionCode, passCode })
      .expect(200);
    expect(first.body.valid).toBe(true);
    expect(first.body.redeemedAt).toBeTruthy();
    expect(first.body.partnership.id).toBe(p.id);

    const second = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonBId))
      .send({ code: p.redemptionCode, passCode })
      .expect(200);
    expect(second.body.valid).toBe(false);
    expect(second.body.reason).toMatch(/already redeemed/i);
    expect(second.body.redeemedAt).toBe(first.body.redeemedAt);

    // A different pass instance for the same partnership still redeems.
    const other = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonBId))
      .send({ code: p.redemptionCode, passCode: `C-${RUN}-pass2` })
      .expect(200);
    expect(other.body.valid).toBe(true);

    // Concurrent double-scan of a fresh pass: exactly one wins.
    const racePass = `C-${RUN}-race`;
    const [a, b] = await Promise.all([
      agent.post("/api/coop/redemptions").set("x-tenant-id", String(salonBId)).send({ code: p.redemptionCode, passCode: racePass }),
      agent.post("/api/coop/redemptions").set("x-tenant-id", String(salonBId)).send({ code: p.redemptionCode, passCode: racePass }),
    ]);
    const validCount = [a.body.valid, b.body.valid].filter(Boolean).length;
    expect(validCount).toBe(1);

    // Unknown code and out-of-window codes fail redemption.
    const unknown = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonBId))
      .send({ code: `NOPE-${RUN}`, passCode: "x" })
      .expect(200);
    expect(unknown.body.valid).toBe(false);
    expect(unknown.body.reason).toMatch(/unknown/i);

    await agent
      .patch(`/api/coop/partnerships/${p.id}`)
      .set("x-tenant-id", String(cafeId))
      .send({ perkStartsAt: new Date(Date.now() - 2 * HOUR).toISOString(), perkEndsAt: new Date(Date.now() - HOUR).toISOString() })
      .expect(200);
    const expiredRedeem = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonBId))
      .send({ code: p.redemptionCode, passCode: `C-${RUN}-late` })
      .expect(200);
    expect(expiredRedeem.body.valid).toBe(false);
    expect(expiredRedeem.body.reason).toMatch(/expired/i);

    // Missing tenant scope is rejected outright.
    await agent.post("/api/coop/redemptions").send({ code: p.redemptionCode, passCode: "x" }).expect(400);
    await anon.post("/api/coop/redemptions").send({ code: p.redemptionCode, passCode: "x" }).expect(401);

    await db.delete(merchantCoopPartnershipsTable).where(eq(merchantCoopPartnershipsTable.id, p.id));
  });
});

describe("cross-tenant partnership lockdown", () => {
  let lockedId: number;
  let memberAgent: ReturnType<typeof request.agent>;
  let memberUserId: number;

  beforeAll(async () => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: salonAId, partnerTenantId: cafeId, perkTitle: `Lockdown perk ${RUN}` })
      .expect(201);
    lockedId = res.body.id;

    // A non-admin member of Salon B — not a participant in the partnership.
    const app = (await import("../../app")).default;
    const loginToken = `tok-${RUN}-${randomBytes(12).toString("hex")}`;
    const [user] = await db
      .insert(usersTable)
      .values({ username: `member-${RUN}`, isPlatformAdmin: false, loginToken })
      .returning({ id: usersTable.id });
    memberUserId = user.id;
    await db.insert(userTenantMembershipsTable).values({ userId: memberUserId, tenantId: salonBId });
    memberAgent = request.agent(app);
    await memberAgent.post("/api/auth/login").send({ loginToken }).expect(200);
  });

  afterAll(async () => {
    await db.delete(usersTable).where(eq(usersTable.id, memberUserId));
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, lockedId));
  });

  it("rejects a non-admin listing without any tenant context", async () => {
    // Unscoped list is a platform-admin surface; members must scope to a tenant.
    await memberAgent.get("/api/coop/partnerships").expect(403);
  });

  it("rejects a mismatched header/query tenant pair", async () => {
    await agent
      .get(`/api/coop/partnerships?tenantId=${salonAId}`)
      .set("x-tenant-id", String(salonBId))
      .expect(403);
  });

  it("scoped listing never contains another tenant's partnerships", async () => {
    const res = await agent
      .get("/api/coop/partnerships")
      .set("x-tenant-id", String(salonBId))
      .expect(200);
    expect(res.body.some((p: { id: number }) => p.id === lockedId)).toBe(false);
    for (const p of res.body as Array<{ hostTenantId: number; partnerTenantId: number }>) {
      expect([p.hostTenantId, p.partnerTenantId]).toContain(salonBId);
    }
  });

  it("rejects updates without tenant context and from non-participants", async () => {
    await agent.patch(`/api/coop/partnerships/${lockedId}`).send({ isActive: false }).expect(400);
    const forbidden = await agent
      .patch(`/api/coop/partnerships/${lockedId}`)
      .set("x-tenant-id", String(salonBId))
      .send({ isActive: false })
      .expect(403);
    expect(forbidden.body.message).toMatch(/participant/i);
    // The row is untouched by the rejected attempts.
    const [row] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, lockedId));
    expect(row.isActive).toBe(true);
    // Either participant (here: the partner side) may still update.
    await agent
      .patch(`/api/coop/partnerships/${lockedId}`)
      .set("x-tenant-id", String(cafeId))
      .send({ isActive: false })
      .expect(200);
  });
});
