import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  sosCustomersTable,
  sosVisitsTable,
  merchantCoopPartnershipsTable,
  coopEventsTable,
  coopMonthlyReportsTable,
  messagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  generateCoopMonthlyReports,
  partnerPerformanceForTenant,
  priorMonthKey,
  monthBounds,
} from "../../lib/coopEvents";

// ---------------------------------------------------------------------------
// Co-op analytics & monthly ROI reporting against the real dev DB. Covers:
// event recording at each touchpoint (perk impressions on /coop/perks and the
// public landing perks endpoint, claims on code validation, claim+crossover
// on pass redemption, revenue attribution at visit checkout), per-partner
// aggregation math including sent-vs-received direction, monthly report
// idempotency (no duplicate reports/notifications on re-run), and strict
// tenant scoping of the analytics endpoints.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopan-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let cafeId: number; // host of the perk
let gymId: number; // partner
let otherId: number; // unrelated tenant for scoping checks
let partnershipId: number;
let redemptionCode: string;

const eventCount = async (
  tenantId: number,
  eventType: string,
): Promise<number> => {
  const rows = await db
    .select({ id: coopEventsTable.id })
    .from(coopEventsTable)
    .where(
      and(
        eq(coopEventsTable.tenantId, tenantId),
        eq(coopEventsTable.partnershipId, partnershipId),
        eq(coopEventsTable.eventType, eventType),
      ),
    );
  return rows.length;
};

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
      { brandName: `An Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `An Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `An Other ${RUN}`, subdomain: `${RUN}-other`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [cafeId, gymId, otherId] = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    { tenantId: cafeId, industryType: "restaurant", businessCategory: `Cafe-${RUN}`, publicPhone: "+15551230001" },
    { tenantId: gymId, industryType: "fitness", businessCategory: `Gym-${RUN}` },
  ]);

  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId: cafeId,
      partnerTenantId: gymId,
      perkTitle: `Free espresso ${RUN}`,
      redemptionCode: `COOP-${RUN}`,
      status: "accepted",
      isActive: true,
    })
    .returning();
  partnershipId = p.id;
  redemptionCode = p.redemptionCode;
});

