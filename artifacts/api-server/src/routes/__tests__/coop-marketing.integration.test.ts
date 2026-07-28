import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  messagesTable,
  merchantCoopPartnershipsTable,
  coopMarketingCampaignsTable,
  coopMarketingLinksTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-op Marketing & Social Syndication Hub (/coop/marketing) against the real
// dev DB. Covers: partner approval gating (no dispatch until every
// participant approves; decline blocks), tenant scoping (non-participants get
// 404s), SMS fan-out respecting opt-outs through the unified messaging
// pipeline, scheduled dispatch via the worker sweep with its send-once lock,
// and click attribution rollup through the /mr/:code tracked links. SMS and
// social posting run in simulated mode (Twilio env removed, no Meta creds).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.META_GRAPH_ACCESS_TOKEN;

const RUN = `coopmkt-${Date.now()}-${process.pid}`;
const phoneBase = 4100000000 + (Date.now() % 100000000);
const phone = (n: number) => `+1${phoneBase + n}`;

let agent: ReturnType<typeof request.agent>;
let bakeryId: number; // creator
let studioId: number; // partner
let outsiderId: number; // not in the partnership
let partnershipId: number;
let pendingPartnershipId: number;

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
      { brandName: `Mkt Bakery ${RUN}`, subdomain: `${RUN}-bakery`, status: "active" },
      { brandName: `Mkt Studio ${RUN}`, subdomain: `${RUN}-studio`, status: "active" },
      { brandName: `Mkt Outsider ${RUN}`, subdomain: `${RUN}-outsider`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [bakeryId, studioId, outsiderId] = tenants.map((t) => t.id);

  const partnerships = await db
    .insert(merchantCoopPartnershipsTable)
    .values([
      {
        hostTenantId: bakeryId,
        partnerTenantId: studioId,
        perkTitle: `Mkt perk ${RUN}`,
        redemptionCode: `MKT-${RUN}`,
        status: "accepted",
        isActive: true,
      },
      {
        hostTenantId: bakeryId,
        partnerTenantId: outsiderId,
        perkTitle: `Mkt pending perk ${RUN}`,
        redemptionCode: `MKT-PEND-${RUN}`,
        status: "pending",
        isActive: true,
      },
    ])
    .returning({ id: merchantCoopPartnershipsTable.id });
  partnershipId = partnerships[0].id;
  pendingPartnershipId = partnerships[1].id;

  // Bakery: two opted-in + one opted-out subscriber. Studio: one opted-in.
  await db.insert(sosCustomersTable).values([
    { tenantId: bakeryId, name: `MA ${RUN}`, phone: phone(1), smsOptIn: true },
    { tenantId: bakeryId, name: `MB ${RUN}`, phone: phone(2), smsOptIn: true },
    { tenantId: bakeryId, name: `MOptOut ${RUN}`, phone: phone(3), smsOptIn: false },
    { tenantId: studioId, name: `MS ${RUN}`, phone: phone(4), smsOptIn: true },
  ]);
});

