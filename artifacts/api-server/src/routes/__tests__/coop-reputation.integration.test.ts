import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopPartnerRatingsTable,
  coopReputationStatesTable,
  coopReputationEventsTable,
  messagesTable,
} from "@workspace/db";
import {
  computeReputations,
  runReputationEnforcement,
  REPUTATION_MIN_RATERS,
  REPUTATION_FLAG_THRESHOLD,
  REPUTATION_GRACE_MS,
} from "../../lib/coopReputation";

// ── Co-op Review & Reputation Shield ─────────────────────────────────────────
// Internal B2B rating loop: submission/update rules, recency-weighted score
// with a minimum-rater floor, the flag → grace → decouple → reinstate
// lifecycle, exclusion of decoupled tenants from directory/perk/redemption
// reads, and that no public surface ever leaks B2B rating data.

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `cooprep-${Date.now()}-${process.pid}`;

let agent: TestAgent;
let salonId = 0; // rater 1
let cafeId = 0; // rated business (goes bad, then recovers)
let gymId = 0; // rater 2
let floristId = 0; // outsider (no partnership with cafe)
let salonCafePartnershipId = 0;
let salonCafeCode = "";
let gymCafePartnershipId = 0;

async function createPartnership(
  hostTenantId: number,
  partnerTenantId: number,
  suffix: string,
): Promise<{ id: number; code: string }> {
  const code = `REP-${RUN}-${suffix}`.toUpperCase().slice(0, 40);
  const [p] = await db
    .insert(merchantCoopPartnershipsTable)
    .values({
      hostTenantId,
      partnerTenantId,
      // Deliberately avoid rating-related words: the leak tests below assert
      // markers like "reputation" never appear on public surfaces.
      perkTitle: `Crossover treat ${RUN} ${suffix}`,
      redemptionCode: code,
      status: "accepted",
      isActive: true,
    })
    .returning({ id: merchantCoopPartnershipsTable.id });
  return { id: p.id, code };
}

const rate = (
  tenantId: number,
  partnershipId: number,
  body: Record<string, unknown>,
) =>
  agent
    .put(`/api/coop/partnerships/${partnershipId}/rating`)
    .set("x-tenant-id", String(tenantId))
    .send(body);

const lowMarks = { reliability: 1, professionalism: 2, trafficValue: 1 };
const highMarks = { reliability: 5, professionalism: 5, trafficValue: 5 };

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
      { brandName: `Rep Salon ${RUN}`, subdomain: `${RUN}-salon`, status: "active" },
      { brandName: `Rep Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Rep Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Rep Florist ${RUN}`, subdomain: `${RUN}-florist`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [salonId, cafeId, gymId, floristId] = tenants.map((t) => t.id);

  // The rated business has a public phone so shield alerts have a recipient,
  // and a landing slug so the public landing page can be probed for leaks.
  await db.insert(sosSettingsTable).values([
    { tenantId: cafeId, industryType: "restaurant", publicPhone: "+15550002222" },
  ]);

  const p1 = await createPartnership(salonId, cafeId, "sc");
  salonCafePartnershipId = p1.id;
  salonCafeCode = p1.code;
  const p2 = await createPartnership(gymId, cafeId, "gc");
  gymCafePartnershipId = p2.id;
});

afterAll(async () => {
  const ids = [salonId, cafeId, gymId, floristId].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
});

