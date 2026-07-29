import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosPlansTable,
  sosCustomerPlansTable,
  sosPlanTransactionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integration tests for memberships/packages: plan CRUD, sell/renew/cancel,
// credit redemption and membership discounts at POS checkout, the zero-credit
// and cancelled-plan 409 paths, and the plan transaction ledger. Includes a
// concurrency test proving the conditional decrement can't double-spend the
// last credit.
//
// Isolation: one throwaway tenant per run (rows cascade on tenant delete),
// unique per-run plan names, and explicit cleanup of the global plan rows.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest
delete process.env.REPLIT_CONNECTORS_HOSTNAME; // no Twilio connector lookup
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `plans-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenant: number;
const planIds: number[] = [];

const asTenant = () => ({ "x-tenant-id": String(tenant) });

async function createCustomer(name: string) {
  const res = await agent
    .post("/api/sos/customers")
    .set(asTenant())
    .send({ name: `${name} ${RUN}`, smsOptIn: false })
    .expect(201);
  return res.body.id as number;
}

async function createResource(name: string) {
  const res = await agent
    .post("/api/sos/resources")
    .set(asTenant())
    .send({ name: `${name} ${RUN}`, resourceType: "chair" })
    .expect(201);
  return res.body.id as number;
}

/** Walk a fresh visit through checked_in → assigned → in_service. */
async function startVisit(customerId: number, resourceId: number) {
  const visit = await agent
    .post("/api/sos/visits")
    .set(asTenant())
    .send({ customerId, serviceType: `Cut ${RUN}` })
    .expect(201);
  await agent
    .post(`/api/sos/visits/${visit.body.id}/advance`)
    .set(asTenant())
    .send({ action: "assign", resourceId })
    .expect(200);
  await agent
    .post(`/api/sos/visits/${visit.body.id}/advance`)
    .set(asTenant())
    .send({ action: "start_service" })
    .expect(200);
  return visit.body.id as number;
}

/** Reset a resource so it can be assigned again (check_out leaves it cleaning). */
async function resetResource(resourceId: number) {
  await agent
    .patch(`/api/sos/resources/${resourceId}`)
    .set(asTenant())
    .send({ status: "available", currentVisitId: null })
    .expect(200);
}

async function getPlans(customerId: number) {
  const res = await agent
    .get(`/api/sos/customers/${customerId}/plans`)
    .set(asTenant())
    .expect(200);
  return res.body as {
    plans: Array<{
      id: number;
      status: string;
      remainingCredits: number | null;
      renewsAt: string | null;
      planType: string;
    }>;
    transactions: Array<{
      customerPlanId: number;
      transactionType: string;
      amount: number | null;
      creditsDelta: number | null;
      visitId: number | null;
      note: string | null;
    }>;
  };
}

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  // Tenant-scoped routes now require explicit tenant context; these tests
  // exercise the legacy (NULL-tenant) scope unless a request overrides it.
  agent.set("x-tenant-id", "legacy");
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [t] = await db
    .insert(tenantsTable)
    .values({ brandName: `Plans ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenant = t.id;
});

afterAll(async () => {
  // Enrollments/ledger rows don't cascade from customers; remove them (and
  // this run's global plan catalog rows) explicitly before the tenant.
  if (planIds.length > 0) {
    const enrollments = await db
      .select({ id: sosCustomerPlansTable.id })
      .from(sosCustomerPlansTable)
      .where(inArray(sosCustomerPlansTable.planId, planIds));
    const enrollmentIds = enrollments.map((e) => e.id);
    if (enrollmentIds.length > 0) {
      await db
        .delete(sosPlanTransactionsTable)
        .where(inArray(sosPlanTransactionsTable.customerPlanId, enrollmentIds));
      await db
        .delete(sosCustomerPlansTable)
        .where(inArray(sosCustomerPlansTable.id, enrollmentIds));
    }
    await db.delete(sosPlansTable).where(inArray(sosPlansTable.id, planIds));
  }
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenant));
});

