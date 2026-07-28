import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  procurementVendorsTable,
  procurementGroupBuysTable,
  procurementGroupBuyParticipantsTable,
  procurementLedgerEntriesTable,
  procurementSupplyItemsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { sweepSupplyReorders, tierFor, nextTierFor } from "../../lib/procurement";

// ---------------------------------------------------------------------------
// Co-Op Supplier & Procurement Marketplace against the real dev DB. Covers:
// admin-only vendor mutations, verified-only merchant vendor visibility,
// group-buy lifecycle (open → join/adjust → close), live tier progress,
// proportional cost-split ledger math and immutability semantics, tenant
// scoping of ledgers/supplies, network-membership gating, and low-stock
// threshold triggering (reminders + auto group-buy replenishment sweep).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `procure-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let barberId: number; // organizer, in network
let salonId: number; // participant, in network
let loneId: number; // NOT in the co-op network
let vendorId: number;
let unverifiedVendorId: number;
let itemId: number; // bulk-tiered item: base 5.00, 20+ → 4.00, 50+ → 3.00
let plainItemId: number; // no tiers, base 2.50

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
      { brandName: `Barber ${RUN}`, subdomain: `${RUN}-barber`, status: "active" },
      { brandName: `Salon ${RUN}`, subdomain: `${RUN}-salon`, status: "active" },
      { brandName: `Lone ${RUN}`, subdomain: `${RUN}-lone`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [barberId, salonId, loneId] = tenants.map((t) => t.id);

  // barber↔salon are co-op partners; lone has no accepted partnership.
  await db.insert(merchantCoopPartnershipsTable).values({
    hostTenantId: barberId,
    partnerTenantId: salonId,
    perkTitle: `Trim perk ${RUN}`,
    redemptionCode: `PROC-${RUN}`,
    status: "accepted",
    isActive: true,
  });

  // Vendors + items through the admin API (also exercises admin CRUD).
  const vendorRes = await agent
    .post("/api/admin/procurement/vendors")
    .send({ name: `Clean Supply Co ${RUN}`, category: "sanitation", region: "Northside", isVerified: true })
    .expect(201);
  vendorId = vendorRes.body.id;

  const unverifiedRes = await agent
    .post("/api/admin/procurement/vendors")
    .send({ name: `Shadow Vendor ${RUN}`, category: "packaging", region: "Northside" })
    .expect(201);
  unverifiedVendorId = unverifiedRes.body.id;
  expect(unverifiedRes.body.isVerified).toBe(false);

  const itemRes = await agent
    .post(`/api/admin/procurement/vendors/${vendorId}/items`)
    .send({
      name: `Barbicide gallon ${RUN}`,
      unit: "gallon",
      basePrice: 5,
      bulkTiers: [
        { minQty: 50, unitPrice: 3 },
        { minQty: 20, unitPrice: 4 },
      ],
    })
    .expect(201);
  itemId = itemRes.body.id;
  // Tiers come back normalized ascending.
  expect(itemRes.body.bulkTiers.map((t: { minQty: number }) => t.minQty)).toEqual([20, 50]);

  const plainRes = await agent
    .post(`/api/admin/procurement/vendors/${vendorId}/items`)
    .send({ name: `Neck strips ${RUN}`, unit: "box", basePrice: 2.5 })
    .expect(201);
  plainItemId = plainRes.body.id;
});

afterAll(async () => {
  const tenantIds = [barberId, salonId, loneId].filter((n) => Number.isInteger(n));
  if (tenantIds.length) await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  const vendorIds = [vendorId, unverifiedVendorId].filter((n) => Number.isInteger(n));
  if (vendorIds.length)
    await db.delete(procurementVendorsTable).where(inArray(procurementVendorsTable.id, vendorIds));
});

