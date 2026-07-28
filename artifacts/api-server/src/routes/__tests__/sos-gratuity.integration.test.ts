import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  coopEventsTable,
  merchantCoopPartnershipsTable,
  sosGratuityLedgerTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for co-op tip pooling & gratuity splitting: tip capture
// at checkout, split rules (equal / percentage / role_weighted), cross-
// business splits on partnership-linked visits, tenant scoping of ledger
// rows, and that tips never leak into revenue/commission/margin figures.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `gratuity-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantA: number;
let tenantB: number;

const asTenant = (id: number) => ({ "x-tenant-id": String(id) });

async function createStaff(
  tenantId: number,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const res = await agent
    .post("/api/sos/staff")
    .set(asTenant(tenantId))
    .send({ name, compensationType: "commission", commissionPercent: 50, ...extra })
    .expect(201);
  return res.body.id as number;
}

// Walks a fresh visit up to in_service so check_out is a legal transition.
async function visitInService(tenantId: number, serviceType: string): Promise<number> {
  const customer = await agent
    .post("/api/sos/customers")
    .set(asTenant(tenantId))
    .send({ name: `Tipper ${serviceType}` })
    .expect(201);
  const visit = await agent
    .post("/api/sos/visits")
    .set(asTenant(tenantId))
    .send({ customerId: customer.body.id, serviceType })
    .expect(201);
  const resource = await agent
    .post("/api/sos/resources")
    .set(asTenant(tenantId))
    .send({ name: `Chair ${serviceType}`, resourceType: "chair" })
    .expect(201);
  await agent
    .post(`/api/sos/visits/${visit.body.id}/advance`)
    .set(asTenant(tenantId))
    .send({ action: "assign", resourceId: resource.body.id })
    .expect(200);
  await agent
    .post(`/api/sos/visits/${visit.body.id}/advance`)
    .set(asTenant(tenantId))
    .send({ action: "start_service" })
    .expect(200);
  return visit.body.id as number;
}

async function ledgerFor(visitId: number) {
  return db
    .select()
    .from(sosGratuityLedgerTable)
    .where(eq(sosGratuityLedgerTable.visitId, visitId))
    .orderBy(sosGratuityLedgerTable.id);
}

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
      { brandName: `Tips A ${RUN}`, subdomain: `${RUN}-a`, status: "active" },
      { brandName: `Tips B ${RUN}`, subdomain: `${RUN}-b`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  tenantA = tenants[0].id;
  tenantB = tenants[1].id;
});

afterAll(async () => {
  // Cascades clean up settings, staff, visits, ledger, partnerships, events.
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [tenantA, tenantB]));
});

describe("gratuity config management", () => {
  it("defaults to equal split and updates rule + per-staff shares tenant-scoped", async () => {
    const initial = await agent
      .get("/api/sos/gratuity-config")
      .set(asTenant(tenantA))
      .expect(200);
    expect(initial.body.tipSplitRule).toBe("equal");

    const s1 = await createStaff(tenantA, `Cfg1 ${RUN}`);
    const updated = await agent
      .patch("/api/sos/gratuity-config")
      .set(asTenant(tenantA))
      .send({
        tipSplitRule: "percentage",
        staffShares: [{ staffId: s1, tipPercent: 70, tipRoleWeight: 3 }],
      })
      .expect(200);
    expect(updated.body.tipSplitRule).toBe("percentage");
    const share = updated.body.staff.find((s: any) => s.staffId === s1);
    expect(share.tipPercent).toBe(70);
    expect(share.tipRoleWeight).toBe(3);

    // Tenant B's config is untouched, and cannot edit A's staff.
    const bCfg = await agent
      .get("/api/sos/gratuity-config")
      .set(asTenant(tenantB))
      .expect(200);
    expect(bCfg.body.tipSplitRule).toBe("equal");
    await agent
      .patch("/api/sos/gratuity-config")
      .set(asTenant(tenantB))
      .send({ staffShares: [{ staffId: s1, tipPercent: 10 }] })
      .expect(404);

    // Reset A back to equal for later tests.
    await agent
      .patch("/api/sos/gratuity-config")
      .set(asTenant(tenantA))
      .send({ tipSplitRule: "equal" })
      .expect(200);
  });
});

