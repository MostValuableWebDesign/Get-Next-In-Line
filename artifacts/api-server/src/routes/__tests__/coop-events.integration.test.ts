import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  merchantCoopPartnershipsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Community Event & Sponsorship Sync (/coop/events) against the real
// dev DB. Covers: partnership-gated event creation (partner-only invitee
// rule), the invite accept/decline lifecycle with double-respond guards and
// pending/declined exclusion from passes/settlement, even and proportional
// expense split math including cent rounding, check-in attribution via
// storefront vs unified codes, the joint announcement broadcast fan-out with
// dedupe/opt-out skips and the send-once lock, and tenant isolation.
// SMS is simulated (Twilio env removed below).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `coopevt-${Date.now()}-${process.pid}`;
// Unique per-run phone block so rows never collide across parallel runs.
const phoneBase = 4000000000 + (Date.now() % 1000000000);
const phone = (n: number) => `+1${phoneBase + n}`;

let agent: ReturnType<typeof request.agent>;
let bakeryId: number; // host
let gymId: number; // partner (accepts)
let floristId: number; // partner (declines)
let booksId: number; // partner (never responds — stays pending)
let outsiderId: number; // no partnership with bakery

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
      { brandName: `Evt Bakery ${RUN}`, subdomain: `${RUN}-bakery`, status: "active" },
      { brandName: `Evt Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Evt Florist ${RUN}`, subdomain: `${RUN}-florist`, status: "active" },
      { brandName: `Evt Books ${RUN}`, subdomain: `${RUN}-books`, status: "active" },
      { brandName: `Evt Outsider ${RUN}`, subdomain: `${RUN}-outsider`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [bakeryId, gymId, floristId, booksId, outsiderId] = tenants.map((t) => t.id);

  // Bakery ↔ Gym, Bakery ↔ Florist, Bakery ↔ Books are accepted + active.
  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: bakeryId,
      partnerTenantId: gymId,
      perkTitle: `Evt perk gym ${RUN}`,
      redemptionCode: `EVTP-GYM-${RUN}`,
      status: "accepted",
      isActive: true,
    },
    {
      hostTenantId: floristId,
      partnerTenantId: bakeryId,
      perkTitle: `Evt perk florist ${RUN}`,
      redemptionCode: `EVTP-FLO-${RUN}`,
      status: "accepted",
      isActive: true,
    },
    {
      hostTenantId: bakeryId,
      partnerTenantId: booksId,
      perkTitle: `Evt perk books ${RUN}`,
      redemptionCode: `EVTP-BOOK-${RUN}`,
      status: "accepted",
      isActive: true,
    },
  ]);

  // Customers: bakery has two opted-in (one phone shared with gym's customer)
  // and one opted-out; gym has the shared-phone customer plus one more.
  await db.insert(sosCustomersTable).values([
    { tenantId: bakeryId, name: `Ann ${RUN}`, phone: phone(1), smsOptIn: true },
    { tenantId: bakeryId, name: `OptOut ${RUN}`, phone: phone(2), smsOptIn: false },
    { tenantId: bakeryId, name: `Shared ${RUN}`, phone: phone(3), smsOptIn: true },
    { tenantId: gymId, name: `GymShared ${RUN}`, phone: phone(3), smsOptIn: true },
    { tenantId: gymId, name: `Gia ${RUN}`, phone: phone(4), smsOptIn: true },
  ]);
});

