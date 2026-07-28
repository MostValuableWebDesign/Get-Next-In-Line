import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  sosTipPoolLedgerTable,
  sosGratuityLedgerTable,
  sosPlanTransactionsTable,
  sosCustomerPlansTable,
  sosCustomersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Automated Tip-Pooling & Gratuity Splitter — integration tests.
// Split methods (percentage / equal / role-weighted), deterministic rounding
// (remainder to servicing staff), no-rule fallback, partnership gating
// (pending/declined/inactive partnerships never split), and ledger
// itemization separate from commission in staff earnings.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `tippool-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let barberId: number; // host business
let studioId: number; // partner business
let outsiderId: number; // unrelated business
let partnershipId: number;
let barberStaff: number;
let studioStaff: number;
let outsiderStaff: number;

const asTenant = (id: number) => ({ "x-tenant-id": String(id) });

async function createStaff(tenantId: number, name: string): Promise<number> {
  const res = await agent
    .post("/api/sos/staff")
    .set(asTenant(tenantId))
    .send({ name, compensationType: "commission", commissionPercent: 50 })
    .expect(201);
  return res.body.id;
}

/** Walk a fresh visit to in_service so check_out is a legal transition. */
async function visitInService(tenantId: number, serviceType: string): Promise<number> {
  const customer = await agent
    .post("/api/sos/customers")
    .set(asTenant(tenantId))
    .send({ name: `Client ${serviceType}` })
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

async function checkOut(tenantId: number, visitId: number, body: Record<string, unknown>) {
  return agent
    .post(`/api/sos/visits/${visitId}/advance`)
    .set(asTenant(tenantId))
    .send({ action: "check_out", ...body })
    .expect(200);
}

const ledgerForVisit = (visitId: number) =>
  db.select().from(sosTipPoolLedgerTable).where(eq(sosTipPoolLedgerTable.visitId, visitId));

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
      { brandName: `Tip Barber ${RUN}`, subdomain: `${RUN}-barber`, status: "active" },
      { brandName: `Tip Studio ${RUN}`, subdomain: `${RUN}-studio`, status: "active" },
      { brandName: `Tip Outsider ${RUN}`, subdomain: `${RUN}-out`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [barberId, studioId, outsiderId] = tenants.map((t) => t.id);

  // Accepted + active co-op partnership between barber and studio.
  const created = await agent
    .post("/api/coop/partnerships")
    .send({ hostTenantId: barberId, partnerTenantId: studioId, perkTitle: `Tip perk ${RUN}` })
    .expect(201);
  partnershipId = created.body.id;

  barberStaff = await createStaff(barberId, `Blade ${RUN}`);
  studioStaff = await createStaff(studioId, `Shade ${RUN}`);
  outsiderStaff = await createStaff(outsiderId, `Out ${RUN}`);
});