describe("tip capture & split rules at checkout", () => {
  it("splits equally across active staff and writes tenant-scoped ledger rows", async () => {
    const s1 = await createStaff(tenantB, `Eq1 ${RUN}`);
    const s2 = await createStaff(tenantB, `Eq2 ${RUN}`);
    // Inactive staff are excluded from the pool.
    const s3 = await createStaff(tenantB, `Eq3 ${RUN}`);
    await agent
      .patch(`/api/sos/staff/${s3}`)
      .set(asTenant(tenantB))
      .send({ isActive: false })
      .expect(200);

    const visitId = await visitInService(tenantB, `EqCut ${RUN}`);
    const done = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant(tenantB))
      .send({ action: "check_out", paymentAmount: 100, tipAmount: 15, staffId: s1 })
      .expect(200);
    expect(done.body.paymentAmount).toBe(100);
    expect(done.body.tipAmount).toBe(15);

    const rows = await ledgerFor(visitId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.staffId).sort()).toEqual([s1, s2].sort());
    for (const r of rows) {
      expect(r.tenantId).toBe(tenantB);
      expect(r.ruleApplied).toBe("equal");
      expect(parseFloat(r.amount)).toBe(7.5);
    }
  });

  it("splits by percentage with exact-cent totals and per-visit rule override", async () => {
    const s1 = await createStaff(tenantB, `Pct1 ${RUN}`);
    const s2 = await createStaff(tenantB, `Pct2 ${RUN}`);
    await agent
      .patch("/api/sos/gratuity-config")
      .set(asTenant(tenantB))
      .send({
        staffShares: [
          { staffId: s1, tipPercent: 75 },
          { staffId: s2, tipPercent: 25 },
        ],
      })
      .expect(200);
    // Zero out earlier equal-test staff so they're excluded under percentage.
    // (percentage rule: NULL/0 percent = excluded)

    const visitId = await visitInService(tenantB, `PctCut ${RUN}`);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant(tenantB))
      .send({ action: "check_out", paymentAmount: 80, tipAmount: 10.01, tipSplitRule: "percentage" })
      .expect(200);

    const rows = await ledgerFor(visitId);
    expect(rows).toHaveLength(2);
    const byStaff = new Map(rows.map((r) => [r.staffId, parseFloat(r.amount)]));
    // 75/25 of $10.01, exact to the cent and summing to the tip.
    expect(byStaff.get(s1)! + byStaff.get(s2)!).toBeCloseTo(10.01, 2);
    expect(byStaff.get(s1)).toBeCloseTo(7.51, 2);
    expect(byStaff.get(s2)).toBeCloseTo(2.5, 2);
    expect(rows.every((r) => r.ruleApplied === "percentage")).toBe(true);
  });

  it("splits role-weighted using weights (NULL = 1)", async () => {
    const visitId = await visitInService(tenantA, `RwCut ${RUN}`);
    const senior = await createStaff(tenantA, `Sr ${RUN}`);
    const junior = await createStaff(tenantA, `Jr ${RUN}`);
    await agent
      .patch("/api/sos/gratuity-config")
      .set(asTenant(tenantA))
      .send({ tipSplitRule: "role_weighted", staffShares: [{ staffId: senior, tipRoleWeight: 3 }] })
      .expect(200);

    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant(tenantA))
      .send({ action: "check_out", paymentAmount: 60, tipAmount: 12 })
      .expect(200);

    const rows = await ledgerFor(visitId);
    const byStaff = new Map(rows.map((r) => [r.staffId, parseFloat(r.amount)]));
    // Cfg1 (weight 3 from earlier test), senior weight 3, junior default 1 —
    // fetch actual weights from config to compute expected shares robustly.
    const cfg = await agent.get("/api/sos/gratuity-config").set(asTenant(tenantA)).expect(200);
    const weights = new Map<number, number>(
      cfg.body.staff
        .filter((s: any) => s.isActive)
        .map((s: any) => [s.staffId, s.tipRoleWeight ?? 1]),
    );
    const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
    expect(byStaff.get(senior)).toBeCloseTo((12 * 3) / totalWeight, 1);
    expect(byStaff.get(junior)).toBeCloseTo((12 * 1) / totalWeight, 1);
    const sum = [...byStaff.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(12, 2);
    expect(rows.every((r) => r.ruleApplied === "role_weighted")).toBe(true);

    // Reset for other tests.
    await agent
      .patch("/api/sos/gratuity-config")
      .set(asTenant(tenantA))
      .send({ tipSplitRule: "equal" })
      .expect(200);
  });

  it("rejects a tip when there is no active staff to allocate it to", async () => {
    const [t] = await db
      .insert(tenantsTable)
      .values([{ brandName: `Tips C ${RUN}`, subdomain: `${RUN}-c`, status: "active" }])
      .returning({ id: tenantsTable.id });
    try {
      const visitId = await visitInService(t.id, `NoStaff ${RUN}`);
      await agent
        .post(`/api/sos/visits/${visitId}/advance`)
        .set(asTenant(t.id))
        .send({ action: "check_out", paymentAmount: 40, tipAmount: 5 })
        .expect(409);
    } finally {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, t.id));
    }
  });
});

