import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopFeedbackTable,
  coopSentimentReportsTable,
  perkPassesTable,
  messagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  parseFeedbackReply,
  handleInboundCoopFeedback,
  generateCoopSentimentReports,
  npsFrom,
  priorWeek,
  priorMonth,
} from "../../lib/coopFeedback";
import { analyzeFeedbackSentiment, fallbackSentiment } from "../../lib/coopSentiment";

// ---------------------------------------------------------------------------
// Co-op post-redemption feedback & sentiment analytics against the real dev
// DB. Covers: feedback request creation on wallet-pass redemption (and the
// outbound coop_feedback_request SMS), deterministic reply parsing, keyword
// fallback sentiment when the AI integration is unavailable, tenant scoping
// of the sentiment aggregates, and weekly/monthly insight-report idempotency
// (no duplicate reports per period on re-run). Report tests are pinned to a
// synthetic period (year 2001) so parallel concierge ticks can't collide.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
// Force the deterministic keyword fallback: this suite must pass with no AI.
delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

const RUN = `coopsent-${Date.now()}-${process.pid}`;
// Unique per-run phone so inbound reply matching can't hit another run's rows.
const PHONE = `+1555${String(Date.now()).slice(-7)}`;
const TOKEN = `WPASS-${RUN}`;

let agent: ReturnType<typeof request.agent>;
let cafeId: number; // host
let gymId: number; // partner (redeems here)
let otherId: number; // unrelated tenant for scoping checks
let partnershipId: number;

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
      { brandName: `Sn Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Sn Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Sn Other ${RUN}`, subdomain: `${RUN}-other`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [cafeId, gymId, otherId] = tenants.map((t) => t.id);

  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId: cafeId,
      partnerTenantId: gymId,
      perkTitle: `Free smoothie ${RUN}`,
      redemptionCode: `COOP-${RUN}`,
      status: "accepted",
      isActive: true,
    })
    .returning();
  partnershipId = p.id;

  // Wallet pass owned by our unique customer phone, redeemable at the gym.
  await db.insert(perkPassesTable).values({
    partnershipId,
    customerPhone: PHONE,
    customerName: "Pat Tester",
    grantedByTenantId: cafeId,
    token: TOKEN,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
});

afterAll(async () => {
  const ids = [cafeId, gymId, otherId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    await db.delete(messagesTable).where(inArray(messagesTable.tenantId, ids));
    // Cascades clean up partnerships, passes, redemptions, feedback, reports.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("feedback reply parsing (deterministic)", () => {
  it("parses rating, recommend flag, and free text", () => {
    expect(parseFeedbackReply("5 Y loved it")).toEqual({
      rating: 5,
      wouldRecommend: true,
      text: "loved it",
    });
    expect(parseFeedbackReply(" 3 no, too slow ")).toEqual({
      rating: 3,
      wouldRecommend: false,
      text: "too slow",
    });
    expect(parseFeedbackReply("4")).toEqual({ rating: 4, wouldRecommend: null, text: null });
  });

  it("never captures keyword or non-rating messages", () => {
    expect(parseFeedbackReply("STOP")).toBeNull();
    expect(parseFeedbackReply("YES")).toBeNull();
    expect(parseFeedbackReply("hello there")).toBeNull();
    expect(parseFeedbackReply("6 out of 5")).toBeNull();
    expect(parseFeedbackReply("")).toBeNull();
  });
});

describe("sentiment analysis fallback (AI unavailable)", () => {
  it("uses the deterministic keyword analyzer when no AI env is configured", async () => {
    const r = await analyzeFeedbackSentiment("The staff was so friendly, loved it!");
    expect(r.usedAi).toBe(false);
    expect(r.label).toBe("positive");
    expect(r.themes).toContain("staff friendliness");
  });

  it("classifies negative feedback with friction themes", () => {
    const r = fallbackSentiment("terrible — waited forever, rude staff and dirty tables");
    expect(r.label).toBe("negative");
    expect(r.score).toBeLessThan(0);
    expect(r.themes).toEqual(expect.arrayContaining(["wait time", "cleanliness"]));
  });
});

describe("feedback capture on redemption", () => {
  it("creates a feedback request and sends the follow-up SMS on wallet redemption", async () => {
    const res = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(gymId))
      .send({ code: TOKEN })
      .expect(200);
    expect(res.body.valid).toBe(true);

    const [fb] = await db
      .select()
      .from(coopFeedbackTable)
      .where(eq(coopFeedbackTable.customerPhone, PHONE));
    expect(fb).toBeDefined();
    expect(fb.partnershipId).toBe(partnershipId);
    expect(fb.tenantId).toBe(gymId);
    expect(fb.status).toBe("requested");

    const msgs = await db
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.tenantId, gymId), eq(messagesTable.kind, "coop_feedback_request")));
    expect(msgs.length).toBe(1);
    expect(msgs[0].toNumber).toBe(PHONE);
    expect(msgs[0].body).toContain("1-5");
  });

  it("completes the request from an inbound reply, with sentiment at ingestion", async () => {
    const handled = await handleInboundCoopFeedback(PHONE, "5 Y loved it, staff so friendly");
    expect(handled).toBe(true);

    const [fb] = await db
      .select()
      .from(coopFeedbackTable)
      .where(eq(coopFeedbackTable.customerPhone, PHONE));
    expect(fb.status).toBe("completed");
    expect(fb.rating).toBe(5);
    expect(fb.wouldRecommend).toBe(true);
    expect(fb.feedbackText).toContain("loved it");
    expect(fb.sentimentLabel).toBe("positive");
    expect(fb.sentimentUsedAi).toBe(false);
    expect(fb.themes).toContain("staff friendliness");
    expect(fb.respondedAt).not.toBeNull();
  });

  it("ignores replies with no open feedback request", async () => {
    expect(await handleInboundCoopFeedback("+15550000000", "5 Y great")).toBe(false);
    // Already-completed request doesn't match again.
    expect(await handleInboundCoopFeedback(PHONE, "1 N bad")).toBe(false);
  });
});