afterAll(async () => {
  const ids = [bakeryId, gymId, floristId, booksId, outsiderId].filter((n) =>
    Number.isInteger(n),
  );
  if (ids.length) {
    // Cascades clean partnerships, customers, events, participants,
    // expenses, and check-ins.
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
});

const startsAt = new Date(Date.now() - 60_000).toISOString(); // already live
const endsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();

let eventId: number;
let unifiedCode: string;
let bakeryCode: string;
let gymCode: string;

describe("co-op event creation", () => {
  it("rejects creation without a tenant scope", async () => {
    await agent
      .post("/api/coop/events")
      .send({ name: "x", startsAt, endsAt, partnerTenantIds: [gymId] })
      .expect(400);
  });

  it("blocks tenants with no accepted active partnership", async () => {
    const res = await agent
      .post("/api/coop/events")
      .set("x-tenant-id", String(outsiderId))
      .send({ name: "Nope", startsAt, endsAt, partnerTenantIds: [gymId] })
      .expect(403);
    expect(res.body.message).toMatch(/accepted, active co-op partnership/);
  });

  it("blocks inviting a business that is not a current partner", async () => {
    await agent
      .post("/api/coop/events")
      .set("x-tenant-id", String(bakeryId))
      .send({ name: "Nope", startsAt, endsAt, partnerTenantIds: [outsiderId] })
      .expect(403);
  });

  it("creates the event with the host accepted and invitees pending", async () => {
    const res = await agent
      .post("/api/coop/events")
      .set("x-tenant-id", String(bakeryId))
      .send({
        name: `Holiday Drive ${RUN}`,
        description: "Neighborhood toy drive",
        location: "Riverside Plaza",
        startsAt,
        endsAt,
        partnerTenantIds: [gymId, floristId, booksId],
      })
      .expect(201);
    eventId = res.body.id;
    expect(res.body.isHost).toBe(true);
    expect(res.body.myStatus).toBe("accepted");
    expect(res.body.phase).toBe("live");
    expect(res.body.acceptedCount).toBe(1);
    const byTenant = Object.fromEntries(
      res.body.participants.map((p: { tenantId: number; status: string }) => [p.tenantId, p.status]),
    );
    expect(byTenant[bakeryId]).toBe("accepted");
    expect(byTenant[gymId]).toBe("invited");
    expect(byTenant[floristId]).toBe("invited");
  });

  it("shows the event on each invitee's calendar as a pending invite", async () => {
    const res = await agent
      .get("/api/coop/events")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    const mine = res.body.find((e: { id: number }) => e.id === eventId);
    expect(mine.myStatus).toBe("invited");
    expect(mine.isHost).toBe(false);
  });

  it("hides the event from non-participants entirely", async () => {
    const list = await agent
      .get("/api/coop/events")
      .set("x-tenant-id", String(outsiderId))
      .expect(200);
    expect(list.body.find((e: { id: number }) => e.id === eventId)).toBeUndefined();
    await agent
      .get(`/api/coop/events/${eventId}`)
      .set("x-tenant-id", String(outsiderId))
      .expect(403);
  });
});

describe("invite lifecycle", () => {
  it("host cannot respond to its own event", async () => {
    await agent
      .post(`/api/coop/events/${eventId}/respond`)
      .set("x-tenant-id", String(bakeryId))
      .send({ action: "accept" })
      .expect(403);
  });

  it("gym accepts and receives a storefront check-in code", async () => {
    const res = await agent
      .post(`/api/coop/events/${eventId}/respond`)
      .set("x-tenant-id", String(gymId))
      .send({ action: "accept" })
      .expect(200);
    expect(res.body.myStatus).toBe("accepted");
    expect(res.body.acceptedCount).toBe(2);
  });

  it("florist declines", async () => {
    const res = await agent
      .post(`/api/coop/events/${eventId}/respond`)
      .set("x-tenant-id", String(floristId))
      .send({ action: "decline" })
      .expect(200);
    expect(res.body.myStatus).toBe("declined");
  });

  it("guards against a double respond", async () => {
    await agent
      .post(`/api/coop/events/${eventId}/respond`)
      .set("x-tenant-id", String(gymId))
      .send({ action: "decline" })
      .expect(409);
  });

  it("pending and declined participants never appear in passes, settlement, or attendance", async () => {
    const res = await agent
      .get(`/api/coop/events/${eventId}`)
      .set("x-tenant-id", String(bakeryId))
      .expect(200);
    unifiedCode = res.body.passes.find((p: { tenantId: number | null }) => p.tenantId === null).code;
    bakeryCode = res.body.passes.find((p: { tenantId: number | null }) => p.tenantId === bakeryId).code;
    gymCode = res.body.passes.find((p: { tenantId: number | null }) => p.tenantId === gymId).code;
    const passTenants = res.body.passes.map((p: { tenantId: number | null }) => p.tenantId);
    expect(passTenants).not.toContain(floristId); // declined
    expect(passTenants).not.toContain(booksId); // still pending
    const settleTenants = res.body.settlement.map((s: { tenantId: number }) => s.tenantId);
    expect(settleTenants.sort()).toEqual([bakeryId, gymId].sort());
    const statTenants = res.body.attendance.byStorefront.map((s: { tenantId: number }) => s.tenantId);
    expect(statTenants).not.toContain(floristId);
    expect(statTenants).not.toContain(booksId);
  });

  it("a non-host partner only sees its own pass plus the unified pass", async () => {
    const res = await agent
      .get(`/api/coop/events/${eventId}`)
      .set("x-tenant-id", String(gymId))
      .expect(200);
    const tenants = res.body.passes.map((p: { tenantId: number | null }) => p.tenantId);
    expect(tenants.sort()).toEqual([gymId, null].sort());
  });
});

describe("expense ledger & split math", () => {
  it("rejects an expense from a pending participant", async () => {
    await agent
      .post(`/api/coop/events/${eventId}/expenses`)
      .set("x-tenant-id", String(booksId))
      .send({ description: "Nope", amount: 10 })
      .expect(403);
  });

  it("splits an even expense with cent rounding summing exactly", async () => {
    // $100.01 across bakery + gym → 5001 cents: 2501 to the lower tenant id.
    const res = await agent
      .post(`/api/coop/events/${eventId}/expenses`)
      .set("x-tenant-id", String(bakeryId))
      .send({ description: `Permits ${RUN}`, amount: 100.01, splitMethod: "even" })
      .expect(201);
    const exp = res.body.expenses.find((e: { description: string }) => e.description === `Permits ${RUN}`);
    const shareSum = exp.shares.reduce((s: number, x: { amount: number }) => s + Math.round(x.amount * 100), 0);
    expect(shareSum).toBe(10001);
    const low = Math.min(bakeryId, gymId);
    expect(exp.shares.find((s: { tenantId: number }) => s.tenantId === low).amount).toBeCloseTo(50.01, 2);
  });

  it("host sets proportional weights; proportional split honors them", async () => {
    // bakery weight 3, gym weight 1 → $100 proportional: bakery 75, gym 25.
    await agent
      .patch(`/api/coop/events/${eventId}/participants/${bakeryId}`)
      .set("x-tenant-id", String(bakeryId))
      .send({ shareWeight: 3 })
      .expect(200);
    const res = await agent
      .post(`/api/coop/events/${eventId}/expenses`)
      .set("x-tenant-id", String(gymId))
      .send({ description: `Rentals ${RUN}`, amount: 100, splitMethod: "proportional" })
      .expect(201);
    const exp = res.body.expenses.find((e: { description: string }) => e.description === `Rentals ${RUN}`);
    expect(exp.shares.find((s: { tenantId: number }) => s.tenantId === bakeryId).amount).toBe(75);
    expect(exp.shares.find((s: { tenantId: number }) => s.tenantId === gymId).amount).toBe(25);
  });

  it("only the host may set weights", async () => {
    await agent
      .patch(`/api/coop/events/${eventId}/participants/${gymId}`)
      .set("x-tenant-id", String(gymId))
      .send({ shareWeight: 5 })
      .expect(403);
  });

  it("settlement nets paid against owed for each accepted participant", async () => {
    const res = await agent
      .get(`/api/coop/events/${eventId}`)
      .set("x-tenant-id", String(gymId))
      .expect(200);
    const bakery = res.body.settlement.find((s: { tenantId: number }) => s.tenantId === bakeryId);
    const gym = res.body.settlement.find((s: { tenantId: number }) => s.tenantId === gymId);
    // Bakery paid 100.01; gym paid 100. Total 200.01 fully allocated.
    expect(bakery.paid).toBe(100.01);
    expect(gym.paid).toBe(100);
    expect(Math.round((bakery.net + gym.net) * 100)).toBe(0);
    // Even $100.01: bakery/gym get 50.01/50.00 (lower id gets the extra cent)
    // ordered by tenant id; proportional $100: bakery 75, gym 25.
    const low = Math.min(bakeryId, gymId);
    const bakeryEven = bakeryId === low ? 50.01 : 50.0;
    expect(bakery.owes).toBeCloseTo(bakeryEven + 75, 2);
  });
});

describe("check-in attribution", () => {
  it("rejects an unknown code", async () => {
    await agent
      .post("/api/coop/events/checkin")
      .send({ code: `EVS-NOPE-${RUN}` })
      .expect(400);
  });

  it("attributes storefront-code check-ins and counts unified-code ones", async () => {
    await agent.post("/api/coop/events/checkin").send({ code: gymCode, attendeeName: "Walk-in" }).expect(201);
    const second = await agent.post("/api/coop/events/checkin").send({ code: gymCode }).expect(201);
    expect(second.body.attributedTenantId).toBe(gymId);
    const bake = await agent.post("/api/coop/events/checkin").send({ code: bakeryCode }).expect(201);
    expect(bake.body.attributedTenantId).toBe(bakeryId);
    const uni = await agent.post("/api/coop/events/checkin").send({ code: unifiedCode }).expect(201);
    expect(uni.body.attributedTenantId).toBeNull();

    const res = await agent
      .get(`/api/coop/events/${eventId}`)
      .set("x-tenant-id", String(bakeryId))
      .expect(200);
    expect(res.body.attendance.totalCheckins).toBe(4);
    expect(res.body.attendance.unifiedCheckins).toBe(1);
    const gymStat = res.body.attendance.byStorefront.find((s: { tenantId: number }) => s.tenantId === gymId);
    const bakeStat = res.body.attendance.byStorefront.find((s: { tenantId: number }) => s.tenantId === bakeryId);
    expect(gymStat.checkins).toBe(2);
    expect(bakeStat.checkins).toBe(1);
  });
});

describe("joint announcement broadcast", () => {
  it("only the host can trigger it", async () => {
    await agent
      .post(`/api/coop/events/${eventId}/broadcast`)
      .set("x-tenant-id", String(gymId))
      .expect(403);
  });

  it("fans out per accepted participant, deduping shared phones and skipping opt-outs", async () => {
    const res = await agent
      .post(`/api/coop/events/${eventId}/broadcast`)
      .set("x-tenant-id", String(bakeryId))
      .expect(200);
    // Bakery: Ann sent, OptOut skipped, Shared sent. Gym: GymShared (same
    // phone as Shared) deduped/skipped, Gia sent. Florist declined → no sends.
    expect(res.body.totalCandidates).toBe(5);
    expect(res.body.sent).toBe(3);
    expect(res.body.skipped).toBe(2);
    const tenants = res.body.perTenant.map((t: { tenantId: number }) => t.tenantId);
    expect(tenants).not.toContain(floristId);
    expect(tenants).not.toContain(booksId);
  });

  it("the send-once lock rejects a second broadcast", async () => {
    await agent
      .post(`/api/coop/events/${eventId}/broadcast`)
      .set("x-tenant-id", String(bakeryId))
      .expect(409);
  });
});
