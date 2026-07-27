import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopIsolationPairsTable,
} from "@workspace/db";
import { and, eq, inArray, or } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Category Firewall & Proximity Exclusion Engine, against the real dev DB.
// Covers: the sub-category firewall matrix (same L2 blocked at discovery AND
// invite time; same L1/different L2 allowed; cross-industry allowed), the
// co-op radius default + slider persistence + discovery re-scoping, the
// automated onboarding conflict check persisting mutual isolation pairs, and
// the consumer-surface exclusion guarantee (a competitor's perk can never be
// emitted by /coop/perks, even for legacy admin-created partnerships).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopfw-${Date.now()}-${process.pid}`;
const SAME_INDUSTRY_MESSAGE = "Same-industry pairings are restricted by platform guidelines.";

let agent: ReturnType<typeof request.agent>;
// barberA / barberB: same L2 (barbershop), ~1 mile apart.
// nails: same L1 (personal-care), different L2 — allowed.
// mechanic: different industry entirely — allowed.
// farBarber: same L2 but ~40 miles away (outside every radius).
let barberAId: number;
let barberBId: number;
let nailsId: number;
let mechanicId: number;
let farBarberId: number;
let allIds: number[] = [];

const settingsRow = (
  tenantId: number,
  coopSubCategory: string,
  lat: string,
  lng: string,
  city = "Riverside"
) => ({
  tenantId,
  coopSubCategory,
  businessCategory: `FW-${RUN}`,
  addressLocality: city,
  latitude: lat,
  longitude: lng,
});

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
      { brandName: `FW Barber A ${RUN}`, subdomain: `${RUN}-barber-a`, status: "active" },
      { brandName: `FW Barber B ${RUN}`, subdomain: `${RUN}-barber-b`, status: "active" },
      { brandName: `FW Nails ${RUN}`, subdomain: `${RUN}-nails`, status: "active" },
      { brandName: `FW Mechanic ${RUN}`, subdomain: `${RUN}-mechanic`, status: "active" },
      { brandName: `FW Far Barber ${RUN}`, subdomain: `${RUN}-far-barber`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [barberAId, barberBId, nailsId, mechanicId, farBarberId] = tenants.map((t) => t.id);
  allIds = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    settingsRow(barberAId, "barbershop", "40.7128", "-74.0060"),
    settingsRow(barberBId, "barbershop", "40.7150", "-74.0080"),
    settingsRow(nailsId, "nail-salon", "40.7130", "-74.0050"),
    settingsRow(mechanicId, "mechanic-shop", "40.7140", "-74.0070"),
    // ~40 miles north — outside any 1–15 mile radius.
    settingsRow(farBarberId, "barbershop", "41.2900", "-74.0060", "Uptown"),
  ]);
});

afterAll(async () => {
  const ids = allIds.filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up sos_settings, partnerships, and isolation pairs.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

const directoryFor = async (tenantId: number) => {
  const res = await agent
    .get("/api/coop/directory")
    .set("x-tenant-id", String(tenantId))
    .expect(200);
  return (res.body as { id: number; sameIndustry: boolean }[]).filter((e) =>
    allIds.includes(e.id)
  );
};

describe("sub-category firewall matrix", () => {
  it("same L2 sub-category is blocked at discovery, in both directions", async () => {
    const a = await directoryFor(barberAId);
    expect(a.map((e) => e.id)).not.toContain(barberBId);
    const b = await directoryFor(barberBId);
    expect(b.map((e) => e.id)).not.toContain(barberAId);
  });

  it("same L1 industry / different L2 stays discoverable, flagged sameIndustry", async () => {
    const a = await directoryFor(barberAId);
    const nails = a.find((e) => e.id === nailsId);
    expect(nails).toBeDefined();
    expect(nails!.sameIndustry).toBe(true);
  });

  it("cross-industry stays discoverable and unflagged", async () => {
    const a = await directoryFor(barberAId);
    const mech = a.find((e) => e.id === mechanicId);
    expect(mech).toBeDefined();
    expect(mech!.sameIndustry).toBe(false);
  });

  it("invite endpoint is a backstop: same L2 rejected with the contractual message", async () => {
    const res = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(barberAId))
      .send({ partnerTenantId: barberBId, perkTitle: "Free fade" })
      .expect(403);
    expect(res.body.code).toBe("SAME_INDUSTRY_RESTRICTED");
    expect(res.body.message).toBe(SAME_INDUSTRY_MESSAGE);
  });

  it("same L1 / different L2 invites are allowed", async () => {
    const res = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(barberAId))
      .send({ partnerTenantId: nailsId, perkTitle: `Cross-niche perk ${RUN}` })
      .expect(201);
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, res.body.id));
  });

  it("taxonomy endpoint serves the curated two-level tree", async () => {
    const res = await agent.get("/api/coop/taxonomy").expect(200);
    const personalCare = res.body.find((i: { slug: string }) => i.slug === "personal-care");
    expect(personalCare).toBeDefined();
    const slugs = personalCare.subCategories.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain("barbershop");
    expect(slugs).toContain("nail-salon");
  });
});