describe("cross-business splits on partnership-linked visits", () => {
  it("allocates across both tenants' staff, each row on its own tenant's ledger", async () => {
    const aStaff = await agent.get("/api/sos/staff").set(asTenant(tenantA)).expect(200);
    const bStaff = await agent.get("/api/sos/staff").set(asTenant(tenantB)).expect(200);
    const activeA = aStaff.body.filter((s: any) => s.isActive).map((s: any) => s.id);
    const activeB = bStaff.body.filter((s: any) => s.isActive).map((s: any) => s.id);

    const [p] = await db
      .insert(merchantCoopPartnershipsTable)
      .values({
        hostTenantId: tenantA,
        partnerTenantId: tenantB,
        perkTitle: `Tip perk ${RUN}`,
        redemptionCode: `TIP-${RUN}`,
        status: "accepted",
        isActive: true,
      })
      .returning();
    // A partner customer crossed over to tenant A (unexpired, unattributed).
    await db.insert(coopEventsTable).values({
      tenantId: tenantA,
      partnershipId: p.id,
      partnerTenantId: tenantB,
      eventType: "crossover",
    });

    const visitId = await visitInService(tenantA, `CoopCut ${RUN}`);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant(tenantA))
      .send({ action: "check_out", paymentAmount: 90, tipAmount: 20 })
      .expect(200);

    const rows = await ledgerFor(visitId);
    expect(rows).toHaveLength(activeA.length + activeB.length);
    for (const r of rows) {
      if (activeA.includes(r.staffId)) expect(r.tenantId).toBe(tenantA);
      else if (activeB.includes(r.staffId)) expect(r.tenantId).toBe(tenantB);
      else throw new Error(`unexpected staff ${r.staffId} in cross-business split`);
    }
    const sum = rows.reduce((n, r) => n + parseFloat(r.amount), 0);
    expect(sum).toBeCloseTo(20, 2);

    // Each tenant's ledger endpoint sees only its own rows.
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const ledgerA = await agent
      .get(`/api/sos/gratuity-ledger?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set(asTenant(tenantA))
      .expect(200);
    const ledgerB = await agent
      .get(`/api/sos/gratuity-ledger?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set(asTenant(tenantB))
      .expect(200);
    const aVisitRows = ledgerA.body.entries.filter((e: any) => e.visitId === visitId);
    const bVisitRows = ledgerB.body.entries.filter((e: any) => e.visitId === visitId);
    expect(aVisitRows.length).toBe(activeA.length);
    expect(bVisitRows.length).toBe(activeB.length);
    expect(aVisitRows.every((e: any) => activeA.includes(e.staffId))).toBe(true);
    expect(bVisitRows.every((e: any) => activeB.includes(e.staffId))).toBe(true);
    expect(ledgerB.body.totalDistributed).toBeGreaterThan(0);
  });
});

describe("tips stay out of revenue, commissions, and margins", () => {
  it("keeps tips separate in earnings, reports, and revenue figures", async () => {
    const [t] = await db
      .insert(tenantsTable)
      .values([{ brandName: `Tips D ${RUN}`, subdomain: `${RUN}-d`, status: "active" }])
      .returning({ id: tenantsTable.id });
    try {
      const staffId = await createStaff(t.id, `Solo ${RUN}`);
      const visitId = await visitInService(t.id, `SoloCut ${RUN}`);
      await agent
        .post(`/api/sos/visits/${visitId}/advance`)
        .set(asTenant(t.id))
        .send({ action: "check_out", paymentAmount: 100, tipAmount: 25, staffId })
        .expect(200);

      const from = new Date(Date.now() - 3600_000).toISOString();
      const to = new Date(Date.now() + 3600_000).toISOString();
      const earnings = await agent
        .get(`/api/sos/staff-earnings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
        .set(asTenant(t.id))
        .expect(200);
      const row = earnings.body.find((r: any) => r.staffId === staffId);
      // Commission base is the $100 service amount only — tip excluded.
      expect(row.attributedRevenue).toBe(100);
      expect(row.commissionEarned).toBe(50);
      // Tips itemized on their own line.
      expect(row.tipsEarned).toBe(25);

      const summary = await agent
        .get("/api/sos/reports/summary")
        .set(asTenant(t.id))
        .expect(200);
      // Revenue reflects only the service amount; tips reported separately.
      expect(summary.body.totalRevenue).toBe(100);
      expect(summary.body.tips.collected).toBe(25);
      expect(summary.body.tips.distributed).toBe(25);
      expect(summary.body.tips.byStaff).toEqual([
        expect.objectContaining({ staffId, total: 25 }),
      ]);
    } finally {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, t.id));
    }
  });

  it("checkout without a tip writes no ledger rows", async () => {
    const visitId = await visitInService(tenantB, `NoTip ${RUN}`);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant(tenantB))
      .send({ action: "check_out", paymentAmount: 30 })
      .expect(200);
    expect(await ledgerFor(visitId)).toHaveLength(0);
  });
});