describe("tier math", () => {
  const tiers = [
    { minQty: 20, unitPrice: 4 },
    { minQty: 50, unitPrice: 3 },
  ];
  it("achieved tier is the highest reached; next tier is the cheapest unreached", () => {
    expect(tierFor(tiers, 10)).toBeNull();
    expect(tierFor(tiers, 20)?.unitPrice).toBe(4);
    expect(tierFor(tiers, 49)?.unitPrice).toBe(4);
    expect(tierFor(tiers, 50)?.unitPrice).toBe(3);
    expect(nextTierFor(tiers, 10)?.minQty).toBe(20);
    expect(nextTierFor(tiers, 20)?.minQty).toBe(50);
    expect(nextTierFor(tiers, 99)).toBeNull();
  });
});

describe("vendor directory visibility & admin-only mutations", () => {
  it("merchants see only verified vendors; admins see all", async () => {
    const merchant = await agent
      .get("/api/coop/procurement/vendors")
      .set("x-tenant-id", String(barberId))
      .expect(200);
    const names = merchant.body.map((v: { id: number }) => v.id);
    expect(names).toContain(vendorId);
    expect(names).not.toContain(unverifiedVendorId);

    const admin = await agent.get("/api/admin/procurement/vendors").expect(200);
    const adminIds = admin.body.map((v: { id: number }) => v.id);
    expect(adminIds).toContain(vendorId);
    expect(adminIds).toContain(unverifiedVendorId);
  });

  it("rejects unauthenticated vendor mutations (admin console only)", async () => {
    const app = (await import("../../app")).default;
    await request(app)
      .post("/api/admin/procurement/vendors")
      .send({ name: `Sneaky ${RUN}`, category: "x", region: "y" })
      .expect(401);
  });

  it("rejects malformed bulk tiers (non-decreasing prices)", async () => {
    await agent
      .post(`/api/admin/procurement/vendors/${vendorId}/items`)
      .send({
        name: `Bad tiers ${RUN}`,
        unit: "each",
        basePrice: 1,
        bulkTiers: [{ minQty: 10, unitPrice: 2 }],
      })
      .expect(400);
  });
});