afterAll(async () => {
  const ids = [barberId, studioId, outsiderId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // sos_customer_plans / sos_plan_transactions don't cascade from tenants —
    // clear them for our customers first, then the tenant cascade cleans
    // partnerships, rules, bundles, visits, and ledger rows.
    const customers = await db
      .select({ id: sosCustomersTable.id })
      .from(sosCustomersTable)
      .where(inArray(sosCustomersTable.tenantId, ids));
    const customerIds = customers.map((c) => c.id);
    if (customerIds.length) {
      await db
        .delete(sosPlanTransactionsTable)
        .where(inArray(sosPlanTransactionsTable.customerId, customerIds));
      await db
        .delete(sosCustomerPlansTable)
        .where(inArray(sosCustomerPlansTable.customerId, customerIds));
    }
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("rule CRUD & validation", () => {
  it("rejects percentage rules that don't total 100", async () => {
    const res = await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(barberId))
      .send({
        scope: "partnership",
        partnershipId,
        splitMethod: "percentage",
        participants: [
          { tenantId: barberId, staffId: barberStaff, percent: 60 },
          { tenantId: studioId, staffId: studioStaff, percent: 30 },
        ],
      })
      .expect(400);
    expect(res.body.message).toMatch(/100/);
  });

  it("rejects participants outside the two partnered businesses", async () => {
    await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(barberId))
      .send({
        scope: "partnership",
        partnershipId,
        splitMethod: "equal",
        participants: [
          { tenantId: barberId, staffId: barberStaff },
          { tenantId: outsiderId, staffId: outsiderStaff },
        ],
      })
      .expect(400);
  });

  it("rejects partnership rules from a non-participant business", async () => {
    await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(outsiderId))
      .send({
        scope: "partnership",
        partnershipId,
        splitMethod: "equal",
        participants: [{ tenantId: outsiderId, staffId: outsiderStaff }],
      })
      .expect(403);
  });

  it("both partners can view a shared rule; only the owner edits it", async () => {
    const created = await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(barberId))
      .send({
        scope: "partnership",
        partnershipId,
        splitMethod: "equal",
        participants: [
          { tenantId: barberId, staffId: barberStaff },
          { tenantId: studioId, staffId: studioStaff },
        ],
      })
      .expect(201);
    const ruleId = created.body.id;
    expect(created.body.participants).toHaveLength(2);

    const mine = await agent.get("/api/sos/tip-pooling/rules").set(asTenant(barberId)).expect(200);
    expect(mine.body.map((r: any) => r.id)).toContain(ruleId);
    const theirs = await agent.get("/api/sos/tip-pooling/rules").set(asTenant(studioId)).expect(200);
    expect(theirs.body.map((r: any) => r.id)).toContain(ruleId);
    const strangers = await agent
      .get("/api/sos/tip-pooling/rules")
      .set(asTenant(outsiderId))
      .expect(200);
    expect(strangers.body.map((r: any) => r.id)).not.toContain(ruleId);

    // Partner (non-owner) cannot edit or delete.
    await agent
      .patch(`/api/sos/tip-pooling/rules/${ruleId}`)
      .set(asTenant(studioId))
      .send({ isActive: false })
      .expect(404);
    await agent.delete(`/api/sos/tip-pooling/rules/${ruleId}`).set(asTenant(studioId)).expect(404);
    // Owner deletes (keeps later tests deterministic).
    await agent.delete(`/api/sos/tip-pooling/rules/${ruleId}`).set(asTenant(barberId)).expect(204);
  });

  it("exposes the partner's active staff for building shared rules", async () => {
    const res = await agent
      .get(`/api/sos/tip-pooling/partner-staff?partnershipId=${partnershipId}`)
      .set(asTenant(barberId))
      .expect(200);
    expect(res.body.map((s: any) => s.id)).toContain(studioStaff);
    await agent
      .get(`/api/sos/tip-pooling/partner-staff?partnershipId=${partnershipId}`)
      .set(asTenant(outsiderId))
      .expect(403);
  });
});

