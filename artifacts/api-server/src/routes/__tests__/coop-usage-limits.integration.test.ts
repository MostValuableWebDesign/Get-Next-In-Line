import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosSettingsTable,
  merchantCoopPartnershipsTable,
  coopPerkRedemptionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Perk usage limits + booking-confirmation perk surface, against the real dev
// DB. Covers: create/patch validation of usage limits, total-cap and
// per-customer enforcement at validation AND redemption time (against
// recorded redemption rows), window-expiry/limit interplay, inactive
// partnership behavior, and the public booking confirmation feed (active
// perks only, never the raw redemption code).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `uselim-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let anon: ReturnType<typeof request>;
let hostId: number;
let partnerAId: number;
let partnerBId: number;
let partnerCId: number;
let allIds: number[] = [];

const settingsRow = (tenantId: number, coopSubCategory: string, lat: string, lng: string) => ({
  tenantId,
  coopSubCategory,
  businessCategory: `USELIM-${RUN}`,
  addressLocality: "Riverside",
  latitude: lat,
  longitude: lng,
});

const createPartnership = (partnerTenantId: number, title: string, extra: object = {}) =>
  agent.post("/api/coop/partnerships").send({
    hostTenantId: hostId,
    partnerTenantId,
    perkTitle: title,
    ...extra,
  });

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  anon = request(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const tenants = await db
    .insert(tenantsTable)
    .values([
      { brandName: `UseLim Host ${RUN}`, subdomain: `${RUN}-host`, status: "active" },
      { brandName: `UseLim Partner A ${RUN}`, subdomain: `${RUN}-pa`, status: "active" },
      { brandName: `UseLim Partner B ${RUN}`, subdomain: `${RUN}-pb`, status: "active" },
      { brandName: `UseLim Partner C ${RUN}`, subdomain: `${RUN}-pc`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerAId, partnerBId, partnerCId] = tenants.map((t) => t.id);
  allIds = tenants.map((t) => t.id);

  await db.insert(sosSettingsTable).values([
    settingsRow(hostId, "barbershop", "40.7128", "-74.0060"),
    settingsRow(partnerAId, "nail-salon", "40.7150", "-74.0080"),
    settingsRow(partnerBId, "mechanic-shop", "40.7130", "-74.0050"),
    settingsRow(partnerCId, "florist", "40.7140", "-74.0070"),
  ]);
});

afterAll(async () => {
  const ids = allIds.filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up settings, partnerships, and redemptions.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

describe("usage limit configuration", () => {
  it("defaults to unlimited and round-trips through create + list", async () => {
    const res = await createPartnership(partnerAId, `Default limit ${RUN}`).expect(201);
    expect(res.body.usageLimitKind).toBe("unlimited");
    expect(res.body.usageCap).toBeNull();
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, res.body.id));
  });

  it("rejects a total cap without a positive cap value", async () => {
    const res = await createPartnership(partnerAId, `Bad cap ${RUN}`, {
      usageLimitKind: "total_cap",
    }).expect(400);
    expect(res.body.message).toMatch(/cap/i);
  });

  it("edits the limit through PATCH, requiring a cap for total_cap", async () => {
    const created = await createPartnership(partnerAId, `Editable ${RUN}`).expect(201);
    const id = created.body.id as number;
    await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(hostId))
      .send({ usageLimitKind: "total_cap" })
      .expect(400);
    const updated = await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(hostId))
      .send({ usageLimitKind: "total_cap", usageCap: 5 })
      .expect(200);
    expect(updated.body.usageLimitKind).toBe("total_cap");
    expect(updated.body.usageCap).toBe(5);
    // Switching back to unlimited clears the cap.
    const cleared = await agent
      .patch(`/api/coop/partnerships/${id}`)
      .set("x-tenant-id", String(hostId))
      .send({ usageLimitKind: "per_customer", usageCap: 5 })
      .expect(200);
    expect(cleared.body.usageLimitKind).toBe("per_customer");
    expect(cleared.body.usageCap).toBeNull();
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, id));
  });
});