describe("co-op radius default and slider persistence", () => {
  it("new settings rows get the smart default radius in the 3–5 mile band", async () => {
    const res = await agent.get(`/api/tenants/${barberAId}/settings`).expect(200);
    expect(res.body.coopRadiusMiles).toBeGreaterThanOrEqual(3);
    expect(res.body.coopRadiusMiles).toBeLessThanOrEqual(5);
    expect(res.body.coopSubCategory).toBe("barbershop");
  });

  it("radius persists via settings PATCH and re-scopes local discovery", async () => {
    // Default radius: far barber's competitor (nails) at ~40 miles is out of
    // range for barber A... verify with a *non-competitor* far business by
    // temporarily reclassifying farBarber to a different sub-category.
    await agent
      .patch(`/api/tenants/${farBarberId}/settings`)
      .send({ coopSubCategory: "spa" })
      .expect(200);

    // At the default 4-mile radius the far business is invisible.
    let a = await directoryFor(barberAId);
    expect(a.map((e) => e.id)).not.toContain(farBarberId);

    // Widening to 15 miles still doesn't reach ~40 miles away.
    const patched = await agent
      .patch(`/api/tenants/${barberAId}/settings`)
      .send({ coopRadiusMiles: 15 })
      .expect(200);
    expect(patched.body.coopRadiusMiles).toBe(15);
    a = await directoryFor(barberAId);
    expect(a.map((e) => e.id)).not.toContain(farBarberId);

    // Nearby businesses remain visible at both radii.
    expect(a.map((e) => e.id)).toContain(nailsId);

    // The value round-trips on GET (slider persistence).
    const got = await agent.get(`/api/tenants/${barberAId}/settings`).expect(200);
    expect(got.body.coopRadiusMiles).toBe(15);

    // Restore.
    await agent
      .patch(`/api/tenants/${barberAId}/settings`)
      .send({ coopRadiusMiles: 4 })
      .expect(200);
    await agent
      .patch(`/api/tenants/${farBarberId}/settings`)
      .send({ coopSubCategory: "barbershop" })
      .expect(200);
  });

  it("radius values are clamped to the 1–15 slider range", async () => {
    await agent
      .patch(`/api/tenants/${barberAId}/settings`)
      .send({ coopRadiusMiles: 40 })
      .expect(400);
    await agent
      .patch(`/api/tenants/${barberAId}/settings`)
      .send({ coopRadiusMiles: 0 })
      .expect(400);
  });
});