describe("sentiment aggregates & tenant scoping", () => {
  it("aggregates per partnership and network-wide for a participant", async () => {
    const res = await agent
      .get("/api/coop/sentiment/summary")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(res.body.totalResponses).toBe(1);
    expect(res.body.networkAvgRating).toBe(5);
    expect(res.body.networkNps).toBe(100);
    expect(res.body.positive).toBe(1);
    expect(res.body.praiseThemes).toContain("staff friendliness");
    const row = res.body.partnerships.find(
      (p: { partnershipId: number }) => p.partnershipId === partnershipId,
    );
    expect(row).toBeDefined();
    expect(row.responses).toBe(1);
    expect(row.avgRating).toBe(5);
    expect(row.nps).toBe(100);
    // Repeat-visit rate from redemption history: one customer, one visit.
    expect(row.repeatVisitRate).toBe(0);
    // Raw customer identity never appears in the aggregate payload.
    expect(JSON.stringify(res.body)).not.toContain(PHONE);
  });

  it("shows nothing to a tenant outside the partnership", async () => {
    const res = await agent
      .get("/api/coop/sentiment/summary")
      .set("x-tenant-id", String(otherId))
      .expect(200);
    expect(res.body.totalResponses).toBe(0);
    expect(
      res.body.partnerships.find((p: { partnershipId: number }) => p.partnershipId === partnershipId),
    ).toBeUndefined();
  });

  it("requires the x-tenant-id header", async () => {
    await agent.get("/api/coop/sentiment/summary").expect(400);
    await agent.get("/api/coop/sentiment/reports").expect(400);
  });
});

describe("insight report generation (weekly + monthly, idempotent)", () => {
  // Synthetic clock: Monday 2001-01-08 → prior week = 2001-W01 (Jan 1-7),
  // prior month = 2000-12. No other suite generates reports in year 2001.
  const NOW = new Date("2001-01-08T12:00:00Z");

  it("generates ranked weekly and monthly reports with recommendations", async () => {
    // Place the completed response inside BOTH the prior week and give the
    // monthly period its own datapoint.
    await db
      .update(coopFeedbackTable)
      .set({ respondedAt: new Date("2001-01-03T10:00:00Z") })
      .where(eq(coopFeedbackTable.customerPhone, PHONE));

    const week = priorWeek(NOW);
    const month = priorMonth(NOW);
    expect(week.key).toBe("2001-W01");
    expect(month.key).toBe("2000-12");

    await generateCoopSentimentReports(NOW);

    // Both sides of the partnership get their own weekly report.
    const reports = await db
      .select()
      .from(coopSentimentReportsTable)
      .where(inArray(coopSentimentReportsTable.tenantId, [cafeId, gymId]));
    const weekly = reports.filter((r) => r.periodType === "weekly" && r.periodKey === "2001-W01");
    expect(weekly.map((r) => r.tenantId).sort()).toEqual([cafeId, gymId].sort());
    // No monthly report: the response wasn't in 2000-12 (no empty-report spam).
    expect(reports.filter((r) => r.periodType === "monthly").length).toBe(0);

    const cafeWeekly = weekly.find((r) => r.tenantId === cafeId)!;
    expect(cafeWeekly.rankings.length).toBeGreaterThan(0);
    expect(cafeWeekly.rankings[0].partnershipId).toBe(partnershipId);
    expect(cafeWeekly.rankings[0].avgRating).toBe(5);
    expect(cafeWeekly.summary).toContain("strongest pairing");
    expect(cafeWeekly.summary).toContain(`Sn Gym ${RUN}`);
  });

  it("is idempotent — a re-run never duplicates a period's reports", async () => {
    const before = await db
      .select({ id: coopSentimentReportsTable.id })
      .from(coopSentimentReportsTable)
      .where(inArray(coopSentimentReportsTable.tenantId, [cafeId, gymId]));
    await generateCoopSentimentReports(NOW);
    const after = await db
      .select({ id: coopSentimentReportsTable.id })
      .from(coopSentimentReportsTable)
      .where(inArray(coopSentimentReportsTable.tenantId, [cafeId, gymId]));
    expect(after.length).toBe(before.length);
  });

  it("serves the reports to the merchant, newest first", async () => {
    const res = await agent
      .get("/api/coop/sentiment/reports")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    const weekly = res.body.find(
      (r: { periodType: string; periodKey: string }) =>
        r.periodType === "weekly" && r.periodKey === "2001-W01",
    );
    expect(weekly).toBeDefined();
    expect(weekly.rankings[0].partnerName).toBe(`Sn Gym ${RUN}`);
    // Reports are tenant-scoped: the outsider sees none.
    const outsider = await agent
      .get("/api/coop/sentiment/reports")
      .set("x-tenant-id", String(otherId))
      .expect(200);
    expect(outsider.body).toEqual([]);
  });

  it("nps helper follows the promoter/detractor math", () => {
    expect(npsFrom(0, 0)).toBeNull();
    expect(npsFrom(3, 1)).toBe(50);
    expect(npsFrom(0, 2)).toBe(-100);
  });
});