describe("no-rule fallback & group-event splits", () => {
  it("defaults the whole tip to the servicing staff member when no rule exists", async () => {
    const visitId = await visitInService(barberId, `Fallback ${RUN}`);
    await checkOut(barberId, visitId, { paymentAmount: 80, tipAmount: 15, staffId: barberStaff });
    const rows = await ledgerForVisit(visitId);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientStaffId).toBe(barberStaff);
    expect(rows[0].allocatedShare).toBe("15.00");
    expect(rows[0].ruleId).toBeNull();
    expect(rows[0].sourceTenantId).toBe(barberId);
    expect(rows[0].recipientTenantId).toBe(barberId);
  });

  it("splits by percentage for the tenant's group-event rule, remainder to servicing staff", async () => {
    const second = await createStaff(barberId, `Second ${RUN}`);
    const rule = await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(barberId))
      .send({
        scope: "group_event",
        splitMethod: "percentage",
        participants: [
          { staffId: barberStaff, percent: 67 },
          { staffId: second, percent: 33 },
        ],
      })
      .expect(201);

    // $10.01 → 67% = 670.67¢ floored 670; 33% = 330.33¢ floored 330;
    // 1¢ remainder goes to the servicing staff (barberStaff).
    const visitId = await visitInService(barberId, `Group ${RUN}`);
    await checkOut(barberId, visitId, { paymentAmount: 50, tipAmount: 10.01, staffId: barberStaff });
    const rows = await ledgerForVisit(visitId);
    expect(rows).toHaveLength(2);
    const byStaff = new Map(rows.map((r) => [r.recipientStaffId, r]));
    expect(byStaff.get(barberStaff)!.allocatedShare).toBe("6.71");
    expect(byStaff.get(second)!.allocatedShare).toBe("3.30");
    expect(rows.every((r) => r.grossTip === "10.01")).toBe(true);
    expect(rows.every((r) => r.ruleId === rule.body.id)).toBe(true);
    expect(rows.every((r) => r.ruleSnapshot != null)).toBe(true);

    // Deactivate the rule → fallback returns.
    await agent
      .patch(`/api/sos/tip-pooling/rules/${rule.body.id}`)
      .set(asTenant(barberId))
      .send({ isActive: false })
      .expect(200);
    const v2 = await visitInService(barberId, `Group2 ${RUN}`);
    await checkOut(barberId, v2, { paymentAmount: 20, tipAmount: 5, staffId: barberStaff });
    const rows2 = await ledgerForVisit(v2);
    expect(rows2).toHaveLength(1);
    expect(rows2[0].recipientStaffId).toBe(barberStaff);
    await agent.delete(`/api/sos/tip-pooling/rules/${rule.body.id}`).set(asTenant(barberId)).expect(204);
  });

  it("records the split exactly once when two checkouts race", async () => {
    const visitId = await visitInService(barberId, `Race cut ${RUN}`);
    const fire = () =>
      agent
        .post(`/api/sos/visits/${visitId}/advance`)
        .set(asTenant(barberId))
        .send({ action: "check_out", tipAmount: 10, staffId: barberStaff });
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const rows = await ledgerForVisit(visitId);
    expect(rows).toHaveLength(1);
    expect(rows[0].allocatedShare).toBe("10.00");
  });

  it("racing checkouts with a plan benefit spend the credit exactly once", async () => {
    const plan = await agent
      .post("/api/sos/plans")
      .set(asTenant(barberId))
      .send({ name: `Race Pack ${RUN}`, planType: "package", price: 40, creditCount: 1 })
      .expect(201);
    const customer = await agent
      .post("/api/sos/customers")
      .set(asTenant(barberId))
      .send({ name: `Race Client ${RUN}` })
      .expect(201);
    const enrolled = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant(barberId))
      .send({ customerId: customer.body.id, planId: plan.body.id })
      .expect(201);

    // Walk this specific customer's visit to in_service.
    const visit = await agent
      .post("/api/sos/visits")
      .set(asTenant(barberId))
      .send({ customerId: customer.body.id, serviceType: `Race benefit ${RUN}` })
      .expect(201);
    const resource = await agent
      .post("/api/sos/resources")
      .set(asTenant(barberId))
      .send({ name: `Chair race ${RUN}`, resourceType: "chair" })
      .expect(201);
    await agent
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant(barberId))
      .send({ action: "assign", resourceId: resource.body.id })
      .expect(200);
    await agent
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant(barberId))
      .send({ action: "start_service" })
      .expect(200);

    const fire = () =>
      agent
        .post(`/api/sos/visits/${visit.body.id}/advance`)
        .set(asTenant(barberId))
        .send({
          action: "check_out",
          tipAmount: 5,
          staffId: barberStaff,
          benefitCustomerPlanId: enrolled.body.id,
          benefitType: "redeem_credit",
        });
    const [a, b] = await Promise.all([fire(), fire()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    // Loser wrote nothing: exactly one redemption, credit balance 0, one ledger row.
    const redemptions = await db
      .select()
      .from(sosPlanTransactionsTable)
      .where(eq(sosPlanTransactionsTable.customerPlanId, enrolled.body.id));
    expect(redemptions.filter((t) => t.transactionType === "redemption")).toHaveLength(1);
    const plans = await agent
      .get(`/api/sos/customers/${customer.body.id}/plans`)
      .set(asTenant(barberId))
      .expect(200);
    expect(plans.body.plans.find((p: any) => p.id === enrolled.body.id).remainingCredits).toBe(0);
    expect(await ledgerForVisit(visit.body.id)).toHaveLength(1);
  });

  it("writes no ledger rows when there is no rule and no servicing staff", async () => {
    const visitId = await visitInService(barberId, `NoStaff ${RUN}`);
    await checkOut(barberId, visitId, { paymentAmount: 40, tipAmount: 8 });
    expect(await ledgerForVisit(visitId)).toHaveLength(0);
  });
});