afterAll(async () => {
  const ids = [bakeryId, studioId, outsiderId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean partnerships, customers, campaigns, participants,
    // sends, links, and clicks.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("marketing hub basics", () => {
  it("lists the asset template library", async () => {
    const res = await agent.get("/api/coop/marketing/templates").expect(200);
    const slugs = res.body.map((t: { slug: string }) => t.slug);
    expect(slugs).toEqual(
      expect.arrayContaining([
        "instagram_square",
        "facebook_post",
        "story",
        "flyer",
        "sms_blast",
      ]),
    );
  });

  it("returns both businesses' branding with defaults for a partnership party", async () => {
    const res = await agent
      .get(`/api/coop/marketing/branding?partnershipId=${partnershipId}`)
      .set("x-tenant-id", String(bakeryId))
      .expect(200);
    expect(res.body.host.name).toBe(`Mkt Bakery ${RUN}`);
    expect(res.body.partner.name).toBe(`Mkt Studio ${RUN}`);
    // No branding set → defaults, empty logo.
    expect(res.body.host.primaryColor).toMatch(/^#/);
    expect(res.body.host.logoUrl).toBe("");
  });

  it("blocks branding lookup by a non-party tenant", async () => {
    await agent
      .get(`/api/coop/marketing/branding?partnershipId=${partnershipId}`)
      .set("x-tenant-id", String(outsiderId))
      .expect(403);
  });

  it("suggests deterministic fallback copy without AI credentials", async () => {
    const res = await agent
      .post("/api/coop/marketing/copy")
      .set("x-tenant-id", String(bakeryId))
      .send({ partnershipId, templateSlug: "sms_blast", offerText: "10% off combo" })
      .expect(200);
    expect(res.body.usedAi).toBe(false);
    expect(res.body.headline).toContain(`Mkt Bakery ${RUN}`);
    expect(res.body.smsText).toContain("10% off combo");
  });

  it("connects a social channel in simulated mode and never leaks tokens", async () => {
    const res = await agent
      .post("/api/coop/marketing/channels")
      .set("x-tenant-id", String(bakeryId))
      .send({ platform: "instagram", handle: `bakery_${RUN}` })
      .expect(201);
    expect(res.body.mode).toBe("simulated");
    expect(res.body.accessToken).toBeUndefined();
    // Duplicate platform is rejected.
    await agent
      .post("/api/coop/marketing/channels")
      .set("x-tenant-id", String(bakeryId))
      .send({ platform: "instagram", handle: `dup_${RUN}` })
      .expect(409);
    // Studio connects facebook for the dispatch test below.
    await agent
      .post("/api/coop/marketing/channels")
      .set("x-tenant-id", String(studioId))
      .send({ platform: "facebook", handle: `studio_${RUN}` })
      .expect(201);
  });
});

let campaignId: number;

describe("campaign creation & approval gating", () => {
  it("rejects a campaign on a non-accepted partnership", async () => {
    await agent
      .post("/api/coop/marketing/campaigns")
      .set("x-tenant-id", String(bakeryId))
      .send({
        name: `Nope ${RUN}`,
        partnershipId: pendingPartnershipId,
        templateSlug: "instagram_square",
        channels: [{ tenantId: bakeryId, channel: "sms" }],
      })
      .expect(403);
  });

  it("rejects creation by a tenant that is not a party", async () => {
    await agent
      .post("/api/coop/marketing/campaigns")
      .set("x-tenant-id", String(outsiderId))
      .send({
        name: `Nope ${RUN}`,
        partnershipId,
        templateSlug: "instagram_square",
        channels: [{ tenantId: bakeryId, channel: "sms" }],
      })
      .expect(403);
  });

  it("creates a pending-approval campaign with the creator auto-approved", async () => {
    const res = await agent
      .post("/api/coop/marketing/campaigns")
      .set("x-tenant-id", String(bakeryId))
      .send({
        name: `Joint promo ${RUN}`,
        partnershipId,
        templateSlug: "instagram_square",
        headline: "Better Together",
        bodyText: "Neighborhood deal",
        smsText: `Joint deal ${RUN}`,
        assetPayload: { offer: "10% off" },
        channels: [
          { tenantId: bakeryId, channel: "sms" },
          { tenantId: bakeryId, channel: "instagram" },
          { tenantId: studioId, channel: "sms" },
          { tenantId: studioId, channel: "facebook" },
        ],
      })
      .expect(201);
    campaignId = res.body.id;
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.isCreator).toBe(true);
    expect(res.body.myApproval).toBe("approved");
    const studio = res.body.participants.find(
      (p: { tenantId: number }) => p.tenantId === studioId,
    );
    expect(studio.approval).toBe("pending");
  });

  it("hides the campaign from non-participants (tenant scoping)", async () => {
    const list = await agent
      .get("/api/coop/marketing/campaigns")
      .set("x-tenant-id", String(outsiderId))
      .expect(200);
    expect(list.body.map((c: { id: number }) => c.id)).not.toContain(campaignId);
    await agent
      .get(`/api/coop/marketing/campaigns/${campaignId}/analytics`)
      .set("x-tenant-id", String(outsiderId))
      .expect(404);
    await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(outsiderId))
      .send({ action: "approve" })
      .expect(404);
  });

  it("blocks dispatch before the partner approves", async () => {
    const res = await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/dispatch`)
      .set("x-tenant-id", String(bakeryId))
      .expect(409);
    expect(res.body.message).toMatch(/approve/i);
  });

  it("blocks the creator from responding to their own campaign", async () => {
    await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(bakeryId))
      .send({ action: "approve" })
      .expect(403);
  });

  it("partner approval moves the campaign to scheduled and blocks double-respond", async () => {
    const res = await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(studioId))
      .send({ action: "approve" })
      .expect(200);
    expect(res.body.status).toBe("scheduled");
    await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/respond`)
      .set("x-tenant-id", String(studioId))
      .send({ action: "approve" })
      .expect(409);
  });

  it("only the creator can dispatch", async () => {
    await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/dispatch`)
      .set("x-tenant-id", String(studioId))
      .expect(403);
  });
});

describe("dispatch, opt-outs & analytics rollup", () => {
  it("dispatches: SMS fan-out respects opt-outs, social runs simulated", async () => {
    const res = await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/dispatch`)
      .set("x-tenant-id", String(bakeryId))
      .expect(200);
    expect(res.body.dispatched).toBe(true);
    // 2 bakery opted-in + 1 studio opted-in; the opted-out bakery customer
    // is skipped by the messaging opt-in guard.
    expect(res.body.smsSent).toBe(3);
    expect(res.body.smsSkipped).toBe(1);
    expect(res.body.sends).toBe(4);

    // Idempotent: a second dispatch is rejected (send-once lock).
    await agent
      .post(`/api/coop/marketing/campaigns/${campaignId}/dispatch`)
      .set("x-tenant-id", String(bakeryId))
      .expect(409);

    // No message ever went to the opted-out phone.
    const optOutMsgs = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.toNumber, phone(3)),
          eq(messagesTable.kind, "coop_marketing_blast"),
        ),
      );
    expect(optOutMsgs).toHaveLength(0);
  });

  it("records clicks via the /mr/:code tracked link and rolls up analytics", async () => {
    const links = await db
      .select()
      .from(coopMarketingLinksTable)
      .where(eq(coopMarketingLinksTable.campaignId, campaignId));
    expect(links.length).toBe(4); // one per (tenant, channel) target
    const smsLink = links.find((l) => l.tenantId === bakeryId && l.channel === "sms")!;

    // Two clicks on the bakery SMS link (public, unauthenticated).
    const plainApp = (await import("../../app")).default;
    await request(plainApp).get(`/api/mr/${smsLink.code}`).expect(302);
    await request(plainApp).get(`/api/mr/${smsLink.code}`).expect(302);
    await request(plainApp).get(`/api/mr/notarealcode${Date.now()}`).expect(404);

    const res = await agent
      .get(`/api/coop/marketing/campaigns/${campaignId}/analytics`)
      .set("x-tenant-id", String(studioId)) // partner can see analytics too
      .expect(200);
    expect(res.body.totals.delivered).toBe(3);
    expect(res.body.totals.clicks).toBe(2);
    // Simulated SMS + simulated social all count as simulated reach.
    expect(res.body.totals.reach).toBeGreaterThan(3);
    expect(res.body.totals.simulatedReach).toBe(res.body.totals.reach);
    const bakerySms = res.body.entries.find(
      (e: { tenantId: number; channel: string }) =>
        e.tenantId === bakeryId && e.channel === "sms",
    );
    expect(bakerySms.clicks).toBe(2);
    expect(bakerySms.skipped).toBe(1);
    const studioFb = res.body.entries.find(
      (e: { tenantId: number; channel: string }) =>
        e.tenantId === studioId && e.channel === "facebook",
    );
    expect(studioFb.simulated).toBe(true);
    expect(studioFb.impressions).toBeGreaterThan(0);
  });
});