describe("plan catalog CRUD", () => {
  it("rejects a membership without discountPercent", async () => {
    await agent
      .post("/api/sos/plans")
      .send({ name: `Bad Membership ${RUN}`, planType: "membership", price: 49 })
      .expect(400);
  });

  it("rejects a package without creditCount", async () => {
    await agent
      .post("/api/sos/plans")
      .send({ name: `Bad Package ${RUN}`, planType: "package", price: 100 })
      .expect(400);
  });

  it("creates, lists, and updates plans", async () => {
    const created = await agent
      .post("/api/sos/plans")
      .send({
        name: `Gold Membership ${RUN}`,
        planType: "membership",
        price: 59,
        discountPercent: 15,
      })
      .expect(201);
    planIds.push(created.body.id);
    // Membership defaults: monthly interval, no credits.
    expect(created.body.billingInterval).toBe("monthly");
    expect(created.body.creditCount).toBeNull();
    expect(created.body.price).toBe(59);

    const list = await agent.get("/api/sos/plans").expect(200);
    expect(list.body.some((p: { id: number }) => p.id === created.body.id)).toBe(true);

    const updated = await agent
      .patch(`/api/sos/plans/${created.body.id}`)
      .send({ price: 64.5, discountPercent: 20 })
      .expect(200);
    expect(updated.body.price).toBe(64.5);
    expect(updated.body.discountPercent).toBe(20);

    await agent.patch("/api/sos/plans/999999").send({ price: 1 }).expect(404);
  });
});

describe("selling plans", () => {
  let packagePlan: number;
  let membershipPlan: number;

  beforeAll(async () => {
    const pkg = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({ name: `5-Pack ${RUN}`, planType: "package", price: 200, creditCount: 5 })
      .expect(201);
    packagePlan = pkg.body.id;
    planIds.push(packagePlan);
    const mem = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({
        name: `Silver ${RUN}`,
        planType: "membership",
        price: 39,
        discountPercent: 10,
        billingInterval: "yearly",
      })
      .expect(201);
    membershipPlan = mem.body.id;
    planIds.push(membershipPlan);
  });

  it("initializes credits on a package sale and logs a purchase", async () => {
    const customerId = await createCustomer("Pack Buyer");
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: packagePlan })
      .expect(201);
    expect(sold.body.remainingCredits).toBe(5);
    expect(sold.body.renewsAt).toBeNull();
    expect(sold.body.status).toBe("active");

    const { transactions } = await getPlans(customerId);
    const purchase = transactions.find((t) => t.transactionType === "purchase");
    expect(purchase).toBeDefined();
    expect(purchase!.amount).toBe(200);
    expect(purchase!.creditsDelta).toBe(5);
  });

  it("initializes the renewal date on a membership sale", async () => {
    const customerId = await createCustomer("Mem Buyer");
    const before = Date.now();
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: membershipPlan })
      .expect(201);
    expect(sold.body.remainingCredits).toBeNull();
    // Yearly membership renews ~1 year out.
    const renewsAt = new Date(sold.body.renewsAt).getTime();
    const oneYear = 365 * 24 * 3600e3;
    expect(renewsAt).toBeGreaterThan(before + oneYear - 3 * 24 * 3600e3);
    expect(renewsAt).toBeLessThan(before + oneYear + 3 * 24 * 3600e3);
  });

  it("refuses to sell an inactive plan or to an unknown customer", async () => {
    const customerId = await createCustomer("Inactive Buyer");
    const inactive = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({ name: `Retired ${RUN}`, planType: "package", price: 10, creditCount: 1 })
      .expect(201);
    planIds.push(inactive.body.id);
    await agent.patch(`/api/sos/plans/${inactive.body.id}`).set(asTenant()).send({ isActive: false }).expect(200);
    await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: inactive.body.id })
      .expect(404);
    await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId: 999999, planId: packagePlan })
      .expect(404);
  });
});