describe("cross-business bundle splits & partnership gating", () => {
  async function createPartnershipRule(method: string, extras: any[]) {
    const res = await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(barberId))
      .send({ scope: "partnership", partnershipId, splitMethod: method, participants: extras })
      .expect(201);
    return res.body.id as number;
  }

  it("splits a bundled visit's tip across both businesses (equal), with preview", async () => {
    const ruleId = await createPartnershipRule("equal", [
      { tenantId: barberId, staffId: barberStaff },
      { tenantId: studioId, staffId: studioStaff },
    ]);

    const visitId = await visitInService(barberId, `Bundle ${RUN}`);
    const bundle = await agent
      .post("/api/sos/tip-pooling/bundles")
      .set(asTenant(barberId))
      .send({ partnershipId, visitId })
      .expect(201);
    expect(bundle.body.visitIds).toContain(visitId);

    // Preview: $9 equal split with remainder → servicing staff gets the odd cent.
    const preview = await agent
      .get(`/api/sos/tip-pooling/preview?visitId=${visitId}&tipAmount=9.01`)
      .set(asTenant(barberId))
      .expect(200);
    expect(preview.body.ruleId).toBe(ruleId);
    expect(preview.body.allocations).toHaveLength(2);

    await checkOut(barberId, visitId, { paymentAmount: 100, tipAmount: 9.01, staffId: barberStaff });
    const rows = await ledgerForVisit(visitId);
    expect(rows).toHaveLength(2);
    const byStaff = new Map(rows.map((r) => [r.recipientStaffId, r]));
    expect(byStaff.get(barberStaff)!.allocatedShare).toBe("4.51");
    expect(byStaff.get(studioStaff)!.allocatedShare).toBe("4.50");
    expect(byStaff.get(studioStaff)!.recipientTenantId).toBe(studioId);
    expect(byStaff.get(studioStaff)!.sourceTenantId).toBe(barberId);

    // Cross-business shares surface in the partner's ledger, marked partner-origin.
    const studioLedger = await agent
      .get("/api/sos/tip-pooling/ledger")
      .set(asTenant(studioId))
      .expect(200);
    const share = studioLedger.body.find(
      (e: any) => e.visitId === visitId && e.recipientStaffId === studioStaff,
    );
    expect(share).toBeTruthy();
    expect(share.origin).toBe("partner");
    expect(share.allocatedShare).toBe(4.5);

    await agent.delete(`/api/sos/tip-pooling/rules/${ruleId}`).set(asTenant(barberId)).expect(204);
  });

  it("splits role-weighted with deterministic rounding", async () => {
    const ruleId = await createPartnershipRule("role_weighted", [
      { tenantId: barberId, staffId: barberStaff, role: "Lead", weight: 2 },
      { tenantId: studioId, staffId: studioStaff, role: "Assist", weight: 1 },
    ]);
    const visitId = await visitInService(barberId, `Weighted ${RUN}`);
    await agent
      .post("/api/sos/tip-pooling/bundles")
      .set(asTenant(barberId))
      .send({ partnershipId, visitId })
      .expect(201);
    // $10 → lead 2/3 = 666.66¢ floor 666, assist 1/3 = 333.33¢ floor 333,
    // remainder 1¢ → servicing staff (lead).
    await checkOut(barberId, visitId, { paymentAmount: 60, tipAmount: 10, staffId: barberStaff });
    const rows = await ledgerForVisit(visitId);
    const byStaff = new Map(rows.map((r) => [r.recipientStaffId, r]));
    expect(byStaff.get(barberStaff)!.allocatedShare).toBe("6.67");
    expect(byStaff.get(studioStaff)!.allocatedShare).toBe("3.33");
    await agent.delete(`/api/sos/tip-pooling/rules/${ruleId}`).set(asTenant(barberId)).expect(204);
  });

  it("never splits across a pending or declined partnership", async () => {
    // Pending partnership with the outsider (direct insert, status pending).
    const [pending] = await db
      .insert(merchantCoopPartnershipsTable)
      .values({
        hostTenantId: barberId,
        partnerTenantId: outsiderId,
        perkTitle: `Pending ${RUN}`,
        redemptionCode: `PEND-${RUN}`,
        status: "pending",
        hostTrackingCode: `CPT-PEND${RUN}`.slice(0, 24),
        partnerTrackingCode: `CPT-PEND2${RUN}`.slice(0, 24),
      })
      .returning({ id: merchantCoopPartnershipsTable.id });

    // Rules on a non-live partnership are refused outright.
    await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(barberId))
      .send({
        scope: "partnership",
        partnershipId: pending.id,
        splitMethod: "equal",
        participants: [{ tenantId: barberId, staffId: barberStaff }],
      })
      .expect(409);
    // So are bundles.
    const v = await visitInService(barberId, `PendingV ${RUN}`);
    await agent
      .post("/api/sos/tip-pooling/bundles")
      .set(asTenant(barberId))
      .send({ partnershipId: pending.id, visitId: v })
      .expect(409);

    // A rule created while live must stop splitting the moment the
    // partnership is declined/deactivated: checkout falls back to staff.
    const ruleId = (await agent
      .post("/api/sos/tip-pooling/rules")
      .set(asTenant(barberId))
      .send({
        scope: "partnership",
        partnershipId,
        splitMethod: "equal",
        participants: [
          { tenantId: barberId, staffId: barberStaff },
          { tenantId: studioId, staffId: studioStaff },
        ],
      })
      .expect(201)).body.id;
    const visitId = await visitInService(barberId, `Gated ${RUN}`);
    await agent
      .post("/api/sos/tip-pooling/bundles")
      .set(asTenant(barberId))
      .send({ partnershipId, visitId })
      .expect(201);
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: false })
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    try {
      await checkOut(barberId, visitId, { paymentAmount: 30, tipAmount: 6, staffId: barberStaff });
      const rows = await ledgerForVisit(visitId);
      expect(rows).toHaveLength(1);
      expect(rows[0].recipientStaffId).toBe(barberStaff);
      expect(rows[0].allocatedShare).toBe("6.00");
      expect(rows[0].ruleId).toBeNull();
    } finally {
      await db
        .update(merchantCoopPartnershipsTable)
        .set({ isActive: true })
        .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
      await agent.delete(`/api/sos/tip-pooling/rules/${ruleId}`).set(asTenant(barberId)).expect(204);
      await db
        .delete(merchantCoopPartnershipsTable)
        .where(eq(merchantCoopPartnershipsTable.id, pending.id));
    }
  });
});

