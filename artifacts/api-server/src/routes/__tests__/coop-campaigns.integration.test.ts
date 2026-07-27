import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  merchantCoopPartnershipsTable,
  coopCampaignsTable,
  coopCampaignBlastsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Promotional Campaign & Seasonal Blast (/coop/campaigns) against the
// real dev DB. Covers: partnership-gated creation (and partner-only invitee
// rule), the uniform window applied identically to every participant,
// join/decline flow with double-respond guards, the joint blast with rolling
// 7-day network-wide frequency capping and sent/capped/skipped summary,
// flash-perk exposure on /coop/perks only inside the window, and tenant
// isolation. SMS is simulated (Twilio env removed below).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopcamp-${Date.now()}-${process.pid}`;
// Unique per-run phone block so frequency-cap rows never collide across runs.
const phoneBase = 3000000000 + (Date.now() % 1000000000);
const phone = (n: number) => `+1${phoneBase + n}`;

let agent: ReturnType<typeof request.agent>;
let cafeId: number; // creator
let gymId: number; // partner (joins)
let floristId: number; // partner (declines)
let outsiderId: number; // no partnership with cafe

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
      { brandName: `Camp Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Camp Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Camp Florist ${RUN}`, subdomain: `${RUN}-florist`, status: "active" },
      { brandName: `Camp Outsider ${RUN}`, subdomain: `${RUN}-outsider`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [cafeId, gymId, floristId, outsiderId] = tenants.map((t) => t.id);

  // Cafe ↔ Gym and Cafe ↔ Florist are accepted + active partnerships.
  // Outsider has none with Cafe.
  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: cafeId,
      partnerTenantId: gymId,
      perkTitle: `Camp perk gym ${RUN}`,
      redemptionCode: `CAMP-GYM-${RUN}`,
      status: "accepted",
      isActive: true,
    },
    {
      hostTenantId: floristId,
      partnerTenantId: cafeId,
      perkTitle: `Camp perk florist ${RUN}`,
      redemptionCode: `CAMP-FLO-${RUN}`,
      status: "accepted",
      isActive: true,
    },
  ]);

  // Opted-in customers: two for cafe (one shares a phone with gym's customer),
  // one opted-out for cafe, one for gym.
  await db.insert(sosCustomersTable).values([
    { tenantId: cafeId, name: `Ann ${RUN}`, phone: phone(1), smsOptIn: true },
    { tenantId: cafeId, name: `OptOut ${RUN}`, phone: phone(2), smsOptIn: false },
    { tenantId: cafeId, name: `Shared ${RUN}`, phone: phone(3), smsOptIn: true },
    { tenantId: gymId, name: `GymShared ${RUN}`, phone: phone(3), smsOptIn: true },
    { tenantId: gymId, name: `Gia ${RUN}`, phone: phone(4), smsOptIn: true },
    // Capped: already got a co-op campaign blast 2 days ago (seeded below).
    { tenantId: gymId, name: `Capped ${RUN}`, phone: phone(5), smsOptIn: true },
  ]);
});