describe("onboarding conflict check → mutual isolation pairs", () => {
  it("a coop-scope settings change triggers the conflict check and persists the pair", async () => {
    // Trigger via a PATCH that touches coop scope for barber A.
    await agent
      .patch(`/api/tenants/${barberAId}/settings`)
      .send({ coopSubCategory: "barbershop" })
      .expect(200);

    const pairs = await db
      .select()
      .from(coopIsolationPairsTable)
      .where(
        and(
          eq(coopIsolationPairsTable.tenantAId, Math.min(barberAId, barberBId)),
          eq(coopIsolationPairsTable.tenantBId, Math.max(barberAId, barberBId))
        )
      );
    expect(pairs.length).toBe(1);
    expect(pairs[0].subCategory).toBe("barbershop");
    expect(pairs[0].matchBasis).toBe("radius");
  });

  it("no pair is recorded for the same-L2 competitor outside both radii", async () => {
    const pairs = await db
      .select()
      .from(coopIsolationPairsTable)
      .where(
        or(
          eq(coopIsolationPairsTable.tenantAId, Math.min(barberAId, farBarberId)),
          eq(coopIsolationPairsTable.tenantBId, Math.max(barberAId, farBarberId))
        )
      );
    expect(
      pairs.filter(
        (p) =>
          (p.tenantAId === barberAId && p.tenantBId === farBarberId) ||
          (p.tenantAId === farBarberId && p.tenantBId === barberAId)
      ).length
    ).toBe(0);
  });

  it("isolation pairs stop applying only when sub-categories diverge", async () => {
    // Pair exists (from the previous test). While both are barbershops the
    // block holds even after a radius edit...
    await agent
      .patch(`/api/tenants/${barberBId}/settings`)
      .send({ coopRadiusMiles: 1 })
      .expect(200);
    let a = await directoryFor(barberAId);
    expect(a.map((e) => e.id)).not.toContain(barberBId);

    // ...but when barber B pivots to a different sub-category, the pair no
    // longer applies and discovery reopens in both directions.
    await agent
      .patch(`/api/tenants/${barberBId}/settings`)
      .send({ coopSubCategory: "spa" })
      .expect(200);
    a = await directoryFor(barberAId);
    expect(a.map((e) => e.id)).toContain(barberBId);

    // Pivot back: same-L2 rule blocks again immediately.
    await agent
      .patch(`/api/tenants/${barberBId}/settings`)
      .send({ coopSubCategory: "barbershop", coopRadiusMiles: 4 })
      .expect(200);
    a = await directoryFor(barberAId);
    expect(a.map((e) => e.id)).not.toContain(barberBId);
  });
});

describe("consumer-surface exclusion guarantee", () => {
  it("a legacy admin-created same-L2 partnership's perk never reaches /coop/perks (checkout, receipt, pass surfaces)", async () => {
    // Admin override creates an accepted+active partnership between the two
    // barbershops — the exact legacy scenario predating the firewall.
    const created = await agent
      .post("/api/coop/partnerships")
      .send({
        hostTenantId: barberAId,
        partnerTenantId: barberBId,
        perkTitle: `Competitor perk ${RUN}`,
        overrideIndustryBarrier: true,
      });
    // Some deployments hard-block; if the override path created it, the
    // consumer surfaces must still refuse to emit it.
    if (created.status === 201) {
      for (const t of [barberAId, barberBId]) {
        const perks = await agent
          .get("/api/coop/perks")
          .set("x-tenant-id", String(t))
          .expect(200);
        expect(
          perks.body.perks.some((p: { id: number }) => p.id === created.body.id)
        ).toBe(false);
      }
      await db
        .delete(merchantCoopPartnershipsTable)
        .where(eq(merchantCoopPartnershipsTable.id, created.body.id));
    } else {
      expect([403, 409]).toContain(created.status);
    }
  });

  it("a legitimate cross-vertical partnership's perk still flows to both surfaces", async () => {
    const invite = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(barberAId))
      .send({ partnerTenantId: mechanicId, perkTitle: `Oil change discount ${RUN}` })
      .expect(201);
    await agent
      .post(`/api/coop/invites/${invite.body.id}/respond`)
      .set("x-tenant-id", String(mechanicId))
      .send({ action: "accept" })
      .expect(200);
    for (const t of [barberAId, mechanicId]) {
      const perks = await agent
        .get("/api/coop/perks")
        .set("x-tenant-id", String(t))
        .expect(200);
      expect(
        perks.body.perks.some((p: { id: number }) => p.id === invite.body.id)
      ).toBe(true);
    }
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, invite.body.id));
  });
});
