import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  merchantCoopPartnershipsTable,
  sosCustomersTable,
  sosVisitsTable,
  sosSettingsTable,
  coopSurgeRulesTable,
  coopSurgeActivationsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { __clearCapacityStatusCache } from "../../lib/capacityStatus";
import { runSurgeSweep, expireSurgeBoosts } from "../../lib/surgeEngine";

// ---------------------------------------------------------------------------
// Co-op surge pricing & traffic balancing, against the real dev DB. Covers:
// capacity status (manual override + auto derivation from queue wait), surge
// rule CRUD restrictions (accepted+active only, party-only, industry-barrier
// exclusion), the trigger → boosted perk → expiry/normalization lifecycle,
// and the activations history endpoint.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `surge-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
let busyId: number; // salon (busy business, rule owner)
let partnerId: number; // cafe (off-peak partner)
let rivalId: number; // second salon — same category as busy (competitor)
let moduleIds: number[] = [];
let partnershipId: number; // busy ↔ partner, accepted+active
let rivalPartnershipId: number; // busy ↔ rival, admin-created accepted
let customerId: number;

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
      { brandName: `Surge Salon ${RUN}`, subdomain: `${RUN}-salon`, status: "active" },
      { brandName: `Surge Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Surge Rival Salon ${RUN}`, subdomain: `${RUN}-rival`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [busyId, partnerId, rivalId] = tenants.map((t) => t.id);

  const modules = await db
    .insert(modulesTable)
    .values([
      {
        name: `Surge Salon Suite ${RUN}`,
        category: `Surge Salon Ops ${RUN}`,
        categorySlug: `surge-salon-ops-${RUN}`,
        description: "test",
        wholesalePrice: "10",
      },
      {
        name: `Surge Cafe Suite ${RUN}`,
        category: `Surge Cafe Ops ${RUN}`,
        categorySlug: `surge-cafe-ops-${RUN}`,
        description: "test",
        wholesalePrice: "10",
      },
      {
        name: `Surge Rival Suite ${RUN}`,
        category: `Surge Salon Ops ${RUN}`,
        categorySlug: `surge-salon-ops-${RUN}`,
        description: "test",
        wholesalePrice: "10",
      },
    ])
    .returning({ id: modulesTable.id });
  moduleIds = modules.map((m) => m.id);
  await db.insert(tenantModulesTable).values([
    { tenantId: busyId, moduleId: moduleIds[0] },
    { tenantId: partnerId, moduleId: moduleIds[1] },
    { tenantId: rivalId, moduleId: moduleIds[2] },
  ]);

  // Coop taxonomy classification: busy and rival share the same L2
  // sub-category (direct competitors); the cafe partner does not.
  await db.insert(sosSettingsTable).values([
    { tenantId: busyId, businessName: `Surge Salon ${RUN}`, coopSubCategory: "hair-salon" },
    { tenantId: rivalId, businessName: `Surge Rival ${RUN}`, coopSubCategory: "hair-salon" },
    { tenantId: partnerId, businessName: `Surge Cafe ${RUN}`, coopSubCategory: "coffee-shop" },
  ]);

  const partnerships = await db
    .insert(merchantCoopPartnershipsTable)
    .values([
      {
        hostTenantId: busyId,
        partnerTenantId: partnerId,
        perkTitle: `Surge perk ${RUN}`,
        redemptionCode: `SRG-${RUN}-A`,
        status: "accepted",
        isActive: true,
      },
      // Competitor pairing created out-of-band (legacy/admin path) — surge
      // rules must still refuse it.
      {
        hostTenantId: busyId,
        partnerTenantId: rivalId,
        perkTitle: `Rival perk ${RUN}`,
        redemptionCode: `SRG-${RUN}-B`,
        status: "accepted",
        isActive: true,
      },
    ])
    .returning({ id: merchantCoopPartnershipsTable.id });
  [partnershipId, rivalPartnershipId] = partnerships.map((p) => p.id);

  const [customer] = await db
    .insert(sosCustomersTable)
    .values({ tenantId: busyId, name: `Surge Customer ${RUN}`, phone: `+1555${Date.now() % 10000000}` })
    .returning({ id: sosCustomersTable.id });
  customerId = customer.id;
});

afterAll(async () => {
  const tenantIds = [busyId, partnerId, rivalId].filter((n) => Number.isInteger(n));
  if (tenantIds.length) {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  }
  if (moduleIds.length) {
    await db.delete(modulesTable).where(inArray(modulesTable.id, moduleIds));
  }
});

async function setQueueWait(minutes: number | null): Promise<void> {
  await db.delete(sosVisitsTable).where(eq(sosVisitsTable.tenantId, busyId));
  if (minutes != null) {
    await db.insert(sosVisitsTable).values({
      tenantId: busyId,
      customerId,
      status: "queued",
      serviceType: `surge-svc-${RUN}`,
      estimatedWaitMinutes: minutes,
    });
  }
  __clearCapacityStatusCache();
}

