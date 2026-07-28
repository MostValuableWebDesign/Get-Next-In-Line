import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopRetailItemsTable,
  coopRetailStockMovementsTable,
  coopRetailLedgerEntriesTable,
  messagesTable,
  sosSettingsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Shelf-Space Inventory Tracker (/coop/retail/*), against the real dev
// DB. Covers: item lifecycle (create/edit/deactivate), partnership-party
// access control & tenant scoping, sale attribution + ledger math on both
// sides, stock concurrency (oversell guard), auditable movements, and the
// once-per-episode low-stock alert (reset by restock above threshold).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `retail-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let hostId: number; // barbershop hosting the boutique's products
let ownerId: number; // boutique whose products sit on the host's shelf
let strangerId: number; // unrelated tenant — must never see the items
let partnershipId: number;
let pendingPartnershipId: number;

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
      { brandName: `Retail Host ${RUN}`, subdomain: `${RUN}-host`, status: "active" },
      { brandName: `Retail Owner ${RUN}`, subdomain: `${RUN}-owner`, status: "active" },
      { brandName: `Retail Stranger ${RUN}`, subdomain: `${RUN}-stranger`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, ownerId, strangerId] = tenants.map((t) => t.id);

  // Phones so low-stock alerts have recipients on both sides.
  await db.insert(sosSettingsTable).values([
    { tenantId: hostId, businessName: `Retail Host ${RUN}`, publicPhone: "+15550000001" },
    { tenantId: ownerId, businessName: `Retail Owner ${RUN}`, publicPhone: "+15550000002" },
  ]);

  const partnerships = await db
    .insert(merchantCoopPartnershipsTable)
    .values([
      {
        hostTenantId: hostId,
        partnerTenantId: ownerId,
        perkTitle: `Retail pact ${RUN}`,
        redemptionCode: `RET-${RUN}-A`,
        status: "accepted",
        isActive: true,
      },
      {
        hostTenantId: hostId,
        partnerTenantId: strangerId,
        perkTitle: `Pending pact ${RUN}`,
        redemptionCode: `RET-${RUN}-B`,
        status: "pending",
        isActive: false,
      },
    ])
    .returning({ id: merchantCoopPartnershipsTable.id });
  partnershipId = partnerships[0].id;
  pendingPartnershipId = partnerships[1].id;
});

afterAll(async () => {
  const tenantIds = [hostId, ownerId, strangerId].filter((n) => Number.isInteger(n));
  if (tenantIds.length) {
    await db.delete(messagesTable).where(inArray(messagesTable.tenantId, tenantIds));
    // Cascades clean up partnerships, items, movements, and ledger entries.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  }
});

async function createItem(overrides: Record<string, unknown> = {}) {
  const res = await agent
    .post("/api/coop/retail/items")
    .set("x-tenant-id", String(hostId))
    .send({
      partnershipId,
      name: `Beard Oil ${RUN}-${Math.random().toString(36).slice(2, 8)}`,
      quantityOnShelf: 10,
      unitPrice: 20,
      ownerSharePercent: 60,
      lowStockThreshold: 2,
      ...overrides,
    })
    .expect(201);
  return res.body;
}

describe("co-op retail item lifecycle & access control", () => {
  it("requires tenant scope on every retail route", async () => {
    await agent.get("/api/coop/retail/items").expect(400);
    await agent.post("/api/coop/retail/items").send({}).expect(400);
    await agent.get("/api/coop/retail/ledger").expect(400);
  });

  it("host creates an item; both parties see it, a stranger never does", async () => {
    const item = await createItem();
    expect(item.hostTenantId).toBe(hostId);
    expect(item.ownerTenantId).toBe(ownerId);
    expect(item.lowStock).toBe(false);

    const hostView = await agent
      .get("/api/coop/retail/items")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(hostView.body.hosted.some((i: any) => i.id === item.id)).toBe(true);

    const ownerView = await agent
      .get("/api/coop/retail/items")
      .set("x-tenant-id", String(ownerId))
      .expect(200);
    expect(ownerView.body.placed.some((i: any) => i.id === item.id)).toBe(true);
    expect(ownerView.body.hosted.some((i: any) => i.id === item.id)).toBe(false);

    const strangerView = await agent
      .get("/api/coop/retail/items")
      .set("x-tenant-id", String(strangerId))
      .expect(200);
    expect(strangerView.body.hosted).toHaveLength(0);
    expect(strangerView.body.placed).toHaveLength(0);
  });

  it("rejects items on partnerships the tenant isn't part of, or not accepted", async () => {
    // Stranger is not a party of the accepted partnership.
    await agent
      .post("/api/coop/retail/items")
      .set("x-tenant-id", String(strangerId))
      .send({ partnershipId, name: "Nope", quantityOnShelf: 1, unitPrice: 5, ownerSharePercent: 50 })
      .expect(403);
    // Pending partnership can't carry items.
    await agent
      .post("/api/coop/retail/items")
      .set("x-tenant-id", String(hostId))
      .send({
        partnershipId: pendingPartnershipId,
        name: "Nope",
        quantityOnShelf: 1,
        unitPrice: 5,
        ownerSharePercent: 50,
      })
      .expect(409);
  });

  it("only the host can edit or deactivate; owner and stranger get 404", async () => {
    const item = await createItem();
    for (const tid of [ownerId, strangerId]) {
      await agent
        .patch(`/api/coop/retail/items/${item.id}`)
        .set("x-tenant-id", String(tid))
        .send({ unitPrice: 99 })
        .expect(404);
    }
    const updated = await agent
      .patch(`/api/coop/retail/items/${item.id}`)
      .set("x-tenant-id", String(hostId))
      .send({ unitPrice: 25, lowStockThreshold: 4, isActive: false })
      .expect(200);
    expect(updated.body.unitPrice).toBe(25);
    expect(updated.body.isActive).toBe(false);

    // Deactivated items can't sell.
    await agent
      .post(`/api/coop/retail/items/${item.id}/sale`)
      .set("x-tenant-id", String(hostId))
      .send({ quantity: 1 })
      .expect(409);
  });
});

describe("sale recording, attribution & ledger math", () => {
  it("decrements stock, writes the movement, and creates matching ledger rows", async () => {
    const item = await createItem({ quantityOnShelf: 10, unitPrice: 20, ownerSharePercent: 60 });
    const res = await agent
      .post(`/api/coop/retail/items/${item.id}/sale`)
      .set("x-tenant-id", String(hostId))
      .send({ quantity: 3 })
      .expect(201);
    expect(res.body.item.quantityOnShelf).toBe(7);
    expect(res.body.grossAmount).toBe(60);
    expect(res.body.ownerShareAmount).toBe(36);
    expect(res.body.hostShareAmount).toBe(24);

    const ledger = await db
      .select()
      .from(coopRetailLedgerEntriesTable)
      .where(eq(coopRetailLedgerEntriesTable.itemId, item.id));
    expect(ledger).toHaveLength(2);
    const hostRow = ledger.find((l) => l.tenantId === hostId)!;
    const ownerRow = ledger.find((l) => l.tenantId === ownerId)!;
    expect(hostRow.role).toBe("host");
    expect(hostRow.shareAmount).toBe("24.00");
    expect(ownerRow.role).toBe("owner");
    expect(ownerRow.shareAmount).toBe("36.00");
    expect(hostRow.grossAmount).toBe("60.00");
    // Shares always sum to gross.
    expect(parseFloat(hostRow.shareAmount) + parseFloat(ownerRow.shareAmount)).toBe(60);

    const movements = await db
      .select()
      .from(coopRetailStockMovementsTable)
      .where(eq(coopRetailStockMovementsTable.itemId, item.id));
    expect(movements.map((m) => m.movementType).sort()).toEqual(["restock", "sale"]);
    expect(movements.find((m) => m.movementType === "sale")!.quantityDelta).toBe(-3);
  });

  it("ledger view shows per-partner totals with each side's own share", async () => {
    const hostLedger = await agent
      .get("/api/coop/retail/ledger")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    const hostRow = hostLedger.body.partners.find((p: any) => p.partnerTenantId === ownerId);
    expect(hostRow).toBeTruthy();
    expect(hostRow.grossRevenue).toBeGreaterThanOrEqual(60);
    expect(hostRow.myShare).toBeLessThan(hostRow.grossRevenue);

    const ownerLedger = await agent
      .get("/api/coop/retail/ledger")
      .set("x-tenant-id", String(ownerId))
      .expect(200);
    const ownerRow = ownerLedger.body.partners.find((p: any) => p.partnerTenantId === hostId);
    expect(ownerRow).toBeTruthy();
    expect(ownerRow.unitsSold).toBe(hostRow.unitsSold);
    expect(ownerRow.grossRevenue).toBe(hostRow.grossRevenue);

    const strangerLedger = await agent
      .get("/api/coop/retail/ledger")
      .set("x-tenant-id", String(strangerId))
      .expect(200);
    expect(strangerLedger.body.partners).toHaveLength(0);
    expect(strangerLedger.body.entries).toHaveLength(0);
  });

  it("oversell is rejected and concurrent sales never take stock negative", async () => {
    const item = await createItem({ quantityOnShelf: 5, lowStockThreshold: 0 });
    await agent
      .post(`/api/coop/retail/items/${item.id}/sale`)
      .set("x-tenant-id", String(hostId))
      .send({ quantity: 6 })
      .expect(409);

    // Five concurrent 2-unit sales against 5 in stock: exactly two can win.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        agent
          .post(`/api/coop/retail/items/${item.id}/sale`)
          .set("x-tenant-id", String(hostId))
          .send({ quantity: 2 })
      )
    );
    const wins = results.filter((r) => r.status === 201).length;
    expect(wins).toBe(2);
    const [row] = await db
      .select()
      .from(coopRetailItemsTable)
      .where(eq(coopRetailItemsTable.id, item.id));
    expect(row.quantityOnShelf).toBe(1);
  });

  it("rolls the whole sale back when a write fails mid-sequence", async () => {
    // gross = unitPrice × qty overflows the ledger's numeric(12,2) column, so
    // the ledger insert fails AFTER the stock decrement inside the same
    // transaction — everything must roll back: stock unchanged, no sale
    // movement, no ledger rows.
    const item = await createItem({
      quantityOnShelf: 500,
      unitPrice: 99999999.99,
      lowStockThreshold: 0,
    });
    const res = await agent
      .post(`/api/coop/retail/items/${item.id}/sale`)
      .set("x-tenant-id", String(hostId))
      .send({ quantity: 500 });
    expect(res.status).toBeGreaterThanOrEqual(500);

    const [row] = await db
      .select()
      .from(coopRetailItemsTable)
      .where(eq(coopRetailItemsTable.id, item.id));
    expect(row.quantityOnShelf).toBe(500);
    const saleMovements = await db
      .select()
      .from(coopRetailStockMovementsTable)
      .where(
        and(
          eq(coopRetailStockMovementsTable.itemId, item.id),
          eq(coopRetailStockMovementsTable.movementType, "sale")
        )
      );
    expect(saleMovements).toHaveLength(0);
    const ledger = await db
      .select()
      .from(coopRetailLedgerEntriesTable)
      .where(eq(coopRetailLedgerEntriesTable.itemId, item.id));
    expect(ledger).toHaveLength(0);
  });

  it("only the host can record sales; owner/stranger get 404", async () => {
    const item = await createItem();
    for (const tid of [ownerId, strangerId]) {
      await agent
        .post(`/api/coop/retail/items/${item.id}/sale`)
        .set("x-tenant-id", String(tid))
        .send({ quantity: 1 })
        .expect(404);
    }
  });
});

describe("stock adjustments & low-stock alerting", () => {
  async function alertCount(itemId: number) {
    const rows = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.kind, "retail_low_stock"),
          inArray(messagesTable.tenantId, [hostId, ownerId])
        )
      );
    return rows.filter((r) => (r.payload as any)?.itemId === itemId).length;
  }

  it("adjustments are audited and can't take stock below zero", async () => {
    const item = await createItem({ quantityOnShelf: 4, lowStockThreshold: 0 });
    await agent
      .post(`/api/coop/retail/items/${item.id}/adjust`)
      .set("x-tenant-id", String(hostId))
      .send({ quantityDelta: -5, reason: "shrinkage" })
      .expect(409);
    const ok = await agent
      .post(`/api/coop/retail/items/${item.id}/adjust`)
      .set("x-tenant-id", String(hostId))
      .send({ quantityDelta: -1, reason: "shrinkage", note: "damaged tester" })
      .expect(200);
    expect(ok.body.quantityOnShelf).toBe(3);
    const movements = await db
      .select()
      .from(coopRetailStockMovementsTable)
      .where(
        and(
          eq(coopRetailStockMovementsTable.itemId, item.id),
          eq(coopRetailStockMovementsTable.movementType, "adjustment")
        )
      );
    expect(movements).toHaveLength(1);
    expect(movements[0].note).toBe("damaged tester");
  });

  it("alerts both parties once per episode; restock above threshold re-arms", async () => {
    const item = await createItem({ quantityOnShelf: 4, lowStockThreshold: 2 });

    // 4 → 3: still above threshold, no alert.
    await agent
      .post(`/api/coop/retail/items/${item.id}/sale`)
      .set("x-tenant-id", String(hostId))
      .send({ quantity: 1 })
      .expect(201);
    expect(await alertCount(item.id)).toBe(0);

    // 3 → 2: hits threshold — one alert to each business.
    const hit = await agent
      .post(`/api/coop/retail/items/${item.id}/sale`)
      .set("x-tenant-id", String(hostId))
      .send({ quantity: 1 })
      .expect(201);
    expect(hit.body.lowStockAlertSent).toBe(true);
    expect(await alertCount(item.id)).toBe(2);

    // 2 → 1: same episode — no additional alert.
    const again = await agent
      .post(`/api/coop/retail/items/${item.id}/sale`)
      .set("x-tenant-id", String(hostId))
      .send({ quantity: 1 })
      .expect(201);
    expect(again.body.lowStockAlertSent).toBe(false);
    expect(await alertCount(item.id)).toBe(2);

    // Restock above threshold closes the episode…
    await agent
      .post(`/api/coop/retail/items/${item.id}/adjust`)
      .set("x-tenant-id", String(hostId))
      .send({ quantityDelta: 9, reason: "restock" })
      .expect(200);
    // …so the next dip alerts again (via a negative adjustment this time).
    await agent
      .post(`/api/coop/retail/items/${item.id}/adjust`)
      .set("x-tenant-id", String(hostId))
      .send({ quantityDelta: -8, reason: "shrinkage" })
      .expect(200);
    expect(await alertCount(item.id)).toBe(4);
  });
});
