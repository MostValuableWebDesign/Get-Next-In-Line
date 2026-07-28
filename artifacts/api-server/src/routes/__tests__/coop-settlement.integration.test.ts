import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopPerkRedemptionsTable,
  coopObligationLedgerTable,
  coopSettlementCyclesTable,
  coopSettlementStatementsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { runSettlementCycle } from "../../lib/coopSettlement";

// ---------------------------------------------------------------------------
// Co-Op Master Dashboard & Settlement Clearinghouse.
//
// Other suites share this dev DB, so assertions are scoped strictly to the
// tenants/partnerships this suite creates. The settlement run itself operates
// over a far-future date window that only this suite's entries occupy, so
// concurrent suites can never contaminate the netting math.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const RUN = `stl-${Date.now()}-${process.pid}`;

// Isolated far-future window so no other suite's obligations can fall in it.
const WINDOW_START = new Date("2091-01-01T00:00:00Z");
const WINDOW_END = new Date("2091-02-01T00:00:00Z");
const IN_WINDOW = new Date("2091-01-10T12:00:00Z");

let app: import("express").Express;
const tenantIds: number[] = [];
const cycleIds: number[] = [];

async function freshTenant(tag: string) {
  const [t] = await db
    .insert(tenantsTable)
    .values({ brandName: `Settle ${tag} ${RUN}`, subdomain: `${tag}-${RUN}`, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantIds.push(t.id);
  return t.id;
}

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
});

afterAll(async () => {
  if (tenantIds.length > 0) {
    await db
      .delete(coopObligationLedgerTable)
      .where(inArray(coopObligationLedgerTable.debtorTenantId, tenantIds));
  }
  if (cycleIds.length > 0) {
    await db
      .delete(coopSettlementStatementsTable)
      .where(inArray(coopSettlementStatementsTable.cycleId, cycleIds));
    await db
      .delete(coopSettlementCyclesTable)
      .where(inArray(coopSettlementCyclesTable.id, cycleIds));
  }
  for (const id of tenantIds) {
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

const ledgerFor = (tenantId: number) =>
  db
    .select()
    .from(coopObligationLedgerTable)
    .where(eq(coopObligationLedgerTable.debtorTenantId, tenantId));

async function seedPartnership(
  hostTenantId: number,
  partnerTenantId: number,
  tag: string,
  extra: Partial<typeof merchantCoopPartnershipsTable.$inferInsert> = {},
) {
  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId,
      partnerTenantId,
      perkTitle: `Settle perk ${tag} ${RUN}`,
      redemptionCode: `STL-${tag.toUpperCase()}-${RUN}`,
      status: "accepted",
      isActive: true,
      ...extra,
    })
    .returning();
  return p;
}

describe("obligation ledger hooks", () => {
  it("a revenue-share perk redemption records a referral_fee obligation (gross, persisted terms)", async () => {
    const agent = await loggedInAgent();
    const hostId = await freshTenant("rf-host");
    const partnerId = await freshTenant("rf-part");
    const p = await seedPartnership(hostId, partnerId, "rf", {
      revenueShareKind: "bounty",
      revenueShareValue: "12.50",
    });

    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: p.redemptionCode, passCode: `pass-${RUN}-rf` })
      .expect(200);

    const rows = await ledgerFor(partnerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("referral_fee");
    expect(rows[0].creditorTenantId).toBe(hostId);
    expect(parseFloat(rows[0].amount)).toBe(12.5);
    expect(rows[0].settlementCycleId).toBeNull();

    // Idempotent: a second redemption attempt of the same pass adds nothing.
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: p.redemptionCode, passCode: `pass-${RUN}-rf` });
    expect(await ledgerFor(partnerId)).toHaveLength(1);
  });

  it("a valued mutual perk redemption records a perk_obligation owed by the referring side", async () => {
    const agent = await loggedInAgent();
    const hostId = await freshTenant("pv-host");
    const partnerId = await freshTenant("pv-part");
    const p = await seedPartnership(hostId, partnerId, "pv", { perkValueAmount: "8.00" });

    // Host's staff redeems → the partner (referring side) owes the host $8.
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(hostId))
      .send({ code: p.redemptionCode, passCode: `pass-${RUN}-pv` })
      .expect(200);

    const rows = await ledgerFor(partnerId);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("perk_obligation");
    expect(rows[0].creditorTenantId).toBe(hostId);
    expect(parseFloat(rows[0].amount)).toBe(8);
  });

  it("logging a shared event expense records ad_pool_contribution shares from the other participants", async () => {
    const agent = await loggedInAgent();
    const aId = await freshTenant("ex-a");
    const bId = await freshTenant("ex-b");
    const cId = await freshTenant("ex-c");
    await seedPartnership(aId, bId, "ex-ab");
    await seedPartnership(aId, cId, "ex-ac");

    const eventRes = await agent
      .post("/api/coop/events")
      .set("x-tenant-id", String(aId))
      .send({
        name: `Block Party ${RUN}`,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        partnerTenantIds: [bId, cId],
      })
      .expect(201);
    const eventId = eventRes.body.id;
    for (const tid of [bId, cId]) {
      await agent
        .post(`/api/coop/events/${eventId}/respond`)
        .set("x-tenant-id", String(tid))
        .send({ action: "accept" })
        .expect(200);
    }

    await agent
      .post(`/api/coop/events/${eventId}/expenses`)
      .set("x-tenant-id", String(aId))
      .send({ description: "Flyer printing", amount: 90, splitMethod: "even" })
      .expect(201);

    const bRows = await ledgerFor(bId);
    const cRows = await ledgerFor(cId);
    expect(bRows).toHaveLength(1);
    expect(cRows).toHaveLength(1);
    expect(bRows[0].kind).toBe("ad_pool_contribution");
    expect(bRows[0].creditorTenantId).toBe(aId);
    expect(parseFloat(bRows[0].amount)).toBe(30);
    expect(parseFloat(cRows[0].amount)).toBe(30);
    // The payer itself owes nothing.
    expect(await ledgerFor(aId)).toHaveLength(0);
  });
});