describe("renewing and cancelling", () => {
  let membershipPlan: number;
  let customerId: number;
  let enrollmentId: number;

  beforeAll(async () => {
    const mem = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({
        name: `Renewable ${RUN}`,
        planType: "membership",
        price: 29,
        discountPercent: 5,
        billingInterval: "monthly",
      })
      .expect(201);
    membershipPlan = mem.body.id;
    planIds.push(membershipPlan);
    customerId = await createCustomer("Renewer");
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: membershipPlan })
      .expect(201);
    enrollmentId = sold.body.id;
  });

  it("early renewal extends from the current renewal date", async () => {
    const { plans } = await getPlans(customerId);
    const currentRenewsAt = new Date(plans.find((p) => p.id === enrollmentId)!.renewsAt!);
    expect(currentRenewsAt.getTime()).toBeGreaterThan(Date.now()); // still in the future

    const renewed = await agent
      .post(`/api/sos/customer-plans/${enrollmentId}/renew`)
      .set(asTenant())
      .expect(200);
    const expected = new Date(currentRenewsAt);
    expected.setMonth(expected.getMonth() + 1);
    expect(new Date(renewed.body.renewsAt).getTime()).toBe(expected.getTime());

    const { transactions } = await getPlans(customerId);
    const renewal = transactions.find((t) => t.transactionType === "renewal");
    expect(renewal).toBeDefined();
    expect(renewal!.amount).toBe(29);
  });

  it("past-due renewal restarts from now", async () => {
    const pastDue = new Date(Date.now() - 30 * 24 * 3600e3);
    await db
      .update(sosCustomerPlansTable)
      .set({ renewsAt: pastDue })
      .where(eq(sosCustomerPlansTable.id, enrollmentId));

    const before = Date.now();
    const renewed = await agent
      .post(`/api/sos/customer-plans/${enrollmentId}/renew`)
      .set(asTenant())
      .expect(200);
    const renewsAt = new Date(renewed.body.renewsAt).getTime();
    // ~1 month from now, never from the stale past-due date.
    expect(renewsAt).toBeGreaterThan(before + 26 * 24 * 3600e3);
    expect(renewsAt).toBeLessThan(before + 33 * 24 * 3600e3);
  });

  it("cancels an enrollment exactly once and blocks renewal afterwards", async () => {
    const cancelled = await agent
      .post(`/api/sos/customer-plans/${enrollmentId}/cancel`)
      .set(asTenant())
      .expect(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.cancelledAt).not.toBeNull();

    await agent.post(`/api/sos/customer-plans/${enrollmentId}/cancel`).set(asTenant()).expect(409);
    await agent.post(`/api/sos/customer-plans/${enrollmentId}/renew`).set(asTenant()).expect(409);

    const { transactions } = await getPlans(customerId);
    expect(transactions.some((t) => t.transactionType === "cancellation")).toBe(true);
  });

  it("packages are not renewable", async () => {
    const pkg = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({ name: `NoRenew ${RUN}`, planType: "package", price: 50, creditCount: 2 })
      .expect(201);
    planIds.push(pkg.body.id);
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: pkg.body.id })
      .expect(201);
    await agent.post(`/api/sos/customer-plans/${sold.body.id}/renew`).set(asTenant()).expect(409);
  });
});

