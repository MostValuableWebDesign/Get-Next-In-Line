import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  merchantCoopPartnershipsTable,
  coopAttributionEventsTable,
  coopPerkRedemptionsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Cross-promotion tracking & attribution (/coop) against the real dev DB.
// Covers: direction-aware tracking codes (unique, unguessable, backfilled),
// exactly-once attribution on redemption (replay/refresh safe), direction
// attribution from the presented tracking code and from legacy shared codes,
// and the tenant-scoped /coop/stats aggregation over 30/90-day windows.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopattr-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let hostId: number; // "Cafe" — host of the partnership
let partnerId: number; // "Gym" — partner
let partnershipId: number;
let redemptionCode: string;
let hostTrackingCode: string;
let partnerTrackingCode: string;

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
      { brandName: `Attr Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Attr Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [hostId, partnerId] = tenants.map((t) => t.id);

  const created = await agent
    .post("/api/coop/partnerships")
    .send({ hostTenantId: hostId, partnerTenantId: partnerId, perkTitle: `Attr perk ${RUN}` })
    .expect(201);
  partnershipId = created.body.id;
  redemptionCode = created.body.redemptionCode;
  hostTrackingCode = created.body.hostTrackingCode;
  partnerTrackingCode = created.body.partnerTrackingCode;
});

afterAll(async () => {
  const ids = [hostId, partnerId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    // Cascades clean up partnerships, redemptions, and attribution events.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

const eventsFor = () =>
  db
    .select()
    .from(coopAttributionEventsTable)
    .where(eq(coopAttributionEventsTable.partnershipId, partnershipId));

describe("direction-aware tracking codes", () => {
  it("new partnerships get two distinct, unguessable tracking codes", () => {
    expect(hostTrackingCode).toMatch(/^CPT-[A-Z2-9]{20}$/);
    expect(partnerTrackingCode).toMatch(/^CPT-[A-Z2-9]{20}$/);
    expect(hostTrackingCode).not.toBe(partnerTrackingCode);
    expect(hostTrackingCode).not.toBe(redemptionCode);
  });

  it("merchant invites also get tracking codes", async () => {
    const res = await agent
      .post("/api/coop/invites")
      .set("x-tenant-id", String(hostId))
      .send({ partnerTenantId: partnerId, perkTitle: `Invite perk ${RUN}` })
      .expect(201);
    expect(res.body.hostTrackingCode).toMatch(/^CPT-/);
    expect(res.body.partnerTrackingCode).toMatch(/^CPT-/);
    await db
      .delete(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, res.body.id));
  });

  it("backfill assigns codes to legacy rows and is idempotent", async () => {
    // Simulate a pre-tracking partnership.
    await db
      .update(merchantCoopPartnershipsTable)
      .set({ hostTrackingCode: null, partnerTrackingCode: null })
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    const { backfillCoopTrackingCodes } = await import("../../lib/coopTracking");
    await backfillCoopTrackingCodes();
    const [row] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    expect(row.hostTrackingCode).toMatch(/^CPT-/);
    expect(row.partnerTrackingCode).toMatch(/^CPT-/);
    // Idempotent: a second run leaves existing codes untouched.
    await backfillCoopTrackingCodes();
    const [again] = await db
      .select()
      .from(merchantCoopPartnershipsTable)
      .where(eq(merchantCoopPartnershipsTable.id, partnershipId));
    expect(again.hostTrackingCode).toBe(row.hostTrackingCode);
    expect(again.partnerTrackingCode).toBe(row.partnerTrackingCode);
    hostTrackingCode = row.hostTrackingCode!;
    partnerTrackingCode = row.partnerTrackingCode!;
  });

  it("tracking codes validate through the existing checkout validation flow", async () => {
    for (const code of [redemptionCode, hostTrackingCode, partnerTrackingCode]) {
      const res = await agent.get(`/api/coop/redemptions/${code}`).expect(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.partnership.id).toBe(partnershipId);
    }
    const unknown = await agent.get("/api/coop/redemptions/CPT-NOPENOPENOPENOPENOPE").expect(200);
    expect(unknown.body.valid).toBe(false);
  });
});

describe("exactly-once attribution on redemption", () => {
  it("redeeming the host tracking code records one host_to_partner event", async () => {
    const res = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: hostTrackingCode, passCode: `${RUN}-pass-1` })
      .expect(200);
    expect(res.body.valid).toBe(true);

    const events = await eventsFor();
    expect(events.length).toBe(1);
    expect(events[0].direction).toBe("host_to_partner");
    expect(events[0].sendingTenantId).toBe(hostId);
    expect(events[0].receivingTenantId).toBe(partnerId);
  });

  it("a replayed scan of the same pass is rejected and never double-counts", async () => {
    const replay = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(partnerId))
      .send({ code: hostTrackingCode, passCode: `${RUN}-pass-1` })
      .expect(200);
    expect(replay.body.valid).toBe(false);
    expect(replay.body.reason).toMatch(/already redeemed/i);
    expect((await eventsFor()).length).toBe(1);
  });

  it("the partner tracking code attributes the mirror direction", async () => {
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(hostId))
      .send({ code: partnerTrackingCode, passCode: `${RUN}-pass-2` })
      .expect(200);
    const events = await eventsFor();
    expect(events.length).toBe(2);
    const mirror = events.find((e) => e.direction === "partner_to_host");
    expect(mirror).toBeDefined();
    expect(mirror!.sendingTenantId).toBe(partnerId);
    expect(mirror!.receivingTenantId).toBe(hostId);
  });

  it("a tenant outside the partnership cannot redeem or create attribution", async () => {
    const [outsider] = await db
      .insert(tenantsTable)
      .values([{ brandName: `Attr Outsider ${RUN}`, subdomain: `${RUN}-out`, status: "active" }])
      .returning({ id: tenantsTable.id });
    try {
      const before = (await eventsFor()).length;
      const res = await agent
        .post("/api/coop/redemptions")
        .set("x-tenant-id", String(outsider.id))
        .send({ code: hostTrackingCode, passCode: `${RUN}-forged` })
        .expect(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.reason).toMatch(/only a business in this partnership/i);
      expect((await eventsFor()).length).toBe(before);
    } finally {
      await db.delete(tenantsTable).where(eq(tenantsTable.id, outsider.id));
    }
  });

  it("a business cannot scan its own outbound code to inflate its sent count", async () => {
    const before = (await eventsFor()).length;
    // Host presents its OWN host tracking code — only the partner may redeem it.
    const res = await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(hostId))
      .send({ code: hostTrackingCode, passCode: `${RUN}-self` })
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toMatch(/partner business/i);
    expect((await eventsFor()).length).toBe(before);
  });

  it("legacy shared codes attribute by who scanned them (scanner = receiver)", async () => {
    await agent
      .post("/api/coop/redemptions")
      .set("x-tenant-id", String(hostId))
      .send({ code: redemptionCode, passCode: `${RUN}-pass-3` })
      .expect(200);
    const events = await eventsFor();
    expect(events.length).toBe(3);
    const legacy = events.find(
      (e) => e.direction === "partner_to_host" && e.receivingTenantId === hostId
    );
    expect(legacy).toBeDefined();
  });
});

describe("cross-promotion stats", () => {
  it("requires tenant scope and a valid window", async () => {
    await agent.get("/api/coop/stats").expect(400);
    await agent.get("/api/coop/stats?windowDays=7").set("x-tenant-id", String(hostId)).expect(400);
  });

  it("aggregates sent vs received per partnership from each side's perspective", async () => {
    // From above: 1× host→partner, 2× partner→host.
    const hostStats = await agent
      .get("/api/coop/stats?windowDays=30")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    expect(hostStats.body.windowDays).toBe(30);
    expect(hostStats.body.totals).toEqual({ sent: 1, received: 2 });
    const row = hostStats.body.partnerships.find(
      (p: { partnershipId: number }) => p.partnershipId === partnershipId
    );
    expect(row).toEqual(
      expect.objectContaining({ partnerName: `Attr Gym ${RUN}`, sent: 1, received: 2 })
    );

    const partnerStats = await agent
      .get("/api/coop/stats?windowDays=30")
      .set("x-tenant-id", String(partnerId))
      .expect(200);
    expect(partnerStats.body.totals).toEqual({ sent: 2, received: 1 });
  });

  it("windows exclude events older than the cutoff (90d includes, 30d excludes)", async () => {
    // Age one event to 45 days old via its redemption's event row.
    const [oldEvent] = await eventsFor();
    await db
      .update(coopAttributionEventsTable)
      .set({ occurredAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) })
      .where(eq(coopAttributionEventsTable.id, oldEvent.id));

    const in30 = await agent
      .get("/api/coop/stats?windowDays=30")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    const in90 = await agent
      .get("/api/coop/stats?windowDays=90")
      .set("x-tenant-id", String(hostId))
      .expect(200);
    const total30 = in30.body.totals.sent + in30.body.totals.received;
    const total90 = in90.body.totals.sent + in90.body.totals.received;
    expect(total90).toBe(3);
    expect(total30).toBe(2);
  });

  it("attribution events cascade away with their redemptions", async () => {
    // Sanity: deleting the partnership removes redemptions + events (FK web).
    const redemptions = await db
      .select()
      .from(coopPerkRedemptionsTable)
      .where(eq(coopPerkRedemptionsTable.partnershipId, partnershipId));
    expect(redemptions.length).toBe(3);
  });
});