describe("group-buy lifecycle and cost-split ledger", () => {
  let groupBuyId: number;

  it("organizer opens a pool; live tier progress updates as others join", async () => {
    const open = await agent
      .post("/api/coop/procurement/group-buys")
      .set("x-tenant-id", String(barberId))
      .send({ vendorItemId: itemId, quantity: 12 })
      .expect(201);
    groupBuyId = open.body.id;
    expect(open.body.status).toBe("open");
    expect(open.body.totalQuantity).toBe(12);
    expect(open.body.currentTier).toBeNull();
    expect(open.body.currentUnitPrice).toBe(5);
    expect(open.body.nextTier?.minQty).toBe(20);
    expect(open.body.myQuantity).toBe(12);

    const join = await agent
      .post(`/api/coop/procurement/group-buys/${groupBuyId}/join`)
      .set("x-tenant-id", String(salonId))
      .send({ quantity: 10 })
      .expect(200);
    expect(join.body.totalQuantity).toBe(22);
    expect(join.body.currentTier?.minQty).toBe(20);
    expect(join.body.currentUnitPrice).toBe(4);
    expect(join.body.nextTier?.minQty).toBe(50);
    expect(join.body.participants).toHaveLength(2);
  });

  it("re-joining SETS the participant's quantity (idempotent adjust)", async () => {
    const adjust = await agent
      .post(`/api/coop/procurement/group-buys/${groupBuyId}/join`)
      .set("x-tenant-id", String(salonId))
      .send({ quantity: 8 })
      .expect(200);
    expect(adjust.body.totalQuantity).toBe(20);
    expect(adjust.body.myQuantity).toBe(8);
  });

  it("rejects non-network tenants from opening or joining", async () => {
    await agent
      .post("/api/coop/procurement/group-buys")
      .set("x-tenant-id", String(loneId))
      .send({ vendorItemId: itemId, quantity: 5 })
      .expect(403);
    await agent
      .post(`/api/coop/procurement/group-buys/${groupBuyId}/join`)
      .set("x-tenant-id", String(loneId))
      .send({ quantity: 5 })
      .expect(403);
  });

  it("rejects group buys on unverified vendors' items", async () => {
    const shadowItem = await agent
      .post(`/api/admin/procurement/vendors/${unverifiedVendorId}/items`)
      .send({ name: `Shadow boxes ${RUN}`, unit: "box", basePrice: 1 })
      .expect(201);
    await agent
      .post("/api/coop/procurement/group-buys")
      .set("x-tenant-id", String(barberId))
      .send({ vendorItemId: shadowItem.body.id, quantity: 3 })
      .expect(404);
  });

  it("only the organizer can close; close freezes the achieved tier", async () => {
    await agent
      .post(`/api/coop/procurement/group-buys/${groupBuyId}/close`)
      .set("x-tenant-id", String(salonId))
      .expect(403);

    const closed = await agent
      .post(`/api/coop/procurement/group-buys/${groupBuyId}/close`)
      .set("x-tenant-id", String(barberId))
      .expect(200);
    expect(closed.body.status).toBe("closed");
    // 12 + 8 = 20 pooled → 20+ tier at $4.
    expect(closed.body.achievedTierMinQty).toBe(20);
    expect(closed.body.achievedUnitPrice).toBe(4);

    // Close is once-only; joining after close is rejected.
    await agent
      .post(`/api/coop/procurement/group-buys/${groupBuyId}/close`)
      .set("x-tenant-id", String(barberId))
      .expect(409);
    await agent
      .post(`/api/coop/procurement/group-buys/${groupBuyId}/join`)
      .set("x-tenant-id", String(salonId))
      .send({ quantity: 3 })
      .expect(409);
  });

  it("ledger splits cost proportionally and records savings vs solo pricing", async () => {
    // Organizer sees every line.
    const organizer = await agent
      .get(`/api/coop/procurement/group-buys/${groupBuyId}/ledger`)
      .set("x-tenant-id", String(barberId))
      .expect(200);
    expect(organizer.body.entries).toHaveLength(2);
    const barberLine = organizer.body.entries.find(
      (e: { tenantId: number }) => e.tenantId === barberId
    );
    const salonLine = organizer.body.entries.find(
      (e: { tenantId: number }) => e.tenantId === salonId
    );
    // barber: 12 × $4 = $48, saved 12 × $1 = $12; salon: 8 × $4 = $32, saved $8.
    expect(barberLine.shareAmount).toBe(48);
    expect(barberLine.savingsAmount).toBe(12);
    expect(salonLine.shareAmount).toBe(32);
    expect(salonLine.savingsAmount).toBe(8);
    expect(organizer.body.totals).toEqual({ quantity: 20, amount: 80, savings: 20 });

    // Participants see only their own line; strangers are rejected.
    const salonView = await agent
      .get(`/api/coop/procurement/group-buys/${groupBuyId}/ledger`)
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(salonView.body.entries).toHaveLength(1);
    expect(salonView.body.entries[0].tenantId).toBe(salonId);
    await agent
      .get(`/api/coop/procurement/group-buys/${groupBuyId}/ledger`)
      .set("x-tenant-id", String(loneId))
      .expect(403);

    // Tenant-wide ledger is scoped to the caller.
    const myLedger = await agent
      .get("/api/coop/procurement/ledger")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    const mine = myLedger.body.filter((e: { groupBuyId: number }) => e.groupBuyId === groupBuyId);
    expect(mine).toHaveLength(1);
    expect(mine[0].savingsAmount).toBe(8);
  });

  it("admin overview aggregates cumulative network savings", async () => {
    const overview = await agent.get("/api/admin/procurement/overview").expect(200);
    expect(overview.body.totalSavings).toBeGreaterThanOrEqual(20);
    const perTenant = overview.body.savingsByTenant.find(
      (t: { tenantId: number }) => t.tenantId === barberId
    );
    expect(perTenant?.savings).toBe(12);
  });
});

