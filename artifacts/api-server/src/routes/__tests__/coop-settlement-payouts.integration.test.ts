import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  tenantActivitiesTable,
  coopObligationLedgerTable,
  coopSettlementCyclesTable,
  coopSettlementStatementsTable,
  coopSettlementPayoutsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Settlement payouts — the real money leg of the clearinghouse.
//
// Contract under guard:
//   - POST /agency/settlement/cycles/:id/payouts pays every net-positive
//     statement exactly once (idempotent — re-runs skip settled payouts)
//   - Stripe not configured (test default) → explicit simulated mode
//   - Stripe configured + tenant destination attached → real transfer with a
//     payout-row idempotency key; no destination → simulated
//   - Failed transfers surface a reason and are retryable
//   - Cycle detail exposes per-statement payout state
//
// Stripe is mocked at the client boundary; the database is the real dev DB.
// Obligations are seeded directly into the ledger in an isolated far-future
// window only this suite occupies.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;

const transferCalls: { params: Record<string, unknown>; options: Record<string, unknown> }[] = [];
let transferBehavior: "ok" | "throw" = "ok";
let transferCounter = 0;

vi.mock("../../lib/stripeClient", () => ({
  isStripeConfigured: () => true,
  getUncachableStripeClient: async () => ({
    transfers: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        if (transferBehavior === "throw") {
          throw new Error("Insufficient available balance for transfer");
        }
        transferCalls.push({ params, options });
        return { id: `tr_test_${Date.now()}_${transferCounter++}` };
      },
    },
  }),
  getStripeSync: async () => {
    throw new Error("not used in this test");
  },
}));

import { runSettlementCycle } from "../../lib/coopSettlement";
import { __setLiveSettlementPayoutsForTests } from "../../lib/coopSettlementPayouts";

const RUN = `stlpay-${Date.now()}-${process.pid}`;

// Isolated far-future window so no other suite's obligations can fall in it.
const WINDOW_START = new Date("2093-01-01T00:00:00Z");
const WINDOW_END = new Date("2093-02-01T00:00:00Z");
const IN_WINDOW = new Date("2093-01-10T12:00:00Z");

let app: import("express").Express;
const tenantIds: number[] = [];
const cycleIds: number[] = [];
let refCounter = 0;

async function freshTenant(tag: string, payoutStripeAccountId: string | null = null) {
  const [t] = await db
    .insert(tenantsTable)
    .values({
      brandName: `Payee ${tag} ${RUN}`,
      subdomain: `${tag}-${RUN}`,
      status: "active",
      payoutStripeAccountId,
    })
    .returning({ id: tenantsTable.id });
  tenantIds.push(t.id);
  return t.id;
}

async function seedObligation(debtorId: number, creditorId: number, amount: string) {
  await db.insert(coopObligationLedgerTable).values({
    debtorTenantId: debtorId,
    creditorTenantId: creditorId,
    kind: "referral_fee",
    amount,
    sourceRef: `test:${RUN}:${refCounter++}`,
    occurredAt: IN_WINDOW,
  });
}

/** Seed one debtor→creditor obligation and close a cycle over it. */
async function closedCycle(amount = "25.00", creditorAccount: string | null = null) {
  const debtorId = await freshTenant(`d${refCounter}`);
  const creditorId = await freshTenant(`c${refCounter}`, creditorAccount);
  await seedObligation(debtorId, creditorId, amount);
  const result = await runSettlementCycle(WINDOW_START, WINDOW_END);
  if (!result.ok) throw new Error(`settlement run failed: ${result.reason}`);
  cycleIds.push(result.cycle.id);
  return { cycleId: result.cycle.id, debtorId, creditorId };
}

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

const payoutRows = (cycleId: number) =>
  db
    .select()
    .from(coopSettlementPayoutsTable)
    .where(eq(coopSettlementPayoutsTable.cycleId, cycleId));

beforeAll(async () => {
  app = (await import("../../app")).default;
});

afterEach(() => {
  __setLiveSettlementPayoutsForTests(null);
  transferBehavior = "ok";
  transferCalls.length = 0;
});

afterAll(async () => {
  if (cycleIds.length > 0) {
    await db
      .delete(coopSettlementPayoutsTable)
      .where(inArray(coopSettlementPayoutsTable.cycleId, cycleIds));
    await db
      .delete(coopSettlementStatementsTable)
      .where(inArray(coopSettlementStatementsTable.cycleId, cycleIds));
  }
  if (tenantIds.length > 0) {
    await db
      .delete(coopObligationLedgerTable)
      .where(inArray(coopObligationLedgerTable.debtorTenantId, tenantIds));
  }
  if (cycleIds.length > 0) {
    await db
      .delete(coopSettlementCyclesTable)
      .where(inArray(coopSettlementCyclesTable.id, cycleIds));
  }
  for (const id of tenantIds) {
    await db.delete(tenantActivitiesTable).where(eq(tenantActivitiesTable.tenantId, id));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
  }
});