describe("plan benefits at POS checkout", () => {
  let packagePlan: number;
  let membershipPlan: number;

  beforeAll(async () => {
    const pkg = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({ name: `POS Pack ${RUN}`, planType: "package", price: 90, creditCount: 2 })
      .expect(201);
    packagePlan = pkg.body.id;
    planIds.push(packagePlan);
    const mem = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({ name: `POS Mem ${RUN}`, planType: "membership", price: 45, discountPercent: 25 })
      .expect(201);
    membershipPlan = mem.body.id;
    planIds.push(membershipPlan);
  });

  it("redeeming a credit decrements the balance and ledgers the visit", async () => {
    const customerId = await createCustomer("Redeemer");
    const resourceId = await createResource("Chair R1");
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: packagePlan })
      .expect(201);
    const enrollmentId = sold.body.id;

    const visitId = await startVisit(customerId, resourceId);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        benefitCustomerPlanId: enrollmentId,
        benefitType: "redeem_credit",
      })
      .expect(200);

    const { plans, transactions } = await getPlans(customerId);
    expect(plans.find((p) => p.id === enrollmentId)!.remainingCredits).toBe(1);
    const redemption = transactions.find((t) => t.transactionType === "redemption");
    expect(redemption).toBeDefined();
    expect(redemption!.visitId).toBe(visitId);
    expect(redemption!.creditsDelta).toBe(-1);
    expect(redemption!.customerPlanId).toBe(enrollmentId);
  });

  it("returns 409 once credits hit zero and leaves the balance at zero", async () => {
    const customerId = await createCustomer("Zeroer");
    const resourceId = await createResource("Chair R2");
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: packagePlan })
      .expect(201);
    const enrollmentId = sold.body.id;

    // Spend both credits.
    for (let i = 0; i < 2; i++) {
      const visitId = await startVisit(customerId, resourceId);
      await agent
        .post(`/api/sos/visits/${visitId}/advance`)
        .set(asTenant())
        .send({
          action: "check_out",
          benefitCustomerPlanId: enrollmentId,
          benefitType: "redeem_credit",
        })
        .expect(200);
      await resetResource(resourceId);
    }

    // Third redemption must 409 and never drive the balance negative.
    const visitId = await startVisit(customerId, resourceId);
    const res = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        benefitCustomerPlanId: enrollmentId,
        benefitType: "redeem_credit",
      });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no credits/i);

    const { plans, transactions } = await getPlans(customerId);
    expect(plans.find((p) => p.id === enrollmentId)!.remainingCredits).toBe(0);
    expect(
      transactions.filter(
        (t) => t.transactionType === "redemption" && t.customerPlanId === enrollmentId,
      ),
    ).toHaveLength(2);
  });

  it("never double-spends the last credit under concurrent checkouts", async () => {
    const customerId = await createCustomer("Racer");
    const resA = await createResource("Chair Race A");
    const resB = await createResource("Chair Race B");
    // A 1-credit pass and two visits in service at once.
    const onePack = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({ name: `1-Pack ${RUN}`, planType: "package", price: 40, creditCount: 1 })
      .expect(201);
    planIds.push(onePack.body.id);
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: onePack.body.id })
      .expect(201);
    const enrollmentId = sold.body.id;

    const visitA = await startVisit(customerId, resA);
    const visitB = await startVisit(customerId, resB);
    const [ra, rb] = await Promise.all([
      agent.post(`/api/sos/visits/${visitA}/advance`).set(asTenant()).send({
        action: "check_out",
        benefitCustomerPlanId: enrollmentId,
        benefitType: "redeem_credit",
      }),
      agent.post(`/api/sos/visits/${visitB}/advance`).set(asTenant()).send({
        action: "check_out",
        benefitCustomerPlanId: enrollmentId,
        benefitType: "redeem_credit",
      }),
    ]);
    // Exactly one wins; the other hits the conditional-decrement guard.
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);

    const { plans, transactions } = await getPlans(customerId);
    expect(plans.find((p) => p.id === enrollmentId)!.remainingCredits).toBe(0);
    expect(
      transactions.filter(
        (t) => t.transactionType === "redemption" && t.customerPlanId === enrollmentId,
      ),
    ).toHaveLength(1);
  });

  it("applies a membership discount and ledgers the discounted payment", async () => {
    const customerId = await createCustomer("Discounter");
    const resourceId = await createResource("Chair D1");
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: membershipPlan })
      .expect(201);
    const enrollmentId = sold.body.id;

    const visitId = await startVisit(customerId, resourceId);
    const out = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        paymentAmount: 75,
        benefitCustomerPlanId: enrollmentId,
        benefitType: "membership_discount",
      })
      .expect(200);
    expect(out.body.paymentAmount).toBe(75);

    const { plans, transactions } = await getPlans(customerId);
    // Discounts never touch credits.
    expect(plans.find((p) => p.id === enrollmentId)!.remainingCredits).toBeNull();
    const discount = transactions.find((t) => t.transactionType === "discount");
    expect(discount).toBeDefined();
    expect(discount!.visitId).toBe(visitId);
    expect(discount!.amount).toBe(75);
    expect(discount!.note).toContain("25%");
  });

  it("rejects mismatched benefit types and cancelled enrollments", async () => {
    const customerId = await createCustomer("Mismatcher");
    const resourceId = await createResource("Chair M1");
    const [pkgSold, memSold] = [
      await agent
        .post("/api/sos/customer-plans")
        .set(asTenant())
        .send({ customerId, planId: packagePlan })
        .expect(201),
      await agent
        .post("/api/sos/customer-plans")
        .set(asTenant())
        .send({ customerId, planId: membershipPlan })
        .expect(201),
    ];

    // redeem_credit on a membership → 409; discount on a package → 409.
    let visitId = await startVisit(customerId, resourceId);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        benefitCustomerPlanId: memSold.body.id,
        benefitType: "redeem_credit",
      })
      .expect(409);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        benefitCustomerPlanId: pkgSold.body.id,
        benefitType: "membership_discount",
      })
      .expect(409);

    // Cancelled enrollment → 409, and the untouched balance stays intact.
    await agent
      .post(`/api/sos/customer-plans/${pkgSold.body.id}/cancel`)
      .set(asTenant())
      .expect(200);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        benefitCustomerPlanId: pkgSold.body.id,
        benefitType: "redeem_credit",
      })
      .expect(409);

    // Another customer's enrollment is invisible to this visit.
    const stranger = await createCustomer("Stranger");
    const strangerSold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId: stranger, planId: packagePlan })
      .expect(201);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        benefitCustomerPlanId: strangerSold.body.id,
        benefitType: "redeem_credit",
      })
      .expect(404);

    const { plans } = await getPlans(customerId);
    expect(plans.find((p) => p.id === pkgSold.body.id)!.remainingCredits).toBe(2);

    // A failed benefit never checked the visit out — it can still complete.
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({ action: "check_out", paymentAmount: 20 })
      .expect(200);
  });
});

