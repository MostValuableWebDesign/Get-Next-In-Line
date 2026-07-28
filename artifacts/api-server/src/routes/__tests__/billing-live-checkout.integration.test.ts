import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  modulesTable,
  tenantModulesTable,
  tenantActivitiesTable,
  moduleCheckoutSessionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests: REAL payment collection at module checkout.
//
// Contract under guard:
//   - Stripe configured → checkout creates a Stripe Checkout session, records
//     a pending module_checkout_sessions snapshot, and provisions NOTHING
//   - checkout.session.completed webhook → provisions the snapshot exactly
//     once (idempotent on retries) with payment_mode "live" + MRR update
//   - checkout.session.expired → marks failed, provisions nothing
//   - Stripe session creation failure → 502, nothing provisioned
//   - Stripe NOT configured → simulated path provisions immediately, response
//     and rows clearly labeled simulated
//
// Stripe is mocked at the client boundary; the database is the real dev DB.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // session cookies over plain HTTP in supertest

const stripeCalls: { sessionsCreated: unknown[] } = { sessionsCreated: [] };
let nextSessionBehavior: "ok" | "throw" = "ok";
let sessionCounter = 0;

vi.mock("../../lib/stripeClient", () => ({
  isStripeConfigured: () => true,
  getUncachableStripeClient: async () => ({
    checkout: {
      sessions: {
        create: async (params: unknown) => {
          if (nextSessionBehavior === "throw") {
            throw new Error("Your card processing account is misconfigured");
          }
          stripeCalls.sessionsCreated.push(params);
          const id = `cs_test_live_${Date.now()}_${sessionCounter++}`;
          return { id, url: `https://checkout.stripe.com/pay/${id}`, payment_intent: null };
        },
      },
    },
  }),
  getStripeSync: async () => {
    throw new Error("not used in this test");
  },
}));

import { BIWEEKLY_TO_MONTHLY } from "../../lib/moduleCheckout";

const RUN = `livechk-${Date.now()}-${process.pid}`;

let app: import("express").Express;
let modA: { id: number; name: string }; // monthly 100.00, biweekly 55.00
let modB: { id: number; name: string }; // monthly 80.00

const seededTenantIds: number[] = [];
const seededModuleIds: number[] = [];

async function newTenant(label: string): Promise<{ id: number; mrr: number }> {
  const [t] = await db
    .insert(tenantsTable)
    .values({
      brandName: `${label} ${RUN}`,
      subdomain: `${label.toLowerCase()}-${RUN}`,
      status: "active",
      mrr: "100.00",
    })
    .returning({ id: tenantsTable.id, mrr: tenantsTable.mrr });
  seededTenantIds.push(t.id);
  return { id: t.id, mrr: parseFloat(t.mrr ?? "0") };
}