afterAll(async () => {
  const ids = [cafeId, gymId, floristId, outsiderId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean partnerships, customers, campaigns, participants, blasts.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

const startsAt = new Date(Date.now() - 60_000).toISOString(); // already live
const endsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();

let campaignId: number;

describe("co-op campaign creation", () => {
  it("lists preset templates including custom", async () => {
    const res = await agent.get("/api/coop/campaigns/templates").expect(200);
    const slugs = res.body.map((t: { slug: string }) => t.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(["back_to_school", "holiday_weekend", "community_event", "custom"]),
    );
  });

  it("rejects creation without a tenant scope", async () => {
    await agent
      .post("/api/coop/campaigns")
      .send({ name: "x", perkBoostText: "y", startsAt, endsAt, partnerTenantIds: [gymId] })
      .expect(400);
  });

  it("blocks tenants with no accepted active partnership", async () => {
    const res = await agent
      .post("/api/coop/campaigns")
      .set("x-tenant-id", String(outsiderId))
      .send({ name: "Nope", perkBoostText: "y", startsAt, endsAt, partnerTenantIds: [gymId] })
      .expect(403);
    expect(res.body.message).toMatch(/accepted, active co-op partnership/);
  });

  it("blocks inviting a business that is not a current partner", async () => {
    const res = await agent
      .post("/api/coop/campaigns")
      .set("x-tenant-id", String(cafeId))
      .send({ name: "Nope", perkBoostText: "y", startsAt, endsAt, partnerTenantIds: [outsiderId] })
      .expect(403);
    expect(res.body.message).toMatch(/current accepted, active co-op partners/);
  });

  it("rejects an inverted window", async () => {
    await agent
      .post("/api/coop/campaigns")
      .set("x-tenant-id", String(cafeId))
      .send({ name: "Bad", perkBoostText: "y", startsAt: endsAt, endsAt: startsAt, partnerTenantIds: [gymId] })
      .expect(400);
  });

  it("creates a campaign with the uniform window and creator auto-joined", async () => {
    const res = await agent
      .post("/api/coop/campaigns")
      .set("x-tenant-id", String(cafeId))
      .send({
        name: `Neighborhood Splash ${RUN}`,
        template: "holiday_weekend",
        perkBoostText: `Free topper ${RUN}!`,
        startsAt,
        endsAt,
        partnerTenantIds: [gymId, floristId],
      })
      .expect(201);
    campaignId = res.body.id;
    expect(res.body.isCreator).toBe(true);
    expect(res.body.myStatus).toBe("joined");
    expect(res.body.phase).toBe("live");
    // Uniform window: one window on the campaign, identical for everyone.
    expect(res.body.startsAt).toBe(startsAt);
    expect(res.body.endsAt).toBe(endsAt);
    expect(res.body.participants).toHaveLength(3);
    const byId = Object.fromEntries(
      res.body.participants.map((p: { tenantId: number; status: string }) => [p.tenantId, p.status]),
    );
    expect(byId[cafeId]).toBe("joined");
    expect(byId[gymId]).toBe("invited");
    expect(byId[floristId]).toBe("invited");
  });
});

describe("join / decline flow and tenant isolation", () => {
  it("invited partners see the pending campaign; outsiders see nothing", async () => {
    const gymList = await agent
      .get("/api/coop/campaigns")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    const gymCampaign = gymList.body.find((c: { id: number }) => c.id === campaignId);
    expect(gymCampaign?.myStatus).toBe("invited");

    const outsiderList = await agent
      .get("/api/coop/campaigns")
      .set("x-tenant-id", String(outsiderId))
      .expect(200);
    expect(outsiderList.body.find((c: { id: number }) => c.id === campaignId)).toBeUndefined();
  });

  it("a non-participant cannot respond", async () => {
    await agent
      .post(`/api/coop/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(outsiderId))
      .send({ action: "join" })
      .expect(403);
  });

  it("the creator cannot 'respond' to their own campaign", async () => {
    await agent
      .post(`/api/coop/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(cafeId))
      .send({ action: "join" })
      .expect(403);
  });

  it("gym joins, florist declines, and double-responding is rejected", async () => {
    const joined = await agent
      .post(`/api/coop/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(gymId))
      .send({ action: "join" })
      .expect(200);
    expect(joined.body.myStatus).toBe("joined");

    const declined = await agent
      .post(`/api/coop/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(floristId))
      .send({ action: "decline" })
      .expect(200);
    expect(declined.body.myStatus).toBe("declined");

    await agent
      .post(`/api/coop/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(gymId))
      .send({ action: "decline" })
      .expect(409);
  });

  it("shows the flash perk on joined participants' perk surfaces only", async () => {
    const gymPerks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    const flash = gymPerks.body.flashPerks.find(
      (f: { campaignId: number }) => f.campaignId === campaignId,
    );
    expect(flash).toBeDefined();
    expect(flash.perkBoostText).toBe(`Free topper ${RUN}!`);
    expect(flash.partnerNames).toContain(`Camp Cafe ${RUN}`);
    // Florist declined — no flash perk on their surface.
    const floristPerks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(floristId))
      .expect(200);
    expect(
      floristPerks.body.flashPerks.find((f: { campaignId: number }) => f.campaignId === campaignId),
    ).toBeUndefined();
  });
});

describe("joint blast with 7-day frequency capping", () => {
  it("only the creator can trigger the blast", async () => {
    await agent
      .post(`/api/coop/campaigns/${campaignId}/blast`)
      .set("x-tenant-id", String(gymId))
      .expect(403);
  });

  it("sends to opted-in customers of joined partners, capping recent and duplicate phones", async () => {
    // Seed a prior network blast 2 days ago for phone(5) — inside the rolling
    // 7-day window, so it must be capped.
    await db.insert(coopCampaignBlastsTable).values({
      campaignId,
      tenantId: gymId,
      phone: phone(5),
      sentAt: new Date(Date.now() - 2 * 86_400_000),
    });

    const res = await agent
      .post(`/api/coop/campaigns/${campaignId}/blast`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    // Candidates: cafe(Ann, OptOut, Shared) + gym(GymShared, Gia, Capped) = 6.
    // Sent: Ann, Shared, Gia = 3. Skipped: OptOut = 1.
    // Capped: GymShared (same phone as Shared, deduped in-run) + Capped (7-day) = 2.
    expect(res.body.totalCandidates).toBe(6);
    expect(res.body.sent).toBe(3);
    expect(res.body.skipped).toBe(1);
    expect(res.body.capped).toBe(2);

    // Every send is in the frequency-cap ledger.
    const logged = await db
      .select({ phone: coopCampaignBlastsTable.phone })
      .from(coopCampaignBlastsTable)
      .where(eq(coopCampaignBlastsTable.campaignId, campaignId));
    expect(logged.map((l) => l.phone).sort()).toEqual(
      [phone(1), phone(3), phone(4), phone(5)].sort(),
    );
  });

  it("records the blast as marketing-origin coop_campaign_blast messages", async () => {
    // Raw SQL on purpose: marketing-origin rows are intentionally excluded
    // from the operational/concierge list surfaces, so we assert storage.
    const result = await db.execute(
      sql`select origin, kind from messages where kind = 'coop_campaign_blast' and tenant_id in (${cafeId}, ${gymId})`,
    );
    const list = result.rows as Array<{ origin: string }>;
    expect(list.length).toBeGreaterThanOrEqual(3);
    for (const r of list) expect(r.origin).toBe("marketing");
  });

  it("the blast fires exactly once", async () => {
    await agent
      .post(`/api/coop/campaigns/${campaignId}/blast`)
      .set("x-tenant-id", String(cafeId))
      .expect(409);
    const [row] = await db
      .select({ blastTriggeredAt: coopCampaignsTable.blastTriggeredAt })
      .from(coopCampaignsTable)
      .where(eq(coopCampaignsTable.id, campaignId));
    expect(row.blastTriggeredAt).not.toBeNull();
  });

  it("expired campaigns surface as ended (past list)", async () => {
    await db
      .update(coopCampaignsTable)
      .set({ endsAt: new Date(Date.now() - 60_000) })
      .where(eq(coopCampaignsTable.id, campaignId));
    const res = await agent
      .get("/api/coop/campaigns")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    const mine = res.body.find((c: { id: number }) => c.id === campaignId);
    expect(mine.phase).toBe("ended");
    // And the flash perk disappears from the perk surface.
    const gymPerks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(
      gymPerks.body.flashPerks.find((f: { campaignId: number }) => f.campaignId === campaignId),
    ).toBeUndefined();
  });
});