describe("simulated payouts (Stripe live mode off — test default)", () => {
  it("pays net-positive statements in explicit simulated mode, idempotently", async () => {
    const agent = await loggedInAgent();
    const { cycleId, creditorId, debtorId } = await closedCycle("25.00");

    const res = await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);
    expect(res.body.eligibleCount).toBe(1);
    expect(res.body.simulatedCount).toBe(1);
    expect(res.body.paidCount).toBe(0);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.payouts).toHaveLength(1);
    const payout = res.body.payouts[0];
    expect(payout.tenantId).toBe(creditorId);
    expect(payout.status).toBe("simulated");
    expect(payout.mode).toBe("simulated");
    expect(payout.amount).toBe(25);
    expect(payout.providerRef).toBeNull();

    // Debtor (net-negative) never gets a payout row.
    const rows = await payoutRows(cycleId);
    expect(rows).toHaveLength(1);
    expect(rows.some((r) => r.tenantId === debtorId)).toBe(false);

    // Re-run: nothing new happens, nobody is double-paid.
    const rerun = await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);
    expect(rerun.body.simulatedCount).toBe(0);
    expect(rerun.body.skippedCount).toBe(1);
    expect(await payoutRows(cycleId)).toHaveLength(1);

    // Activity trail says SIMULATED, exactly once.
    const acts = await db
      .select()
      .from(tenantActivitiesTable)
      .where(eq(tenantActivitiesTable.tenantId, creditorId));
    const payoutActs = acts.filter((a) => a.action.includes("Settlement payout"));
    expect(payoutActs).toHaveLength(1);
    expect(payoutActs[0].action).toContain("simulated");
    expect(payoutActs[0].details).toContain("SIMULATED payout, no funds moved");
  });

  it("cycle detail surfaces per-statement payout state (null before, populated after)", async () => {
    const agent = await loggedInAgent();
    const { cycleId, creditorId, debtorId } = await closedCycle("10.00");

    const before = await agent.get(`/api/agency/settlement/cycles/${cycleId}`).expect(200);
    const creditorBefore = before.body.statements.find(
      (s: { tenantId: number }) => s.tenantId === creditorId,
    );
    expect(creditorBefore.payout).toBeNull();

    await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);

    const after = await agent.get(`/api/agency/settlement/cycles/${cycleId}`).expect(200);
    const creditorAfter = after.body.statements.find(
      (s: { tenantId: number }) => s.tenantId === creditorId,
    );
    expect(creditorAfter.payout.status).toBe("simulated");
    const debtorAfter = after.body.statements.find(
      (s: { tenantId: number }) => s.tenantId === debtorId,
    );
    expect(debtorAfter.payout).toBeNull();

    // Statement drill-down carries the same payout.
    const stmt = await agent
      .get(`/api/agency/settlement/cycles/${cycleId}/statements/${creditorId}`)
      .expect(200);
    expect(stmt.body.statement.payout.status).toBe("simulated");
  });

  it("404s for an unknown cycle", async () => {
    const agent = await loggedInAgent();
    await agent.post(`/api/agency/settlement/cycles/999999999/payouts`).expect(404);
  });
});

describe("live payouts (Stripe configured)", () => {
  it("transfers to the tenant's attached destination with a payout-keyed idempotency key", async () => {
    __setLiveSettlementPayoutsForTests(true);
    const agent = await loggedInAgent();
    const { cycleId, creditorId } = await closedCycle("42.50", "acct_test_live_1");

    const res = await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);
    expect(res.body.paidCount).toBe(1);
    expect(res.body.simulatedCount).toBe(0);
    const payout = res.body.payouts.find((p: { tenantId: number }) => p.tenantId === creditorId);
    expect(payout.status).toBe("paid");
    expect(payout.mode).toBe("stripe");
    expect(payout.providerRef).toMatch(/^tr_test_/);
    expect(payout.destination).toBe("acct_test_live_1");

    expect(transferCalls).toHaveLength(1);
    expect(transferCalls[0].params.amount).toBe(4250);
    expect(transferCalls[0].params.currency).toBe("usd");
    expect(transferCalls[0].params.destination).toBe("acct_test_live_1");
    expect(transferCalls[0].options.idempotencyKey).toBe(
      `coop-settlement-payout-${payout.id}`,
    );

    // Re-run never re-transfers.
    __setLiveSettlementPayoutsForTests(true);
    const rerun = await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);
    expect(rerun.body.skippedCount).toBe(1);
    expect(transferCalls).toHaveLength(1);
  });

  it("falls back to simulated when the tenant has no payout destination", async () => {
    __setLiveSettlementPayoutsForTests(true);
    const agent = await loggedInAgent();
    const { cycleId } = await closedCycle("15.00", null);

    const res = await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);
    expect(res.body.simulatedCount).toBe(1);
    expect(res.body.paidCount).toBe(0);
    expect(res.body.payouts[0].mode).toBe("simulated");
    expect(transferCalls).toHaveLength(0);
  });

  it("a failed transfer is visible with a reason and retryable to paid", async () => {
    __setLiveSettlementPayoutsForTests(true);
    transferBehavior = "throw";
    const agent = await loggedInAgent();
    const { cycleId, creditorId } = await closedCycle("30.00", "acct_test_retry_1");

    const failRes = await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);
    expect(failRes.body.failedCount).toBe(1);
    const failed = failRes.body.payouts.find((p: { tenantId: number }) => p.tenantId === creditorId);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toContain("Insufficient available balance");

    // Retry with Stripe healthy again → paid, same single payout row.
    __setLiveSettlementPayoutsForTests(true);
    transferBehavior = "ok";
    const retryRes = await agent.post(`/api/agency/settlement/cycles/${cycleId}/payouts`).expect(200);
    expect(retryRes.body.paidCount).toBe(1);
    expect(retryRes.body.failedCount).toBe(0);
    const paid = retryRes.body.payouts.find((p: { tenantId: number }) => p.tenantId === creditorId);
    expect(paid.status).toBe("paid");
    expect(paid.failureReason).toBeNull();
    expect(paid.id).toBe(failed.id);
    expect(await payoutRows(cycleId)).toHaveLength(1);
  });
});