describe("settlement engine", () => {
  async function seedObligation(debtor: number, creditor: number, amount: string, tag: string) {
    const [row] = await db
      .insert(coopObligationLedgerTable)
      .values({
        debtorTenantId: debtor,
        creditorTenantId: creditor,
        kind: "referral_fee",
        amount,
        sourceRef: `test:${RUN}:${tag}`,
        occurredAt: IN_WINDOW,
      })
      .returning();
    return row;
  }

  it("nets pairwise, produces per-tenant statements, and marks entries settled exactly once", async () => {
    const agent = await loggedInAgent();
    const aId = await freshTenant("net-a");
    const bId = await freshTenant("net-b");
    const cId = await freshTenant("net-c");
    await seedObligation(aId, bId, "10.00", "ab1");
    await seedObligation(bId, aId, "4.00", "ba1");
    await seedObligation(cId, aId, "6.00", "ca1");

    // Preview first — nothing is settled by previewing.
    const preview = await agent
      .get("/api/agency/settlement/preview")
      .query({ periodStart: WINDOW_START.toISOString(), periodEnd: WINDOW_END.toISOString() })
      .expect(200);
    expect(preview.body.entryCount).toBe(3);
    expect(preview.body.grossVolume).toBe(20);

    const run = await agent
      .post("/api/agency/settlement/run")
      .send({ periodStart: WINDOW_START.toISOString(), periodEnd: WINDOW_END.toISOString() })
      .expect(201);
    const cycleId = run.body.cycle.id;
    cycleIds.push(cycleId);
    expect(run.body.cycle.entryCount).toBe(3);

    const byTenant = new Map(
      (run.body.statements as Array<{ tenantId: number; netAmount: number }>).map((s) => [
        s.tenantId,
        s,
      ]),
    );
    // A: owes 10 to B, is owed 4 by B and 6 by C → net 0.
    expect(byTenant.get(aId)!.netAmount).toBe(0);
    expect(byTenant.get(bId)!.netAmount).toBe(6);
    expect(byTenant.get(cId)!.netAmount).toBe(-6);
    const netSum = [...byTenant.values()].reduce((s, x) => s + Math.round(x.netAmount * 100), 0);
    expect(netSum).toBe(0);

    // Entries are stamped with the cycle.
    const settled = await db
      .select()
      .from(coopObligationLedgerTable)
      .where(
        and(
          inArray(coopObligationLedgerTable.debtorTenantId, [aId, bId, cId]),
          eq(coopObligationLedgerTable.settlementCycleId, cycleId),
        ),
      );
    expect(settled).toHaveLength(3);

    // No double settlement: the window is now empty and a re-run refuses.
    await agent
      .post("/api/agency/settlement/run")
      .send({ periodStart: WINDOW_START.toISOString(), periodEnd: WINDOW_END.toISOString() })
      .expect(400);

    // Cycle is browsable with its statements and drill-down entries.
    const detail = await agent.get(`/api/agency/settlement/cycles/${cycleId}`).expect(200);
    expect(detail.body.statements).toHaveLength(3);
    const stmt = await agent
      .get(`/api/agency/settlement/cycles/${cycleId}/statements/${aId}`)
      .expect(200);
    expect(stmt.body.statement.tenantId).toBe(aId);
    expect(stmt.body.entries).toHaveLength(3); // A touches all three entries
    expect(stmt.body.statement.lines).toHaveLength(2);
  });

  it("concurrent runs cannot double-settle: exactly one wins", async () => {
    const aId = await freshTenant("cc-a");
    const bId = await freshTenant("cc-b");
    await seedObligation(aId, bId, "5.00", "cc1");

    const [r1, r2] = await Promise.all([
      runSettlementCycle(WINDOW_START, WINDOW_END),
      runSettlementCycle(WINDOW_START, WINDOW_END),
    ]);
    const results = [r1, r2];
    const wins = results.filter((r) => r.ok);
    // Exactly one run settles; the other is rejected by the advisory lock or
    // finds an empty window (if it ran strictly after the winner committed).
    expect(wins).toHaveLength(1);
    const winner = wins[0] as Extract<typeof r1, { ok: true }>;
    cycleIds.push(winner.cycle.id);
    expect(winner.cycle.entryCount).toBe(1);
    const [entry] = await db
      .select()
      .from(coopObligationLedgerTable)
      .where(eq(coopObligationLedgerTable.debtorTenantId, aId));
    expect(entry.settlementCycleId).toBe(winner.cycle.id);
  });

  it("closed cycles are read-only via the API (no mutation routes exist)", async () => {
    const agent = await loggedInAgent();
    expect(cycleIds.length).toBeGreaterThan(0);
    const cycleId = cycleIds[0];
    for (const method of ["patch", "put", "delete"] as const) {
      const res = await agent[method](`/api/agency/settlement/cycles/${cycleId}`);
      expect(res.status).toBe(404); // route not registered — nothing can alter a cycle
    }
  });
});

describe("master overview", () => {
  it("aggregates network KPIs and requires an admin session", async () => {
    await request(app).get("/api/agency/master-overview").expect(401);

    const agent = await loggedInAgent();
    const res = await agent.get("/api/agency/master-overview?period=this_month").expect(200);
    expect(res.body.periodLabel).toBe("This month");
    expect(res.body.totalTenants).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.transactionVolume).toBe("number");
    expect(typeof res.body.unsettledBalance).toBe("number");
    expect(Array.isArray(res.body.flowsByKind)).toBe(true);

    const last = await agent.get("/api/agency/master-overview?period=last_month").expect(200);
    expect(last.body.periodLabel).toBe("Last month");
    expect(new Date(last.body.periodEnd).getTime()).toBe(new Date(res.body.periodStart).getTime());
  });
});