describe("decline & scheduled dispatch", () => {
  it("a declined campaign never becomes dispatchable", async () => {
    const created = await agent
      .post("/api/coop/marketing/campaigns")
      .set("x-tenant-id", String(bakeryId))
      .send({
        name: `Declined promo ${RUN}`,
        partnershipId,
        templateSlug: "sms_blast",
        smsText: `Declined ${RUN}`,
        channels: [{ tenantId: studioId, channel: "sms" }],
      })
      .expect(201);
    const declinedId = created.body.id;
    const res = await agent
      .post(`/api/coop/marketing/campaigns/${declinedId}/respond`)
      .set("x-tenant-id", String(studioId))
      .send({ action: "decline" })
      .expect(200);
    expect(res.body.status).toBe("declined");
    await agent
      .post(`/api/coop/marketing/campaigns/${declinedId}/dispatch`)
      .set("x-tenant-id", String(bakeryId))
      .expect(409);
  });

  it("the worker sweep fires an approved scheduled campaign exactly once", async () => {
    const { sweepMarketingCampaignDispatch } = await import("../../lib/coopMarketing");
    const created = await agent
      .post("/api/coop/marketing/campaigns")
      .set("x-tenant-id", String(bakeryId))
      .send({
        name: `Scheduled promo ${RUN}`,
        partnershipId,
        templateSlug: "facebook_post",
        smsText: `Scheduled ${RUN}`,
        channels: [{ tenantId: studioId, channel: "sms" }],
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .expect(201);
    const scheduledId = created.body.id;
    await agent
      .post(`/api/coop/marketing/campaigns/${scheduledId}/respond`)
      .set("x-tenant-id", String(studioId))
      .send({ action: "approve" })
      .expect(200);

    // Not due yet — the sweep must not touch it.
    await sweepMarketingCampaignDispatch(new Date());
    let [row] = await db
      .select()
      .from(coopMarketingCampaignsTable)
      .where(eq(coopMarketingCampaignsTable.id, scheduledId));
    expect(row.status).toBe("scheduled");
    expect(row.dispatchTriggeredAt).toBeNull();

    // Due — fires once; a second sweep is a no-op (send-once lock).
    const later = new Date(Date.now() + 120_000);
    const fired = await sweepMarketingCampaignDispatch(later);
    expect(fired).toBeGreaterThanOrEqual(1);
    const firedAgain = await sweepMarketingCampaignDispatch(later);
    expect(firedAgain).toBe(0);
    [row] = await db
      .select()
      .from(coopMarketingCampaignsTable)
      .where(eq(coopMarketingCampaignsTable.id, scheduledId));
    expect(row.status).toBe("sent");
    expect(row.dispatchTriggeredAt).not.toBeNull();

    // Only the studio's opted-in subscriber got this scheduled blast.
    const msgs = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.tenantId, studioId),
          eq(messagesTable.kind, "coop_marketing_blast"),
        ),
      );
    expect(msgs.some((m) => m.body.includes(`Scheduled ${RUN}`))).toBe(true);
    // SMS recipients are outside the app, so the tracked link must be an
    // absolute URL (never a bare relative /mr path).
    const blast = msgs.find((m) => m.body.includes(`Scheduled ${RUN}`))!;
    expect(blast.body).toMatch(/https?:\/\/[^\s]+\/api\/mr\/mk[0-9a-f]{12}/);
  });
});