describe("lapsed memberships stop granting the discount", () => {
  let membershipPlan: number;

  beforeAll(async () => {
    const mem = await agent
      .post("/api/sos/plans")
      .set(asTenant())
      .send({ name: `Lapse Mem ${RUN}`, planType: "membership", price: 30, discountPercent: 20 })
      .expect(201);
    membershipPlan = mem.body.id;
    planIds.push(membershipPlan);
  });

  async function sellAndBackdate(customerId: number, daysPast: number) {
    const sold = await agent
      .post("/api/sos/customer-plans")
      .set(asTenant())
      .send({ customerId, planId: membershipPlan })
      .expect(201);
    await db
      .update(sosCustomerPlansTable)
      .set({ renewsAt: new Date(Date.now() - daysPast * 24 * 60 * 60 * 1000) })
      .where(eq(sosCustomerPlansTable.id, sold.body.id));
    return sold.body.id as number;
  }

  it("rejects the discount once the renewal date is past the grace period", async () => {
    const customerId = await createCustomer("Lapsed");
    const resourceId = await createResource("Chair L1");
    const enrollmentId = await sellAndBackdate(customerId, 10);

    const visitId = await startVisit(customerId, resourceId);
    const res = await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        paymentAmount: 50,
        benefitCustomerPlanId: enrollmentId,
        benefitType: "membership_discount",
      });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/past due/i);

    // No discount was ledgered and the visit is still checkout-able.
    const { transactions } = await getPlans(customerId);
    expect(
      transactions.filter(
        (t) => t.transactionType === "discount" && t.customerPlanId === enrollmentId,
      ),
    ).toHaveLength(0);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({ action: "check_out", paymentAmount: 50 })
      .expect(200);
  });

  it("still honors the discount within the 3-day grace period", async () => {
    const customerId = await createCustomer("Grace");
    const resourceId = await createResource("Chair L2");
    const enrollmentId = await sellAndBackdate(customerId, 1);

    const visitId = await startVisit(customerId, resourceId);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        paymentAmount: 40,
        benefitCustomerPlanId: enrollmentId,
        benefitType: "membership_discount",
      })
      .expect(200);
    const { transactions } = await getPlans(customerId);
    expect(
      transactions.find(
        (t) => t.transactionType === "discount" && t.customerPlanId === enrollmentId,
      ),
    ).toBeDefined();
  });

  it("surfaces past_due on the customer plans list as soon as renewal lapses", async () => {
    const customerId = await createCustomer("PastDueViewer");
    const enrollmentId = await sellAndBackdate(customerId, 1);
    const { plans } = await getPlans(customerId);
    expect(plans.find((p) => p.id === enrollmentId)!.status).toBe("past_due");
  });

  it("renewing a lapsed membership restores the discount", async () => {
    const customerId = await createCustomer("Reviver");
    const resourceId = await createResource("Chair L3");
    const enrollmentId = await sellAndBackdate(customerId, 10);

    await agent.post(`/api/sos/customer-plans/${enrollmentId}/renew`).set(asTenant()).expect(200);

    const { plans } = await getPlans(customerId);
    expect(plans.find((p) => p.id === enrollmentId)!.status).toBe("active");

    const visitId = await startVisit(customerId, resourceId);
    await agent
      .post(`/api/sos/visits/${visitId}/advance`)
      .set(asTenant())
      .send({
        action: "check_out",
        paymentAmount: 60,
        benefitCustomerPlanId: enrollmentId,
        benefitType: "membership_discount",
      })
      .expect(200);
  });
});