afterAll(async () => {
  const ids = [cafeId, gymId, otherId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up settings, partnerships, events, reports, customers.
    await db.delete(messagesTable).where(inArray(messagesTable.tenantId, ids));
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("co-op event recording at each touchpoint", () => {
  it("records one impression per perk served on /coop/perks", async () => {
    const before = await eventCount(cafeId, "impression");
    await agent.get("/api/coop/perks").set("x-tenant-id", String(cafeId)).expect(200);
    expect(await eventCount(cafeId, "impression")).toBe(before + 1);
  });

  it("records impressions for the public landing perks endpoint", async () => {
    const before = await eventCount(gymId, "impression");
    const res = await request((await import("../../app")).default)
      .get(`/api/public/landing/${RUN}-gym/perks`)
      .expect(200);
    // Public payload never includes internal analytics ids or codes.
    expect(res.body.perks[0]).toEqual({
      perkTitle: `Free espresso ${RUN}`,
      perkDescription: null,
      partnerBusinessName: `An Cafe ${RUN}`,
    });
    expect(await eventCount(gymId, "impression")).toBe(before + 1);
  });

  it("records a claim when a redemption code is validated at checkout", async () => {
    const before = await eventCount(cafeId, "claim");
    const res = await agent
      .get(`/api/coop/redemptions/${redemptionCode}`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(await eventCount(cafeId, "claim")).toBe(before + 1);
  });

  it("does not record a claim for an invalid code", async () => {
    const before = await eventCount(cafeId, "claim");
    const res = await agent
      .get(`/api/coop/redemptions/NOPE-${RUN}`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(await eventCount(cafeId, "claim")).toBe(before);
  });

  it("records claim + crossover when a pass is redeemed, then attributes checkout revenue", async () => {
    const claimsBefore = await eventCount(cafeId, "claim");
    const crossBefore = await eventCount(cafeId, "crossover");
    const redeemed = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(cafeId))
      .send({ code: redemptionCode, passCode: `PASS-${RUN}-1` })
      .expect(200);
    expect(redeemed.body.valid).toBe(true);
    expect(await eventCount(cafeId, "claim")).toBe(claimsBefore + 1);
    expect(await eventCount(cafeId, "crossover")).toBe(crossBefore + 1);

    // The cross-over customer checks out at the cafe — revenue attaches.
    const [customer] = await db
      .insert(sosCustomersTable)
      .values({ tenantId: cafeId, name: `Crossover Customer ${RUN}`, smsOptIn: false })
      .returning();
    const [visit] = await db
      .insert(sosVisitsTable)
      .values({
        tenantId: cafeId,
        customerId: customer.id,
        status: "in_service",
        serviceType: `svc-${RUN}`,
        serviceStartedAt: new Date(),
      })
      .returning();
    await agent
      .post(`/api/sos/visits/${visit.id}/advance`)
      .set("x-tenant-id", String(cafeId))
      .send({ action: "check_out", paymentAmount: 42.5 })
      .expect(200);

    const [crossover] = await db
      .select()
      .from(coopEventsTable)
      .where(
        and(
          eq(coopEventsTable.tenantId, cafeId),
          eq(coopEventsTable.partnershipId, partnershipId),
          eq(coopEventsTable.eventType, "crossover"),
        ),
      );
    expect(crossover.revenueAmount).toBe("42.50");
  });
});

describe("per-partner performance aggregation", () => {
  it("aggregates with correct sent-vs-received direction for both sides", async () => {
    // Cafe side: impressions/claims recorded at the cafe; the crossover
    // happened AT the cafe, so the cafe RECEIVED a client and the gym SENT one.
    const cafeRows = await partnerPerformanceForTenant(cafeId);
    const cafeRow = cafeRows.find((r) => r.partnershipId === partnershipId)!;
    expect(cafeRow.partnerName).toBe(`An Gym ${RUN}`);
    expect(cafeRow.impressions).toBeGreaterThanOrEqual(1);
    expect(cafeRow.claims).toBe(2); // validate + redeem
    expect(cafeRow.clientsReceived).toBe(1);
    expect(cafeRow.clientsSent).toBe(0);
    expect(cafeRow.revenueInfluenced).toBe(42.5);

    const gymRows = await partnerPerformanceForTenant(gymId);
    const gymRow = gymRows.find((r) => r.partnershipId === partnershipId)!;
    expect(gymRow.partnerName).toBe(`An Cafe ${RUN}`);
    expect(gymRow.clientsSent).toBe(1);
    expect(gymRow.clientsReceived).toBe(0);
    expect(gymRow.revenueInfluenced).toBe(0);
  });

  it("serves the breakdown via the tenant-scoped endpoint and requires the header", async () => {
    await agent.get("/api/coop/analytics/partners").expect(400);
    const res = await agent
      .get("/api/coop/analytics/partners")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    const row = res.body.find(
      (r: { partnershipId: number }) => r.partnershipId === partnershipId,
    );
    expect(row).toBeTruthy();
    expect(row.clientsReceived).toBe(1);
  });

  it("a date range excluding the events returns zeros (not errors)", async () => {
    const res = await agent
      .get("/api/coop/analytics/partners")
      .query({ from: "1990-01-01T00:00:00.000Z", to: "1990-02-01T00:00:00.000Z" })
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    const row = res.body.find(
      (r: { partnershipId: number }) => r.partnershipId === partnershipId,
    );
    expect(row.impressions).toBe(0);
    expect(row.claims).toBe(0);
    expect(row.revenueInfluenced).toBe(0);
  });

  it("an unrelated tenant never sees this partnership's metrics", async () => {
    const res = await agent
      .get("/api/coop/analytics/partners")
      .set("x-tenant-id", String(otherId))
      .expect(200);
    expect(
      res.body.find((r: { partnershipId: number }) => r.partnershipId === partnershipId),
    ).toBeUndefined();
  });
});

describe("monthly impact report generation", () => {
  // Pin to a synthetic month so a concierge tick fired by another parallel
  // suite (which targets the real prior month) can never collide with the
  // report rows this test asserts on.
  const NOW = new Date("2001-03-15T12:00:00.000Z");
  const month = priorMonthKey(NOW); // "2001-02"

  it("aggregates the prior month per tenant, persists once, and notifies once (idempotent)", async () => {
    // Plant prior-month events for the cafe (unique to this run's tenants,
    // so parallel test runs never interfere).
    const { start } = monthBounds(month);
    const inMonth = new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000);
    await db.insert(coopEventsTable).values([
      { tenantId: cafeId, partnershipId, partnerTenantId: gymId, eventType: "impression", occurredAt: inMonth },
      { tenantId: cafeId, partnershipId, partnerTenantId: gymId, eventType: "impression", occurredAt: inMonth },
      { tenantId: cafeId, partnershipId, partnerTenantId: gymId, eventType: "claim", occurredAt: inMonth },
      { tenantId: cafeId, partnershipId, partnerTenantId: gymId, eventType: "crossover", revenueAmount: "30.00", occurredAt: inMonth },
    ]);

    const first = await generateCoopMonthlyReports(NOW);
    expect(first.month).toBe(month);

    const [report] = await db
      .select()
      .from(coopMonthlyReportsTable)
      .where(
        and(
          eq(coopMonthlyReportsTable.tenantId, cafeId),
          eq(coopMonthlyReportsTable.month, month),
        ),
      );
    expect(report.impressions).toBe(2);
    expect(report.claims).toBe(1);
    expect(report.crossoverVisits).toBe(1);
    expect(report.revenueInfluenced).toBe("30.00");

    const notifications = async () => {
      const rows = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.tenantId, cafeId),
            eq(messagesTable.kind, "coop_monthly_report"),
          ),
        );
      // Only this synthetic month's notification — a parallel-suite tick may
      // legitimately have generated the real prior month's report too.
      return rows.filter((r) => r.body.includes("February 2001"));
    };
    const afterFirst = await notifications();
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0].body).toContain("Co-Op impact report");
    // Simulated-SMS fallback: with no Twilio creds the send still records.
    expect(["sent", "delivered", "skipped", "simulated"]).toContain(afterFirst[0].status);

    // Re-run: no duplicate report, no duplicate notification.
    await generateCoopMonthlyReports(NOW);
    const reports = await db
      .select()
      .from(coopMonthlyReportsTable)
      .where(
        and(
          eq(coopMonthlyReportsTable.tenantId, cafeId),
          eq(coopMonthlyReportsTable.month, month),
        ),
      );
    expect(reports.length).toBe(1);
    expect((await notifications()).length).toBe(1);
  });

  it("a partnered tenant with zero prior-month events gets a zeros report", async () => {
    const [report] = await db
      .select()
      .from(coopMonthlyReportsTable)
      .where(
        and(
          eq(coopMonthlyReportsTable.tenantId, gymId),
          eq(coopMonthlyReportsTable.month, month),
        ),
      );
    expect(report).toBeTruthy();
    expect(report.impressions).toBe(0);
    expect(report.crossoverVisits).toBe(0);
  });

  it("serves reports via the tenant-scoped endpoint, never another tenant's", async () => {
    await agent.get("/api/coop/reports/monthly").expect(400);
    const res = await agent
      .get("/api/coop/reports/monthly")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    const mine = res.body.find((r: { month: string }) => r.month === month);
    expect(mine.impressions).toBe(2);
    expect(mine.revenueInfluenced).toBe(30);

    const other = await agent
      .get("/api/coop/reports/monthly")
      .set("x-tenant-id", String(otherId))
      .expect(200);
    expect(other.body).toEqual([]);
  });
});
