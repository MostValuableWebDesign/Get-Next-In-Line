import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable, sosSettingsTable, merchantCoopPartnershipsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Merchant-facing Local Co-Op Network (/coop/directory, /coop/invites,
// /coop/perks) against the real dev DB. Covers: directory scoping/filtering
// and same-industry flagging, the strict same-industry invite guardrail (no
// override) with the exact platform-guidelines message, the invite lifecycle
// (pending → accepted / declined) including who may respond, and that perks
// and redemption codes only go live while a partnership is accepted + active.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopnet-${Date.now()}-${process.pid}`;
const SAME_INDUSTRY_MESSAGE = "Same-industry pairings are restricted by platform guidelines.";

let agent: ReturnType<typeof request.agent>;
// Salon A and Salon B share the exact industry category; Cafe and Gym differ.
let salonAId: number;
let salonBId: number;
let cafeId: number;
let gymId: number;

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

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `Net Salon A ${RUN}`, subdomain: `${RUN}-salon-a`, status: "active" },
      { brandName: `Net Salon B ${RUN}`, subdomain: `${RUN}-salon-b`, status: "active" },
      { brandName: `Net Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Net Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [salonAId, salonBId, cafeId, gymId] = tenants.map((t) => t.id);

  // All four are within a mile of each other so the proximity scope keeps
  // them mutually discoverable; the category firewall is what separates them.
  await db.insert(sosSettingsTable).values([
    {
      tenantId: salonAId,
      industryType: "salon",
      businessCategory: `HairSalon-${RUN}`,
      addressLocality: "Riverside",
      latitude: "40.7128",
      longitude: "-74.0060",
    },
    {
      tenantId: salonBId,
      industryType: "salon",
      businessCategory: `HairSalon-${RUN}`,
      addressLocality: "Downtown",
      latitude: "40.7150",
      longitude: "-74.0080",
    },
    {
      tenantId: cafeId,
      industryType: "restaurant",
      businessCategory: `CafeOrCoffeeShop-${RUN}`,
      addressLocality: "Riverside",
      latitude: "40.7130",
      longitude: "-74.0050",
    },
    {
      tenantId: gymId,
      industryType: "fitness",
      businessCategory: `HealthClub-${RUN}`,
      addressLocality: "Downtown",
      latitude: "40.7140",
      longitude: "-74.0070",
    },
  ]);
});

afterAll(async () => {
  const ids = [salonAId, salonBId, cafeId, gymId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up sos_settings and partnerships.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

type DirectoryEntry = {
  id: number;
  name: string;
  category: string | null;
  city: string | null;
  sameIndustry: boolean;
};

const mine = (arr: DirectoryEntry[]): DirectoryEntry[] =>
  arr.filter((e) => [salonAId, salonBId, cafeId, gymId].includes(e.id));

describe("co-op directory", () => {
  it("requires the x-tenant-id scope", async () => {
    await agent.get("/api/coop/directory").expect(400);
  });

  it("lists other businesses with safe fields only, excluding self AND same-sub-category competitors", async () => {
    const res = await agent
      .get("/api/coop/directory")
      .set("x-tenant-id", String(salonAId))
      .expect(200);
    const entries = mine(res.body);
    // The category firewall removes Salon B (same Level 2 sub-category) at
    // the discovery layer — it is not merely flagged, it never appears.
    expect(entries.map((e: { id: number }) => e.id).sort()).toEqual(
      [cafeId, gymId].sort()
    );
    const cafe = entries.find((e) => e.id === cafeId);
    expect(cafe).toBeDefined();
    expect(cafe!.category).toBe(`CafeOrCoffeeShop-${RUN}`);
    expect(cafe!.city).toBe("Riverside");
    expect(cafe!.sameIndustry).toBe(false);
    // No sensitive tenant fields leak.
    expect(Object.keys(cafe!).sort()).toEqual(
      [
        "category",
        "city",
        "distanceMiles",
        "featured",
        "id",
        "industry",
        "name",
        "sameIndustry",
        "subCategory",
        "samePlaza",
        "plazaConflict",
        "capacityStatus",
      ].sort()
    );
  });

  it("filters by search, city, and category", async () => {
    const bySearch = await agent
      .get(`/api/coop/directory?search=net cafe ${RUN.toLowerCase()}`)
      .set("x-tenant-id", String(salonAId))
      .expect(200);
    expect(mine(bySearch.body).map((e: { id: number }) => e.id)).toEqual([cafeId]);

    const byCity = await agent
      .get("/api/coop/directory?city=riverside")
      .set("x-tenant-id", String(salonAId))
      .expect(200);
    expect(mine(byCity.body).map((e: { id: number }) => e.id)).toEqual([cafeId]);

    const byCategory = await agent
      .get(`/api/coop/directory?category=HealthClub-${RUN}`)
      .set("x-tenant-id", String(salonAId))
      .expect(200);
    expect(mine(byCategory.body).map((e: { id: number }) => e.id)).toEqual([gymId]);
  });
});

describe("co-op invite lifecycle", () => {
  it("strictly blocks same-industry invites with the exact platform-guidelines message", async () => {
    const res = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(salonAId))
      .send({ partnerTenantId: salonBId, perkTitle: "Free blowout" })
      .expect(403);
    expect(res.body.message).toBe(SAME_INDUSTRY_MESSAGE);
    expect(res.body.code).toBe("SAME_INDUSTRY_RESTRICTED");
    // No partnership row was created.
    const list = await agent.get(`/api/coop/partnerships?tenantId=${salonAId}`).expect(200);
    expect(list.body.length).toBe(0);
  });

  it("rejects self-invites and unknown targets", async () => {
    await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(salonAId))
      .send({ partnerTenantId: salonAId, perkTitle: "x" })
      .expect(400);
    await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(salonAId))
      .send({ partnerTenantId: 99999999, perkTitle: "x" })
      .expect(404);
  });

  let inviteId: number;
  let inviteCode: string;

  it("cross-vertical invites proceed instantly as pending + inactive", async () => {
    const res = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(salonAId))
      .send({
        partnerTenantId: cafeId,
        perkTitle: "10% off your meal or service",
        perkDescription: "Show the code at the register",
        mutualRewardTerms: "Each business honors the perk for the other's customers",
      })
      .expect(201);
    inviteId = res.body.id;
    inviteCode = res.body.redemptionCode;
    expect(res.body.status).toBe("pending");
    expect(res.body.isActive).toBe(false);
    expect(res.body.requestedByTenantId).toBe(salonAId);
    expect(res.body.mutualRewardTerms).toMatch(/honors the perk/);
  });

  it("pending invites never surface: no perks anywhere, code invalid, cannot be force-activated", async () => {
    for (const t of [salonAId, cafeId]) {
      const perks = await agent
        .get("/api/coop/perks")
        .set("x-tenant-id", String(t))
        .expect(200);
      expect(perks.body.perks.length).toBe(0);
    }
    const redemption = await agent.get(`/api/coop/redemptions/${inviteCode}`).expect(200);
    expect(redemption.body.valid).toBe(false);
    // Admin PATCH cannot flip a pending invite live.
    await agent
      .patch(`/api/coop/partnerships/${inviteId}`)
      .set("x-tenant-id", String(salonAId))
      .send({ isActive: true })
      .expect(409);
  });

  it("only the invited business can respond — not the requester or a bystander", async () => {
    await agent
      .post(`/api/coop/invites/${inviteId}/respond`)
      .set("x-tenant-id", String(salonAId))
      .send({ action: "accept" })
      .expect(403);
    await agent
      .post(`/api/coop/invites/${inviteId}/respond`)
      .set("x-tenant-id", String(gymId))
      .send({ action: "accept" })
      .expect(403);
  });

  it("acceptance flips the partnership live for both sides", async () => {
    const res = await agent
      .post(`/api/coop/invites/${inviteId}/respond`)
      .set("x-tenant-id", String(cafeId))
      .send({ action: "accept" })
      .expect(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.isActive).toBe(true);

    // Perk auto-deploys to both tenants' surfaces, naming the *other* business.
    const salonPerks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(salonAId))
      .expect(200);
    expect(salonPerks.body.perks.length).toBe(1);
    expect(salonPerks.body.perks[0].partnerName).toBe(`Net Cafe ${RUN}`);
    expect(salonPerks.body.perks[0].redemptionCode).toBe(inviteCode);

    const cafePerks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(cafePerks.body.perks.length).toBe(1);
    expect(cafePerks.body.perks[0].partnerName).toBe(`Net Salon A ${RUN}`);

    const redemption = await agent
      .get(`/api/coop/redemptions/${inviteCode}`)
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(redemption.body.valid).toBe(true);
  });

  it("cannot respond twice", async () => {
    await agent
      .post(`/api/coop/invites/${inviteId}/respond`)
      .set("x-tenant-id", String(cafeId))
      .send({ action: "decline" })
      .expect(409);
  });

  it("deactivation removes the perk everywhere with no manual steps", async () => {
    await agent
      .patch(`/api/coop/partnerships/${inviteId}`)
      .set("x-tenant-id", String(salonAId))
      .send({ isActive: false })
      .expect(200);
    for (const t of [salonAId, cafeId]) {
      const perks = await agent
        .get("/api/coop/perks")
        .set("x-tenant-id", String(t))
        .expect(200);
      expect(perks.body.perks.length).toBe(0);
    }
    const redemption = await agent.get(`/api/coop/redemptions/${inviteCode}`).expect(200);
    expect(redemption.body.valid).toBe(false);
    // Accepted partnerships may be reactivated (unlike pending/declined).
    await agent
      .patch(`/api/coop/partnerships/${inviteId}`)
      .set("x-tenant-id", String(salonAId))
      .send({ isActive: true })
      .expect(200);
  });

  it("declined invites never surface and stay dead", async () => {
    const created = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(gymId))
      .send({ partnerTenantId: cafeId, perkTitle: "Free smoothie after your workout" })
      .expect(201);
    const declined = await agent
      .post(`/api/coop/invites/${created.body.id}/respond`)
      .set("x-tenant-id", String(cafeId))
      .send({ action: "decline" })
      .expect(200);
    expect(declined.body.status).toBe("declined");
    expect(declined.body.isActive).toBe(false);

    const gymPerks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(gymPerks.body.perks.length).toBe(0);
    const code = await agent
      .get(`/api/coop/redemptions/${created.body.redemptionCode}`)
      .expect(200);
    expect(code.body.valid).toBe(false);
    // Declined invites cannot be force-activated either.
    await agent
      .patch(`/api/coop/partnerships/${created.body.id}`)
      .set("x-tenant-id", String(gymId))
      .send({ isActive: true })
      .expect(409);
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(inArray(merchantCoopPartnershipsTable.id, [created.body.id]));
  });

  it("admin-created partnerships stay accepted-from-birth (no regression)", async () => {
    const res = await agent
      .post("/api/coop/partnerships")
      .send({ hostTenantId: gymId, partnerTenantId: salonBId, perkTitle: "Admin pact" })
      .expect(201);
    expect(res.body.status).toBe("accepted");
    expect(res.body.isActive).toBe(true);
    expect(res.body.requestedByTenantId).toBeNull();
    const perks = await agent
      .get("/api/coop/perks")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(perks.body.perks.some((p: { id: number }) => p.id === res.body.id)).toBe(true);
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(inArray(merchantCoopPartnershipsTable.id, [res.body.id]));
  });
});