describe("co-op surge pricing & traffic balancing", () => {
  it("requires a session on surge endpoints", async () => {
    await anon.get("/api/coop/capacity").expect(401);
    await anon.get("/api/coop/surge-rules").expect(401);
    await anon.get("/api/coop/surge-activations").expect(401);
  });

  it("reports an automatic available status when idle, and derives busy from queue wait", async () => {
    await setQueueWait(null);
    const idle = await agent.get("/api/coop/capacity").set("x-tenant-id", String(busyId)).expect(200);
    expect(idle.body.source).toBe("auto");
    expect(idle.body.status).toBe("available");

    await setQueueWait(50);
    const busy = await agent.get("/api/coop/capacity").set("x-tenant-id", String(busyId)).expect(200);
    expect(busy.body.status).toBe("busy");
    expect(busy.body.waitMinutes).toBe(50);
  });

  it("lets the merchant flip a manual status and revert to automatic", async () => {
    await setQueueWait(null);
    const set = await agent
      .patch("/api/coop/capacity")
      .set("x-tenant-id", String(busyId))
      .send({ manualStatus: "busy", overrideMinutes: 60 })
      .expect(200);
    expect(set.body.status).toBe("busy");
    expect(set.body.source).toBe("manual");
    expect(set.body.overrideExpiresAt).toBeTruthy();

    const cleared = await agent
      .patch("/api/coop/capacity")
      .set("x-tenant-id", String(busyId))
      .send({ manualStatus: null })
      .expect(200);
    expect(cleared.body.source).toBe("auto");
    expect(cleared.body.status).toBe("available");
  });

  it("stores the daily capacity threshold", async () => {
    const res = await agent
      .patch("/api/coop/capacity")
      .set("x-tenant-id", String(busyId))
      .send({ capacityThreshold: 30 })
      .expect(200);
    expect(res.body.capacityThreshold).toBe(30);
  });

  it("surfaces live capacity status on the co-op directory and public booking config", async () => {
    await agent
      .patch("/api/coop/capacity")
      .set("x-tenant-id", String(busyId))
      .send({ manualStatus: "busy" })
      .expect(200);
    __clearCapacityStatusCache();

    const dir = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(partnerId))
      .expect(200);
    const entry = dir.body.find((e: { id: number }) => e.id === busyId);
    expect(entry).toBeTruthy();
    expect(entry.capacityStatus).toBe("busy");

    const pub = await anon.get(`/api/public/booking/${RUN}-salon`).expect(200);
    expect(pub.body.capacityStatus).toBe("busy");

    // Revert to automatic for later tests.
    await agent
      .patch("/api/coop/capacity")
      .set("x-tenant-id", String(busyId))
      .send({ manualStatus: null })
      .expect(200);
    __clearCapacityStatusCache();
  });

  it("rejects surge rules on industry-barrier (competitor) partnerships", async () => {
    await agent
      .post("/api/coop/surge-rules")
      .set("x-tenant-id", String(busyId))
      .send({
        partnershipId: rivalPartnershipId,
        triggerType: "at_capacity",
        baseDiscountPercent: 10,
        boostedDiscountPercent: 20,
        boostDurationMinutes: 60,
      })
      .expect(403);
  });

  it("rejects surge rules from a non-party tenant and on inactive partnerships", async () => {
    await agent
      .post("/api/coop/surge-rules")
      .set("x-tenant-id", String(rivalId))
      .send({
        partnershipId,
        triggerType: "at_capacity",
        baseDiscountPercent: 10,
        boostedDiscountPercent: 20,
        boostDurationMinutes: 60,
      })
      .expect(403);

    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: false })
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    await agent
      .post("/api/coop/surge-rules")
      .set("x-tenant-id", String(busyId))
      .send({
        partnershipId,
        triggerType: "at_capacity",
        baseDiscountPercent: 10,
        boostedDiscountPercent: 20,
        boostDurationMinutes: 60,
      })
      .expect(400);
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: true })
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
  });

  it("rejects a boosted discount that is not higher than the base", async () => {
    await agent
      .post("/api/coop/surge-rules")
      .set("x-tenant-id", String(busyId))
      .send({
        partnershipId,
        triggerType: "at_capacity",
        baseDiscountPercent: 20,
        boostedDiscountPercent: 10,
        boostDurationMinutes: 60,
      })
      .expect(400);
  });

  let ruleId: number;

  it("creates a wait-threshold rule and lists it", async () => {
    const created = await agent
      .post("/api/coop/surge-rules")
      .set("x-tenant-id", String(busyId))
      .send({
        partnershipId,
        triggerType: "wait_minutes",
        waitThresholdMinutes: 45,
        baseDiscountPercent: 10,
        boostedDiscountPercent: 20,
        boostDurationMinutes: 120,
      })
      .expect(201);
    ruleId = created.body.id;
    expect(created.body.triggerType).toBe("wait_minutes");
    expect(created.body.liveBoostExpiresAt).toBeNull();

    const list = await agent
      .get("/api/coop/surge-rules")
      .set("x-tenant-id", String(busyId))
      .expect(200);
    expect(list.body.some((r: { id: number }) => r.id === ruleId)).toBe(true);
    // Not visible to the partner as an owner-side rule.
    const partnerList = await agent
      .get("/api/coop/surge-rules")
      .set("x-tenant-id", String(partnerId))
      .expect(200);
    expect(partnerList.body.some((r: { id: number }) => r.id === ruleId)).toBe(false);
  });

  it("activates a boost when the wait trigger fires, and shows it on the perks feed", async () => {
    await setQueueWait(55);
    const swept = await runSurgeSweep();
    expect(swept.activated).toBeGreaterThanOrEqual(1);

    // Idempotent: a second sweep never double-activates.
    const again = await runSurgeSweep();
    expect(again.activated).toBe(0);

    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(busyId))
      .expect(200);
    const perk = perks.body.perks.find((p: { id: number }) => p.id === partnershipId);
    expect(perk).toBeTruthy();
    expect(perk.surge).toBeTruthy();
    expect(perk.surge.boostedDiscountPercent).toBe(20);
    expect(perk.surge.baseDiscountPercent).toBe(10);
    expect(new Date(perk.surge.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Partner's surfaces show the boosted perk too.
    const partnerPerks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(partnerId))
      .expect(200);
    const partnerPerk = partnerPerks.body.perks.find((p: { id: number }) => p.id === partnershipId);
    expect(partnerPerk?.surge?.boostedDiscountPercent).toBe(20);

    const activations = await agent
      .get("/api/coop/surge-activations")
      .set("x-tenant-id", String(busyId))
      .expect(200);
    const live = activations.body.find((a: { ruleId: number; isLive: boolean }) => a.ruleId === ruleId);
    expect(live?.isLive).toBe(true);
    expect(live?.triggerReason).toContain("45");
  });

  it("reverts the boost when the wait normalizes", async () => {
    await setQueueWait(null);
    const ended = await expireSurgeBoosts();
    expect(ended).toBeGreaterThanOrEqual(1);

    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(busyId))
      .expect(200);
    const perk = perks.body.perks.find((p: { id: number }) => p.id === partnershipId);
    expect(perk.surge).toBeNull();

    const activations = await agent
      .get("/api/coop/surge-activations")
      .set("x-tenant-id", String(busyId))
      .expect(200);
    const row = activations.body.find((a: { ruleId: number }) => a.ruleId === ruleId);
    expect(row.isLive).toBe(false);
    expect(row.endReason).toBe("normalized");
  });

  it("expires a boost when its window ends even if still busy", async () => {
    await setQueueWait(60);
    await runSurgeSweep();
    // Force the live activation's window into the past.
    await db
      .update(coopSurgeActivationsTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(coopSurgeActivationsTable.ruleId, ruleId));
    const ended = await expireSurgeBoosts();
    expect(ended).toBeGreaterThanOrEqual(1);
    const activations = await agent
      .get("/api/coop/surge-activations")
      .set("x-tenant-id", String(busyId))
      .expect(200);
    const rows = activations.body.filter((a: { ruleId: number }) => a.ruleId === ruleId);
    expect(rows.every((a: { isLive: boolean }) => !a.isLive)).toBe(true);
    expect(rows.some((a: { endReason: string | null }) => a.endReason === "window_ended")).toBe(true);
    await setQueueWait(null);
  });

  it("never activates a rule whose partnership pair became industry-barred", async () => {
    // Hand-inserted rule on the competitor partnership (bypassing the API
    // guard) — the evaluation-time firewall backstop must still skip it.
    const [rogue] = await db
      .insert(coopSurgeRulesTable)
      .values({
        partnershipId: rivalPartnershipId,
        ownerTenantId: busyId,
        triggerType: "at_capacity",
        baseDiscountPercent: 5,
        boostedDiscountPercent: 15,
        boostDurationMinutes: 60,
      })
      .returning({ id: coopSurgeRulesTable.id });
    await agent
      .patch("/api/coop/capacity")
      .set("x-tenant-id", String(busyId))
      .send({ manualStatus: "busy" })
      .expect(200);
    __clearCapacityStatusCache();
    await runSurgeSweep();
    const rogueActivations = await db
      .select()
      .from(coopSurgeActivationsTable)
      .where(eq(coopSurgeActivationsTable.ruleId, rogue.id));
    expect(rogueActivations).toHaveLength(0);
    await db.delete(coopSurgeRulesTable).where(eq(coopSurgeRulesTable.id, rogue.id));
    await agent
      .patch("/api/coop/capacity")
      .set("x-tenant-id", String(busyId))
      .send({ manualStatus: null })
      .expect(200);
    __clearCapacityStatusCache();
  });

  it("pauses and deletes rules, reverting any live boost", async () => {
    const paused = await agent
      .patch(`/api/coop/surge-rules/${ruleId}`)
      .set("x-tenant-id", String(busyId))
      .send({ isActive: false })
      .expect(200);
    expect(paused.body.isActive).toBe(false);

    await agent
      .delete(`/api/coop/surge-rules/${ruleId}`)
      .set("x-tenant-id", String(busyId))
      .expect(200);
    const list = await agent
      .get("/api/coop/surge-rules")
      .set("x-tenant-id", String(busyId))
      .expect(200);
    expect(list.body.some((r: { id: number }) => r.id === ruleId)).toBe(false);
  });
});