async function loggedInAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  app = (await import("../../app")).default;
  const mods = await db
    .insert(modulesTable)
    .values([
      {
        name: `LiveModA ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "live checkout module A",
        wholesalePrice: "100.00",
        wholesalePriceBiweekly: "55.00",
        slug: `livemod-a-${RUN}`,
      },
      {
        name: `LiveModB ${RUN}`,
        category: "Test",
        categorySlug: "test",
        description: "live checkout module B",
        wholesalePrice: "80.00",
        slug: `livemod-b-${RUN}`,
      },
    ])
    .returning({ id: modulesTable.id, name: modulesTable.name });
  [modA, modB] = mods;
  seededModuleIds.push(...mods.map((m) => m.id));
});

afterEach(async () => {
  nextSessionBehavior = "ok";
  const { __setLiveModuleCheckoutForTests } = await import("../../lib/moduleCheckout");
  __setLiveModuleCheckoutForTests(null);
});

afterAll(async () => {
  if (seededTenantIds.length) {
    await db
      .delete(moduleCheckoutSessionsTable)
      .where(inArray(moduleCheckoutSessionsTable.tenantId, seededTenantIds));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, seededTenantIds));
  }
  if (seededModuleIds.length) {
    await db.delete(modulesTable).where(inArray(modulesTable.id, seededModuleIds));
  }
});

async function enableLive() {
  const { __setLiveModuleCheckoutForTests } = await import("../../lib/moduleCheckout");
  __setLiveModuleCheckoutForTests(true);
}

describe("POST /api/billing/checkout — live Stripe payment collection", () => {
  it("creates a Stripe checkout session and provisions NOTHING until payment", async () => {
    await enableLive();
    const agent = await loggedInAgent();
    const tenant = await newTenant("LivePending");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [modA.id, modB.id],
      moduleCadences: [{ moduleId: modA.id, cadence: "biweekly" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.paymentMode).toBe("live_pending");
    expect(res.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(res.body.modulesProvisioned).toBe(0);
    expect(res.body.transactionId).toMatch(/^cs_test_live_/);

    // Nothing provisioned, MRR untouched.
    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(0);
    const [after] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    expect(parseFloat(after.mrr ?? "0")).toBeCloseTo(tenant.mrr, 2);

    // Pending snapshot recorded with the priced cart.
    const [pending] = await db
      .select()
      .from(moduleCheckoutSessionsTable)
      .where(eq(moduleCheckoutSessionsTable.stripeSessionId, res.body.transactionId));
    expect(pending).toBeDefined();
    expect(pending.status).toBe("pending");
    expect(pending.tenantId).toBe(tenant.id);
    expect((pending.items as Array<{ moduleId: number }>).map((i) => i.moduleId).sort()).toEqual(
      [modA.id, modB.id].sort()
    );
  });

  it("provisions the snapshot as LIVE exactly once when the payment webhook completes", async () => {
    await enableLive();
    const agent = await loggedInAgent();
    const tenant = await newTenant("LivePaid");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [modA.id, modB.id],
      moduleCadences: [{ moduleId: modA.id, cadence: "biweekly" }],
    });
    expect(res.status).toBe(200);
    const sessionId = res.body.transactionId as string;

    const { applyModuleCheckoutEvent } = await import("../../lib/moduleCheckout");
    const event = { type: "checkout.session.completed", data: { object: { id: sessionId } } };
    await applyModuleCheckoutEvent(event);
    await applyModuleCheckoutEvent(event); // duplicate delivery — must be a no-op

    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(2);
    for (const a of assignments) {
      expect(a.paymentMode).toBe("live");
      expect(a.stripeCheckoutSessionId).toBe(sessionId);
    }

    // MRR applied once, with bi-weekly ×26/12 conversion of the resale price.
    const markupFactorA = parseFloat(assignments.find((a) => a.moduleId === modA.id)!.chargedResale!);
    const resaleB = parseFloat(assignments.find((a) => a.moduleId === modB.id)!.chargedResale!);
    const [after] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    expect(parseFloat(after.mrr ?? "0")).toBeCloseTo(
      Math.round((tenant.mrr + markupFactorA * BIWEEKLY_TO_MONTHLY + resaleB) * 100) / 100,
      1
    );
    expect(after.modulesEnabled).toBe(2);

    // Session row claimed; activity labeled as paid.
    const [row] = await db
      .select()
      .from(moduleCheckoutSessionsTable)
      .where(eq(moduleCheckoutSessionsTable.stripeSessionId, sessionId));
    expect(row.status).toBe("completed");
    const activities = await db
      .select()
      .from(tenantActivitiesTable)
      .where(eq(tenantActivitiesTable.tenantId, tenant.id));
    expect(activities).toHaveLength(1);
    expect(activities[0].action).toBe("Modules provisioned (paid)");
    expect(activities[0].details).toContain("payment collected via Stripe");
  });

  it("expired (failed) payment provisions nothing and marks the session failed", async () => {
    await enableLive();
    const agent = await loggedInAgent();
    const tenant = await newTenant("LiveExpired");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [modB.id],
    });
    expect(res.status).toBe(200);
    const sessionId = res.body.transactionId as string;

    const { applyModuleCheckoutEvent } = await import("../../lib/moduleCheckout");
    await applyModuleCheckoutEvent({
      type: "checkout.session.expired",
      data: { object: { id: sessionId } },
    });
    // A late completed event after expiry must NOT resurrect the checkout.
    await applyModuleCheckoutEvent({
      type: "checkout.session.completed",
      data: { object: { id: sessionId } },
    });

    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(0);
    const [row] = await db
      .select()
      .from(moduleCheckoutSessionsTable)
      .where(eq(moduleCheckoutSessionsTable.stripeSessionId, sessionId));
    expect(row.status).toBe("failed");
    const [after] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    expect(parseFloat(after.mrr ?? "0")).toBeCloseTo(tenant.mrr, 2);
  });

  it("returns 502 and provisions nothing when the Stripe session cannot be created", async () => {
    await enableLive();
    nextSessionBehavior = "throw";
    const agent = await loggedInAgent();
    const tenant = await newTenant("LiveError");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [modA.id],
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("no modules were provisioned");

    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(0);
    const [after] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    expect(parseFloat(after.mrr ?? "0")).toBeCloseTo(tenant.mrr, 2);
  });

  it("falls back to a clearly-labeled simulated checkout when Stripe is not configured", async () => {
    // Default under NODE_ENV=test: live checkout disabled (Stripe "not configured").
    const agent = await loggedInAgent();
    const tenant = await newTenant("Simulated");

    const res = await agent.post("/api/billing/checkout").send({
      tenantId: tenant.id,
      moduleIds: [modB.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.paymentMode).toBe("simulated");
    expect(res.body.checkoutUrl).toBeUndefined();
    expect(res.body.modulesProvisioned).toBe(1);
    expect(res.body.transactionId).toMatch(/^sim_/);
    expect(res.body.message).toContain("SIMULATED");
    expect(res.body.message).toContain("no payment collected");

    const assignments = await db
      .select()
      .from(tenantModulesTable)
      .where(eq(tenantModulesTable.tenantId, tenant.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0].paymentMode).toBe("simulated");
    expect(assignments[0].stripeCheckoutSessionId).toBeNull();

    // GET /tenants/:id/modules surfaces the payment mode for the billing UI.
    const modsRes = await agent.get(`/api/tenants/${tenant.id}/modules`);
    expect(modsRes.status).toBe(200);
    expect(modsRes.body[0].paymentMode).toBe("simulated");
  });
});