describe("earnings & shift reporting", () => {
  it("reports shared tips as a line item separate from commission", async () => {
    const earner = await createStaff(barberId, `TipEarner ${RUN}`);
    const visitId = await visitInService(barberId, `Earn ${RUN}`);
    await checkOut(barberId, visitId, { paymentAmount: 100, tipAmount: 12, staffId: earner });

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const earnings = await agent
      .get(`/api/sos/staff-earnings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set(asTenant(barberId))
      .expect(200);
    const row = earnings.body.find((r: any) => r.staffId === earner);
    expect(row.attributedRevenue).toBe(100);
    expect(row.commissionEarned).toBe(50); // 50% of service revenue only
    expect(row.sharedTipsEarned).toBe(12); // tips never inflate commission

    // Shift report: today's totals, all own-business origin.
    const today = new Date().toISOString().slice(0, 10);
    const report = await agent
      .get(`/api/sos/tip-pooling/shift-report?date=${today}`)
      .set(asTenant(barberId))
      .expect(200);
    const line = report.body.find((r: any) => r.staffId === earner);
    expect(line).toBeTruthy();
    expect(line.ownTips).toBe(12);
    expect(line.partnerTips).toBe(0);
    expect(line.totalTips).toBe(12);
  });
});

describe("native checkout is the sole tip entry point", () => {
  it("a checkout tip writes exactly one ledger (tip-pool), never both", async () => {
    // Barber has a live co-op partnership + servicing staff → the tip-pool
    // engine owns the tip (no rule resolves, so the whole tip goes to the
    // servicing staff member) and the classic gratuity pool writes nothing.
    const visitId = await visitInService(barberId, `SoleEntry ${RUN}`);
    await checkOut(barberId, visitId, { paymentAmount: 90, tipAmount: 18, staffId: barberStaff });

    const poolRows = await ledgerForVisit(visitId);
    expect(poolRows).toHaveLength(1);
    expect(poolRows[0].recipientStaffId).toBe(barberStaff);
    expect(poolRows[0].recipientTenantId).toBe(barberId);
    expect(poolRows[0].allocatedShare).toBe("18.00");
    expect(poolRows[0].grossTip).toBe("18.00");

    const gratuityRows = await db
      .select()
      .from(sosGratuityLedgerTable)
      .where(eq(sosGratuityLedgerTable.visitId, visitId));
    expect(gratuityRows).toHaveLength(0);
  });
});
