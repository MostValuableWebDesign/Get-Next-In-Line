import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, merchantCoopPartnershipsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Public storefront (landing page) integration tests, against the real dev DB.
//
// Covers: inline booking embed on the crawlable landing page, the Local Perks
// banner (active co-op partnerships only, hidden when none), the public perks
// JSON route, and the security boundary — redemption codes must never appear
// in the public HTML or the perks JSON.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `storefr-${Date.now()}-${process.pid}`;
const HOST_SLUG = `${RUN}-host`;
const PARTNER_SLUG = `${RUN}-partner`;
const BARE_SLUG = `${RUN}-bare`;

const ACTIVE_CODE = `COOP-${RUN}-ACT`.toUpperCase();
const INACTIVE_CODE = `COOP-${RUN}-OFF`.toUpperCase();

let anon: ReturnType<typeof request>;
let hostId: number;
let partnerId: number;
let bareId: number;

beforeAll(async () => {
  const app = (await import("../../app")).default;
  anon = request(app);

  const rows = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Storefront Host ${RUN}`, subdomain: HOST_SLUG, status: "active" },
      { brandName: `Storefront Partner ${RUN}`, subdomain: PARTNER_SLUG, status: "active" },
      { brandName: `Storefront Bare ${RUN}`, subdomain: BARE_SLUG, status: "active" },
    ])
    .returning({ id: tenantsTable.id, subdomain: tenantsTable.subdomain });
  hostId = rows.find((r) => r.subdomain === HOST_SLUG)!.id;
  partnerId = rows.find((r) => r.subdomain === PARTNER_SLUG)!.id;
  bareId = rows.find((r) => r.subdomain === BARE_SLUG)!.id;

  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: hostId,
      partnerTenantId: partnerId,
      perkTitle: `Free coffee ${RUN}`,
      perkDescription: "A free coffee with any visit",
      redemptionCode: ACTIVE_CODE,
      isActive: true,
    },
    {
      hostTenantId: hostId,
      partnerTenantId: partnerId,
      perkTitle: `Expired perk ${RUN}`,
      perkDescription: "This one is retired",
      redemptionCode: INACTIVE_CODE,
      isActive: false,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(merchantCoopPartnershipsTable)
    .where(inArray(merchantCoopPartnershipsTable.hostTenantId, [hostId]));
  await db.delete(tenantsTable).where(inArray(tenantsTable.id, [hostId, partnerId, bareId]));
});

describe("storefront inline booking", () => {
  it("embeds the booking widget in embed mode on the landing page", async () => {
    const res = await anon.get(`/api/public/landing/${HOST_SLUG}`).expect(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Book Your Appointment");
    expect(res.text).toContain(`src="/book/${HOST_SLUG}?embed=1"`);
    // Crawlable no-JS fallback link into the booking flow remains.
    expect(res.text).toContain(`href="/book/${HOST_SLUG}"`);
  });
});

describe("Local Perks banner", () => {
  it("shows active perks with partner business name on the host's page", async () => {
    const res = await anon.get(`/api/public/landing/${HOST_SLUG}`).expect(200);
    expect(res.text).toContain("Local Perks");
    expect(res.text).toContain(`Free coffee ${RUN}`);
    expect(res.text).toContain("A free coffee with any visit");
    expect(res.text).toContain(`Storefront Partner ${RUN}`);
  });

  it("shows the perk on the partner's page naming the host business", async () => {
    const res = await anon.get(`/api/public/landing/${PARTNER_SLUG}`).expect(200);
    expect(res.text).toContain(`Free coffee ${RUN}`);
    expect(res.text).toContain(`Storefront Host ${RUN}`);
  });

  it("excludes inactive partnerships", async () => {
    const res = await anon.get(`/api/public/landing/${HOST_SLUG}`).expect(200);
    expect(res.text).not.toContain(`Expired perk ${RUN}`);
    expect(res.text).not.toContain("This one is retired");
  });

  it("renders no perks section when the business has no active partnerships", async () => {
    const res = await anon.get(`/api/public/landing/${BARE_SLUG}`).expect(200);
    expect(res.text).not.toContain("Local Perks");
    expect(res.text).not.toContain('id="perks"');
  });

  it("never exposes redemption codes in the public HTML", async () => {
    for (const slug of [HOST_SLUG, PARTNER_SLUG]) {
      const res = await anon.get(`/api/public/landing/${slug}`).expect(200);
      expect(res.text).not.toContain(ACTIVE_CODE);
      expect(res.text).not.toContain(INACTIVE_CODE);
    }
  });
});

describe("public perks JSON route", () => {
  it("returns active perks without codes, unauthenticated", async () => {
    const res = await anon.get(`/api/public/landing/${HOST_SLUG}/perks`).expect(200);
    expect(res.body.perks).toEqual([
      {
        perkTitle: `Free coffee ${RUN}`,
        perkDescription: "A free coffee with any visit",
        partnerBusinessName: `Storefront Partner ${RUN}`,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(ACTIVE_CODE);
    expect(JSON.stringify(res.body)).not.toContain(INACTIVE_CODE);
  });

  it("returns an empty list for a business with no partnerships", async () => {
    const res = await anon.get(`/api/public/landing/${BARE_SLUG}/perks`).expect(200);
    expect(res.body.perks).toEqual([]);
  });

  it("404s for unknown or malformed slugs", async () => {
    await anon.get(`/api/public/landing/no-such-biz-${RUN}/perks`).expect(404);
    await anon.get(`/api/public/landing/bad_slug!/perks`).expect(404);
  });
});