describe("total-cap enforcement", () => {
  let id: number;
  let code: string;

  beforeAll(async () => {
    const res = await createPartnership(partnerAId, `Capped perk ${RUN}`, {
      usageLimitKind: "total_cap",
      usageCap: 2,
    }).expect(201);
    id = res.body.id;
    code = res.body.redemptionCode;
  });

  afterAll(async () => {
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, id));
  });

  const redeem = (passCode: string) =>
    agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(hostId))
      .send({ code, passCode });

  it("validates and redeems while under the cap", async () => {
    const v = await agent.get(`/api/coop/redemptions/${code}`).set("x-tenant-id", String(hostId)).expect(200);
    expect(v.body.valid).toBe(true);
    expect((await redeem(`${RUN}-cap-1`).expect(200)).body.valid).toBe(true);
    expect((await redeem(`${RUN}-cap-2`).expect(200)).body.valid).toBe(true);
  });

  it("rejects validation and redemption once the cap is hit, with a customer-safe reason", async () => {
    const v = await agent.get(`/api/coop/redemptions/${code}`).set("x-tenant-id", String(hostId)).expect(200);
    expect(v.body.valid).toBe(false);
    expect(v.body.reason).toBe("This perk has reached its redemption limit");
    // Redemption is blocked too — the limit is enforced on recorded rows,
    // not on the client honoring the validation result.
    const r = await redeem(`${RUN}-cap-3`).expect(200);
    expect(r.body.valid).toBe(false);
    expect(r.body.reason).toBe("This perk has reached its redemption limit");
  });

  it("never oversubscribes the cap under concurrent redemptions", async () => {
    // Fresh capped partnership: cap 1, five parallel distinct pass codes.
    const res = await createPartnership(partnerBId, `Race cap ${RUN}`, {
      usageLimitKind: "total_cap",
      usageCap: 1,
    }).expect(201);
    try {
      const raceCode = res.body.redemptionCode as string;
      const fire = (n: number) =>
        agent
          .post("/api/coop/redemptions")
          .set("x-tenant-id", String(hostId))
          .send({ code: raceCode, passCode: `${RUN}-race-${n}` });
      const results = await Promise.all([1, 2, 3, 4, 5].map(fire));
      const wins = results.filter((r) => r.body.valid === true);
      expect(wins).toHaveLength(1); // exactly one redemption ever counted
      const rows = await db
        .select({ id: coopPerkRedemptionsTable.id })
        .from(coopPerkRedemptionsTable)
        .where(eq(coopPerkRedemptionsTable.partnershipId, res.body.id));
      expect(rows).toHaveLength(1);
    } finally {
      await db
        .delete(merchantCoopPartnershipsTable)
        .where(eq(merchantCoopPartnershipsTable.id, res.body.id));
    }
  });

  it("window expiry outranks the limit message once the perk expires", async () => {
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ perkEndsAt: new Date(Date.now() - 60_000) })
      .where(eq(merchantCoopPartnershipsTable.id, id));
    const v = await agent.get(`/api/coop/redemptions/${code}`).set("x-tenant-id", String(hostId)).expect(200);
    expect(v.body.valid).toBe(false);
    expect(v.body.reason).toBe("This perk has expired");
  });
});

describe("per-customer enforcement", () => {
  let id: number;
  let code: string;

  beforeAll(async () => {
    const res = await createPartnership(partnerBId, `Once each ${RUN}`, {
      usageLimitKind: "per_customer",
    }).expect(201);
    id = res.body.id;
    code = res.body.redemptionCode;
  });

  afterAll(async () => {
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, id));
  });

  const redeem = (passCode: string) =>
    agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(hostId))
      .send({ code, passCode });

  it("allows the first redemption per customer, rejects the repeat distinctly", async () => {
    expect((await redeem(`${RUN}-cust-1`).expect(200)).body.valid).toBe(true);
    const again = await redeem(`${RUN}-cust-1`).expect(200);
    expect(again.body.valid).toBe(false);
    expect(again.body.reason).toBe("This perk has already been redeemed by this customer");
    // A different customer identity still redeems fine.
    expect((await redeem(`${RUN}-cust-2`).expect(200)).body.valid).toBe(true);
  });

  it("keeps bare-code validation green (no customer identity to check)", async () => {
    const v = await agent.get(`/api/coop/redemptions/${code}`).set("x-tenant-id", String(hostId)).expect(200);
    expect(v.body.valid).toBe(true);
  });

  it("fails when the partnership goes inactive, regardless of limit state", async () => {
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: false })
      .where(eq(merchantCoopPartnershipsTable.id, id));
    const v = await agent.get(`/api/coop/redemptions/${code}`).set("x-tenant-id", String(hostId)).expect(200);
    expect(v.body.valid).toBe(false);
    expect(v.body.reason).toBe("This partnership is no longer active");
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: true })
      .where(eq(merchantCoopPartnershipsTable.id, id));
  });
});

describe("public booking confirmation perk surface", () => {
  let activeId: number;
  let inactiveId: number;
  let expiredId: number;
  const ids: number[] = [];

  beforeAll(async () => {
    activeId = (await createPartnership(partnerAId, `Live perk ${RUN}`).expect(201)).body.id;
    inactiveId = (await createPartnership(partnerBId, `Paused perk ${RUN}`).expect(201)).body.id;
    expiredId = (await createPartnership(partnerCId, `Expired perk ${RUN}`).expect(201)).body.id;
    ids.push(activeId, inactiveId, expiredId);
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ isActive: false })
      .where(eq(merchantCoopPartnershipsTable.id, inactiveId));
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ perkEndsAt: new Date(Date.now() - 60_000) })
      .where(eq(merchantCoopPartnershipsTable.id, expiredId));
  });

  afterAll(async () => {
    if (ids.length) {
      await db
        .delete(merchantCoopPartnershipsTable)
        .where(inArray(merchantCoopPartnershipsTable.id, ids));
    }
  });

  it("serves only active in-window perks, with the disclaimer and no raw code", async () => {
    const res = await anon.get(`/api/public/booking/${RUN}-host/perks`).expect(200);
    expect(typeof res.body.disclaimer).toBe("string");
    expect(res.body.disclaimer.length).toBeGreaterThan(0);
    const perks = res.body.perks as Record<string, unknown>[];
    const perkIds = perks.map((p) => p.id);
    expect(perkIds).toContain(activeId);
    expect(perkIds).not.toContain(inactiveId);
    expect(perkIds).not.toContain(expiredId);
    // The raw redemption code must never reach the customer-facing surface.
    for (const p of perks) {
      expect(p).not.toHaveProperty("redemptionCode");
      expect(p).toHaveProperty("partnerName");
      expect(p).toHaveProperty("perkTitle");
      expect(p).toHaveProperty("perkEndsAt");
    }
  });
});