describe("supply inventory, thresholds, and replenishment", () => {
  it("tracks supplies with tenant scoping and low-stock flags", async () => {
    const created = await agent
      .post("/api/coop/procurement/supplies")
      .set("x-tenant-id", String(barberId))
      .send({ name: `Disinfectant ${RUN}`, unit: "gallon", onHandQty: 2, lowStockThreshold: 5, vendorItemId: itemId })
      .expect(201);
    expect(created.body.belowThreshold).toBe(true);

    // Other tenants can't see or edit it.
    const salonList = await agent
      .get("/api/coop/procurement/supplies")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(salonList.body.map((s: { id: number }) => s.id)).not.toContain(created.body.id);
    await agent
      .patch(`/api/coop/procurement/supplies/${created.body.id}`)
      .set("x-tenant-id", String(salonId))
      .send({ onHandQty: 99 })
      .expect(404);

    // Restocking clears the below-threshold flag.
    const restocked = await agent
      .patch(`/api/coop/procurement/supplies/${created.body.id}`)
      .set("x-tenant-id", String(barberId))
      .send({ onHandQty: 9 })
      .expect(200);
    expect(restocked.body.belowThreshold).toBe(false);
    expect(restocked.body.lastReorderRemindedAt).toBeNull();
  });

  it("one-click replenish opens a group buy, then others join the same pool", async () => {
    const supply = await agent
      .post("/api/coop/procurement/supplies")
      .set("x-tenant-id", String(barberId))
      .send({ name: `Strips ${RUN}`, unit: "box", onHandQty: 1, lowStockThreshold: 4, vendorItemId: plainItemId })
      .expect(201);

    const first = await agent
      .post(`/api/coop/procurement/supplies/${supply.body.id}/replenish`)
      .set("x-tenant-id", String(barberId))
      .send({})
      .expect(200);
    expect(first.body.action).toBe("created");
    // Default quantity = threshold shortfall (4 − 1 = 3).
    expect(first.body.groupBuy.myQuantity).toBe(3);

    const salonSupply = await agent
      .post("/api/coop/procurement/supplies")
      .set("x-tenant-id", String(salonId))
      .send({ name: `Strips too ${RUN}`, unit: "box", onHandQty: 0, lowStockThreshold: 2, vendorItemId: plainItemId })
      .expect(201);
    const second = await agent
      .post(`/api/coop/procurement/supplies/${salonSupply.body.id}/replenish`)
      .set("x-tenant-id", String(salonId))
      .send({ quantity: 5 })
      .expect(200);
    expect(second.body.action).toBe("joined");
    expect(second.body.groupBuy.id).toBe(first.body.groupBuy.id);
    expect(second.body.groupBuy.totalQuantity).toBe(8);

    // Clean up the open pool so it doesn't linger for other tests.
    await agent
      .post(`/api/coop/procurement/group-buys/${first.body.groupBuy.id}/close`)
      .set("x-tenant-id", String(barberId))
      .expect(200);
  });

  it("sweep reminds below-threshold items and auto-joins group buys when opted in", async () => {
    const auto = await agent
      .post("/api/coop/procurement/supplies")
      .set("x-tenant-id", String(barberId))
      .send({
        name: `Auto towels ${RUN}`,
        unit: "pack",
        onHandQty: 1,
        lowStockThreshold: 6,
        vendorItemId: itemId,
        autoRequestEnabled: true,
      })
      .expect(201);
    const manual = await agent
      .post("/api/coop/procurement/supplies")
      .set("x-tenant-id", String(salonId))
      .send({ name: `Manual caps ${RUN}`, unit: "bag", onHandQty: 0, lowStockThreshold: 3 })
      .expect(201);

    await sweepSupplyReorders();

    const [autoRow] = await db
      .select()
      .from(procurementSupplyItemsTable)
      .where(eq(procurementSupplyItemsTable.id, auto.body.id));
    const [manualRow] = await db
      .select()
      .from(procurementSupplyItemsTable)
      .where(eq(procurementSupplyItemsTable.id, manual.body.id));
    expect(autoRow.lastReorderRemindedAt).not.toBeNull();
    expect(manualRow.lastReorderRemindedAt).not.toBeNull();

    // Auto-request pooled the shortfall (6 − 1 = 5) into an open group buy.
    const pools = await db
      .select({
        gb: procurementGroupBuysTable,
        qty: procurementGroupBuyParticipantsTable.quantity,
      })
      .from(procurementGroupBuysTable)
      .innerJoin(
        procurementGroupBuyParticipantsTable,
        eq(procurementGroupBuyParticipantsTable.groupBuyId, procurementGroupBuysTable.id)
      )
      .where(eq(procurementGroupBuyParticipantsTable.tenantId, barberId));
    const autoPool = pools.find(
      (p) => p.gb.status === "open" && p.gb.vendorItemId === itemId
    );
    expect(autoPool?.qty).toBe(5);

    // Cooldown: a second sweep doesn't double-order.
    await sweepSupplyReorders();
    const again = await db
      .select({ qty: procurementGroupBuyParticipantsTable.quantity })
      .from(procurementGroupBuyParticipantsTable)
      .where(eq(procurementGroupBuyParticipantsTable.groupBuyId, autoPool!.gb.id));
    expect(again.reduce((s, r) => s + r.qty, 0)).toBe(5);

    // Clean up the auto-created open pool.
    await agent
      .post(`/api/coop/procurement/group-buys/${autoPool!.gb.id}/close`)
      .set("x-tenant-id", String(barberId))
      .expect(200);
  });

  it("close is atomic: a ledger write failure rolls back and the pool stays open", async () => {
    // High-price item so an out-of-band huge quantity overflows numeric(12,2).
    const pricey = await agent
      .post(`/api/admin/procurement/vendors/${vendorId}/items`)
      .send({ name: `Pricey chair ${RUN}`, unit: "each", basePrice: 99999 })
      .expect(201);
    const open = await agent
      .post("/api/coop/procurement/group-buys")
      .set("x-tenant-id", String(barberId))
      .send({ vendorItemId: pricey.body.id, quantity: 2 })
      .expect(201);
    const gbId = open.body.id;

    // Force a numeric overflow inside the close transaction: an out-of-band
    // participant quantity so large that shareAmount exceeds numeric(12,2).
    // (API inputs are capped at 10000, so this can only happen via direct DB
    // tampering — exactly the failure class the transaction must contain.)
    await db
      .update(procurementGroupBuyParticipantsTable)
      .set({ quantity: 2_000_000_000 })
      .where(eq(procurementGroupBuyParticipantsTable.groupBuyId, gbId));

    await agent
      .post(`/api/coop/procurement/group-buys/${gbId}/close`)
      .set("x-tenant-id", String(barberId))
      .expect(500);

    // The claim rolled back with the ledger: still open, no ledger rows.
    const [row] = await db
      .select()
      .from(procurementGroupBuysTable)
      .where(eq(procurementGroupBuysTable.id, gbId));
    expect(row.status).toBe("open");
    expect(row.closedAt).toBeNull();
    const ledger = await db
      .select()
      .from(procurementLedgerEntriesTable)
      .where(eq(procurementLedgerEntriesTable.groupBuyId, gbId));
    expect(ledger).toHaveLength(0);

    // Retry succeeds once the data is sane again.
    await db
      .update(procurementGroupBuyParticipantsTable)
      .set({ quantity: 2 })
      .where(eq(procurementGroupBuyParticipantsTable.groupBuyId, gbId));
    const closed = await agent
      .post(`/api/coop/procurement/group-buys/${gbId}/close`)
      .set("x-tenant-id", String(barberId))
      .expect(200);
    expect(closed.body.status).toBe("closed");
  });

  it("rejects quantities beyond the ledger-safe cap", async () => {
    await agent
      .post("/api/coop/procurement/group-buys")
      .set("x-tenant-id", String(barberId))
      .send({ vendorItemId: plainItemId, quantity: 10001 })
      .expect(400);
  });

  it("requires the x-tenant-id header on merchant endpoints", async () => {
    await agent.get("/api/coop/procurement/vendors").expect(400);
    await agent.get("/api/coop/procurement/supplies").expect(400);
    await agent.get("/api/coop/procurement/group-buys").expect(400);
  });
});