describe("rating submission rules", () => {
  it("rejects a tenant that is not a party to the partnership", async () => {
    await rate(floristId, salonCafePartnershipId, highMarks).expect(403);
  });

  it("rejects out-of-range stars and missing dimensions", async () => {
    await rate(salonId, salonCafePartnershipId, { reliability: 0, professionalism: 3, trafficValue: 3 }).expect(400);
    await rate(salonId, salonCafePartnershipId, { reliability: 6, professionalism: 3, trafficValue: 3 }).expect(400);
    await rate(salonId, salonCafePartnershipId, { reliability: 3 }).expect(400);
  });

  it("rejects rating a non-accepted partnership", async () => {
    const { id } = await createPartnership(salonId, cafeId, "pend");
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ status: "pending" })
      .where(eq(merchantCoopPartnershipsTable.id, id));
    await rate(salonId, id, highMarks).expect(409);
  });

  it("submits, then updates the same current rating within the rolling period", async () => {
    const first = await rate(salonId, salonCafePartnershipId, {
      ...highMarks,
      comment: "Great partner so far.",
    }).expect(200);
    expect(first.body.raterTenantId).toBe(salonId);
    expect(first.body.ratedTenantId).toBe(cafeId);
    expect(first.body.reliability).toBe(5);

    const second = await rate(salonId, salonCafePartnershipId, {
      ...lowMarks,
      comment: "They started refusing valid perks.",
    }).expect(200);
    // Same rolling period → same rating row updated, not a new one.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.reliability).toBe(1);

    const rows = await db
      .select()
      .from(coopPartnerRatingsTable)
      .where(
        and(
          eq(coopPartnerRatingsTable.raterTenantId, salonId),
          eq(coopPartnerRatingsTable.ratedTenantId, cafeId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].isCurrent).toBe(true);
  });

  it("a new rolling period supersedes the old rating instead of updating it", async () => {
    // Age the current rating past the rolling period.
    const old = new Date(Date.now() - 40 * 86_400_000);
    await db
      .update(coopPartnerRatingsTable)
      .set({ createdAt: old, updatedAt: old })
      .where(
        and(
          eq(coopPartnerRatingsTable.raterTenantId, salonId),
          eq(coopPartnerRatingsTable.ratedTenantId, cafeId),
          eq(coopPartnerRatingsTable.isCurrent, true),
        ),
      );
    const res = await rate(salonId, salonCafePartnershipId, lowMarks).expect(200);
    const rows = await db
      .select()
      .from(coopPartnerRatingsTable)
      .where(
        and(
          eq(coopPartnerRatingsTable.raterTenantId, salonId),
          eq(coopPartnerRatingsTable.ratedTenantId, cafeId),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(rows.find((r) => r.isCurrent)!.id).toBe(res.body.id);
  });
});

describe("score computation", () => {
  it("returns no score below the minimum-rater floor", async () => {
    // Only the salon has rated the cafe so far (min raters is >= 2).
    expect(REPUTATION_MIN_RATERS).toBeGreaterThanOrEqual(2);
    const computed = await computeReputations([cafeId]);
    const c = computed.get(cafeId)!;
    expect(c.raterCount).toBe(1);
    expect(c.score).toBeNull();
    expect(c.dimensions).toBeNull();
  });

  it("computes a recency-weighted average across dimensions once the floor is met", async () => {
    await rate(gymId, gymCafePartnershipId, lowMarks).expect(200);
    const computed = await computeReputations([cafeId]);
    const c = computed.get(cafeId)!;
    expect(c.raterCount).toBe(2);
    expect(c.score).not.toBeNull();
    // Both current ratings are all-low marks → score in the low band.
    expect(c.score!).toBeLessThan(REPUTATION_FLAG_THRESHOLD);
    expect(c.dimensions!.reliability).toBeLessThanOrEqual(c.dimensions!.professionalism);
  });

  it("weights recent ratings more than old ones", async () => {
    // A fresh 5-star and a very old 1-star from two raters → score above the
    // unweighted midpoint of 3.
    const now = new Date();
    const ratings = await db
      .select()
      .from(coopPartnerRatingsTable)
      .where(and(eq(coopPartnerRatingsTable.ratedTenantId, cafeId), eq(coopPartnerRatingsTable.isCurrent, true)));
    const salonRating = ratings.find((r) => r.raterTenantId === salonId)!;
    const gymRating = ratings.find((r) => r.raterTenantId === gymId)!;
    await db
      .update(coopPartnerRatingsTable)
      .set({ reliability: 5, professionalism: 5, trafficValue: 5, updatedAt: now })
      .where(eq(coopPartnerRatingsTable.id, salonRating.id));
    const old = new Date(now.getTime() - 120 * 86_400_000);
    await db
      .update(coopPartnerRatingsTable)
      .set({ reliability: 1, professionalism: 1, trafficValue: 1, updatedAt: old })
      .where(eq(coopPartnerRatingsTable.id, gymRating.id));

    const computed = await computeReputations([cafeId], now);
    expect(computed.get(cafeId)!.score!).toBeGreaterThan(3);

    // Restore both to low marks for the lifecycle tests below.
    await db
      .update(coopPartnerRatingsTable)
      .set({ reliability: 1, professionalism: 2, trafficValue: 1, updatedAt: now })
      .where(inArray(coopPartnerRatingsTable.id, [salonRating.id, gymRating.id]));
  });

  it("serves aggregates through the internal reputation overview", async () => {
    const res = await agent
      .get("/api/coop/reputation")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    const partner = res.body.partners.find((p: { tenantId: number }) => p.tenantId === cafeId);
    expect(partner).toBeDefined();
    expect(partner.sufficient).toBe(true);
    expect(partner.score).toBeLessThan(REPUTATION_FLAG_THRESHOLD);
    expect(partner.dimensions.reliability).toBeGreaterThanOrEqual(1);
    expect(partner.myRating.raterTenantId).toBe(salonId);
  });
});

describe("flag → grace → decouple → reinstate lifecycle", () => {
  it("flags a tenant below threshold and alerts the owner", async () => {
    const result = await runReputationEnforcement();
    expect(result.flagged).toBeGreaterThanOrEqual(1);

    const [state] = await db
      .select()
      .from(coopReputationStatesTable)
      .where(eq(coopReputationStatesTable.tenantId, cafeId));
    expect(state.status).toBe("flagged");
    expect(state.flaggedAt).not.toBeNull();

    const events = await db
      .select()
      .from(coopReputationEventsTable)
      .where(eq(coopReputationEventsTable.tenantId, cafeId));
    expect(events.some((e) => e.eventType === "flagged")).toBe(true);

    const alerts = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.tenantId, cafeId));
    const alert = alerts.find((m) => m.kind === "coop_reputation");
    expect(alert).toBeDefined();
    expect(alert!.status).not.toBe("failed");
  });

  it("does not decouple while the grace window is open", async () => {
    await runReputationEnforcement();
    const [state] = await db
      .select()
      .from(coopReputationStatesTable)
      .where(eq(coopReputationStatesTable.tenantId, cafeId));
    expect(state.status).toBe("flagged");
  });

  it("flagged status is visible in the merchant hub overview", async () => {
    const res = await agent
      .get("/api/coop/reputation")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    const partner = res.body.partners.find((p: { tenantId: number }) => p.tenantId === cafeId);
    expect(partner.status).toBe("flagged");
  });

  it("decouples after the grace window: partnerships off, hidden everywhere", async () => {
    // Push the flag time past the grace window, then tick.
    await db
      .update(coopReputationStatesTable)
      .set({ flaggedAt: new Date(Date.now() - REPUTATION_GRACE_MS - 60_000) })
      .where(eq(coopReputationStatesTable.tenantId, cafeId));
    const result = await runReputationEnforcement();
    expect(result.decoupled).toBeGreaterThanOrEqual(1);

    const [state] = await db
      .select()
      .from(coopReputationStatesTable)
      .where(eq(coopReputationStatesTable.tenantId, cafeId));
    expect(state.status).toBe("decoupled");
    expect(state.decoupledAt).not.toBeNull();

    // Accepted partnerships were deactivated, and the event recorded which.
    const partnerships = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(inArray(merchantCoopPartnershipsTable.id, [salonCafePartnershipId, gymCafePartnershipId]));
    expect(partnerships.every((p) => !p.isActive)).toBe(true);
    const events = await db
      .select()
      .from(coopReputationEventsTable)
      .where(
        and(
          eq(coopReputationEventsTable.tenantId, cafeId),
          eq(coopReputationEventsTable.eventType, "decoupled"),
        ),
      );
    expect(events).toHaveLength(1);
    const ids = (events[0].details as { partnershipIds: number[] }).partnershipIds;
    expect(ids).toEqual(expect.arrayContaining([salonCafePartnershipId, gymCafePartnershipId]));

    // Hidden from directory + suggestions, perks stop serving, codes fail.
    const dir = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(dir.body.some((e: { id: number }) => e.id === cafeId)).toBe(false);

    const sugg = await agent
      .get("/api/coop/suggestions")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(sugg.body.some((s: { tenantId: number }) => s.tenantId === cafeId)).toBe(false);

    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(perks.body.perks.some((k: { id: number }) => k.id === salonCafePartnershipId)).toBe(false);

    const validate = await agent.get(`/api/coop/redemptions/${salonCafeCode}`).expect(200);
    expect(validate.body.valid).toBe(false);

    const redeem = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(salonId))
      .send({ code: salonCafeCode, passCode: `P-${RUN}` })
      .expect(200);
    expect(redeem.body.valid).toBe(false);
  });

  it("admin lists the decoupled tenant with its audited score history", async () => {
    const res = await agent.get("/api/admin/coop/reputation").expect(200);
    const entry = res.body.find((e: { tenantId: number }) => e.tenantId === cafeId);
    expect(entry).toBeDefined();
    expect(entry.status).toBe("decoupled");
    const types = entry.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(["flagged", "decoupled"]));
    for (const e of entry.events) expect(e.createdAt).toBeTruthy();
  });

  it("admin reinstates: partnerships reactivated, directory visibility restored, audited", async () => {
    // Reinstating a non-decoupled tenant is rejected.
    await agent.post(`/api/admin/coop/reputation/${salonId}/reinstate`).expect(404);

    const res = await agent
      .post(`/api/admin/coop/reputation/${cafeId}/reinstate`)
      .expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.decoupledAt).toBeNull();
    expect(
      res.body.events.some((e: { eventType: string }) => e.eventType === "reinstated"),
    ).toBe(true);

    const partnerships = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(inArray(merchantCoopPartnershipsTable.id, [salonCafePartnershipId, gymCafePartnershipId]));
    expect(partnerships.every((p) => p.isActive)).toBe(true);

    const dir = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    expect(dir.body.some((e: { id: number }) => e.id === cafeId)).toBe(true);

    // A second reinstate is a conflict.
    await agent.post(`/api/admin/coop/reputation/${cafeId}/reinstate`).expect(409);
  });

  it("clears a flag automatically when the score recovers", async () => {
    // Raise both current ratings to high marks and re-flag first.
    await db
      .update(coopPartnerRatingsTable)
      .set({ reliability: 1, professionalism: 1, trafficValue: 1, updatedAt: new Date() })
      .where(and(eq(coopPartnerRatingsTable.ratedTenantId, cafeId), eq(coopPartnerRatingsTable.isCurrent, true)));
    let result = await runReputationEnforcement();
    expect(result.flagged).toBeGreaterThanOrEqual(1);

    await db
      .update(coopPartnerRatingsTable)
      .set({ reliability: 5, professionalism: 5, trafficValue: 5, updatedAt: new Date() })
      .where(and(eq(coopPartnerRatingsTable.ratedTenantId, cafeId), eq(coopPartnerRatingsTable.isCurrent, true)));
    result = await runReputationEnforcement();
    expect(result.cleared).toBeGreaterThanOrEqual(1);

    const [state] = await db
      .select()
      .from(coopReputationStatesTable)
      .where(eq(coopReputationStatesTable.tenantId, cafeId));
    expect(state.status).toBe("ok");
    expect(state.flaggedAt).toBeNull();

    const events = await db
      .select()
      .from(coopReputationEventsTable)
      .where(
        and(
          eq(coopReputationEventsTable.tenantId, cafeId),
          eq(coopReputationEventsTable.eventType, "flag_cleared"),
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

describe("no public leakage of B2B rating data", () => {
  const RATING_MARKERS = [
    "reliability",
    "professionalism",
    "trafficValue",
    "traffic_value",
    "reputation",
    "raterCount",
    "rater_tenant",
  ];

  it("the public landing page HTML contains no B2B rating data", async () => {
    const res = await agent.get(`/api/public/landing/${RUN}-cafe`).expect(200);
    const html = String(res.text).toLowerCase();
    for (const marker of RATING_MARKERS) {
      expect(html).not.toContain(marker.toLowerCase());
    }
  });

  it("the public perks endpoint emits no B2B rating fields", async () => {
    const res = await agent.get(`/api/public/landing/${RUN}-cafe/perks`).expect(200);
    const raw = JSON.stringify(res.body).toLowerCase();
    for (const marker of RATING_MARKERS) {
      expect(raw).not.toContain(marker.toLowerCase());
    }
  });

  it("the tenant-facing perks endpoint carries no rating data", async () => {
    const res = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(salonId))
      .expect(200);
    const raw = JSON.stringify(res.body).toLowerCase();
    for (const marker of ["reliability", "professionalism", "trafficvalue", "reputation"]) {
      expect(raw).not.toContain(marker);
    }
  });

  it("rating endpoints require tenant scope (no anonymous access)", async () => {
    await agent.put(`/api/coop/partnerships/${salonCafePartnershipId}/rating`).send(highMarks).expect(400);
    await agent.get("/api/coop/reputation").expect(400);
  });

  it("the customer review system is untouched — sos_reviews has no rows for these tenants", async () => {
    const { sosReviewsTable } = await import("@workspace/db");
    const rows = await db
      .select()
      .from(sosReviewsTable)
      .where(inArray(sosReviewsTable.tenantId, [salonId, cafeId, gymId]));
    expect(rows).toHaveLength(0);
  });
});
