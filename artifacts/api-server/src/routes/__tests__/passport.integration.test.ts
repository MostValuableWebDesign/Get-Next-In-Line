import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  merchantCoopPartnershipsTable,
  passportIdentitiesTable,
  passportStampsTable,
  passportChallengesTable,
  passportRewardIssuancesTable,
} from "@workspace/db";
import { eq, inArray, like, sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Neighborhood Passport & Achievements against the real dev DB.
// Covers: automatic stamping on classic perk redemption (unique per
// identity+business), cross-tenant identity matching by normalized phone,
// rolling-window milestone completion with exactly-once reward issuance and
// the passport_reward message, merchant challenge CRUD + completion counts,
// and the consumer wallet passport view. SMS is simulated (Twilio removed).
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `passport-${Date.now()}-${process.pid}`;
// Unique per-run phone block so cross-run identities never collide.
const phoneBase = 4000000000 + (Date.now() % 900000000);
const phone = (n: number) => `+1${phoneBase + n}`;

let agent: ReturnType<typeof request.agent>;
let cafeId: number;
let gymId: number;
let bakeryId: number;
// The traveling customer (same phone at every business).
let cafeCustomerId: number;
let gymCustomerId: number;
let bakeryCustomerId: number;

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
      { brandName: `Pass Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Pass Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Pass Bakery ${RUN}`, subdomain: `${RUN}-bakery`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [cafeId, gymId, bakeryId] = tenants.map((t) => t.id);

  // Cafe↔Gym and Cafe↔Bakery accepted+active partnerships with unique codes.
  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: cafeId,
      partnerTenantId: gymId,
      perkTitle: `Passport perk gym ${RUN}`,
      redemptionCode: `PSPT-GYM-${RUN}`,
      status: "accepted",
      isActive: true,
    },
    {
      hostTenantId: cafeId,
      partnerTenantId: bakeryId,
      perkTitle: `Passport perk bakery ${RUN}`,
      redemptionCode: `PSPT-BAK-${RUN}`,
      status: "accepted",
      isActive: true,
    },
  ]);

  // The same person exists as a tenant-scoped customer at all three
  // businesses — the passport must merge them into one identity by phone.
  const customers = await db
    .insert(sosCustomersTable)
    .values([
      { tenantId: cafeId, name: `Traveler ${RUN}`, phone: phone(1), smsOptIn: true },
      { tenantId: gymId, name: `Traveler G ${RUN}`, phone: phone(1), smsOptIn: true },
      { tenantId: bakeryId, name: `Traveler B ${RUN}`, phone: phone(1), smsOptIn: true },
    ])
    .returning({ id: sosCustomersTable.id });
  [cafeCustomerId, gymCustomerId, bakeryCustomerId] = customers.map((c) => c.id);
});

afterAll(async () => {
  // Tenants cascade partnerships, customers, redemptions, challenges, stamps.
  const ids = [cafeId, gymId, bakeryId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
  // Passport identities are global (no tenant FK) — clean this run's block.
  await db
    .delete(passportIdentitiesTable)
    .where(like(passportIdentitiesTable.phone, `+1${phoneBase}%`));
});

const redeem = (scannerTenantId: number, code: string, passCode: string) =>
  agent
    .post("/api/coop/redemptions")
    .set("x-tenant-id", String(scannerTenantId))
    .send({ code, passCode });

async function identityByPhone(p: string) {
  const [row] = await db
    .select()
    .from(passportIdentitiesTable)
    .where(eq(passportIdentitiesTable.phone, p));
  return row;
}

describe("stamping on perk redemption", () => {
  it("a classic redemption stamps the redeeming business automatically", async () => {
    // Gym scans the cafe customer's pass (cafe → gym crossover).
    const res = await redeem(gymId, `PSPT-GYM-${RUN}`, `C${cafeCustomerId}`).expect(200);
    expect(res.body.valid).toBe(true);

    const identity = await identityByPhone(phone(1));
    expect(identity).toBeDefined();
    const stamps = await db
      .select()
      .from(passportStampsTable)
      .where(eq(passportStampsTable.identityId, identity.id));
    expect(stamps).toHaveLength(1);
    expect(stamps[0].tenantId).toBe(gymId);
  });

  it("redemptions at different businesses land on ONE identity (cross-tenant match by phone)", async () => {
    // Bakery scans the gym customer's pass — different tenant-scoped
    // customer record, same phone → same passport.
    await redeem(bakeryId, `PSPT-BAK-${RUN}`, `C${gymCustomerId}`).expect(200);

    const identities = await db
      .select()
      .from(passportIdentitiesTable)
      .where(eq(passportIdentitiesTable.phone, phone(1)));
    expect(identities).toHaveLength(1);
    const stamps = await db
      .select()
      .from(passportStampsTable)
      .where(eq(passportStampsTable.identityId, identities[0].id));
    expect(stamps.map((s) => s.tenantId).sort()).toEqual([gymId, bakeryId].sort());
  });

  it("a repeat redemption at an already-stamped business adds no stamp", async () => {
    // Same customer, same business, different pass instance.
    await redeem(gymId, `PSPT-GYM-${RUN}`, `C${bakeryCustomerId}`).expect(200);
    const identity = await identityByPhone(phone(1));
    const stamps = await db
      .select()
      .from(passportStampsTable)
      .where(eq(passportStampsTable.identityId, identity.id));
    expect(stamps).toHaveLength(2); // still gym + bakery only
  });
});

describe("merchant challenge CRUD", () => {
  let challengeId: number;

  it("requires a tenant scope", async () => {
    await agent.get("/api/coop/passport/challenges").expect(400);
  });

  it("creates a sponsored challenge", async () => {
    const res = await agent
      .post("/api/coop/passport/challenges")
      .set("x-tenant-id", String(cafeId))
      .send({
        title: `Explorer ${RUN}`,
        requiredBusinesses: 2,
        windowDays: 30,
        rewardType: "sweepstakes_entry",
        rewardDescription: `Grand raffle ${RUN}`,
      })
      .expect(201);
    challengeId = res.body.id;
    expect(res.body.sponsorTenantId).toBe(cafeId);
    expect(res.body.isActive).toBe(true);
    expect(res.body.completionCount).toBe(0);
  });

  it("rejects an inverted date window", async () => {
    await agent
      .post("/api/coop/passport/challenges")
      .set("x-tenant-id", String(cafeId))
      .send({
        title: `Bad ${RUN}`,
        requiredBusinesses: 2,
        windowDays: 30,
        rewardType: "bonus_perk",
        rewardDescription: "x",
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date().toISOString(),
      })
      .expect(400);
  });

  it("lists only the sponsor's challenges", async () => {
    const mine = await agent
      .get("/api/coop/passport/challenges")
      .set("x-tenant-id", String(cafeId))
      .expect(200);
    expect(mine.body.some((c: { id: number }) => c.id === challengeId)).toBe(true);
    const other = await agent
      .get("/api/coop/passport/challenges")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    expect(other.body.some((c: { id: number }) => c.id === challengeId)).toBe(false);
  });

  it("only the sponsor can edit; pause/activate round-trips", async () => {
    await agent
      .patch(`/api/coop/passport/challenges/${challengeId}`)
      .set("x-tenant-id", String(gymId))
      .send({ isActive: false })
      .expect(404);
    const paused = await agent
      .patch(`/api/coop/passport/challenges/${challengeId}`)
      .set("x-tenant-id", String(cafeId))
      .send({ isActive: false })
      .expect(200);
    expect(paused.body.isActive).toBe(false);
    const active = await agent
      .patch(`/api/coop/passport/challenges/${challengeId}`)
      .set("x-tenant-id", String(cafeId))
      .send({ isActive: true, title: `Explorer v2 ${RUN}` })
      .expect(200);
    expect(active.body.isActive).toBe(true);
    expect(active.body.title).toBe(`Explorer v2 ${RUN}`);
  });
});

describe("milestone completion, rolling window, and exactly-once rewards", () => {
  it("issues the reward once when the identity hits N distinct businesses in-window", async () => {
    const { findOrCreatePassportIdentity, evaluatePassportChallenges } = await import(
      "../../lib/passport"
    );
    // Fresh person with 2 in-window stamps + 1 stale stamp (outside 30 days).
    const identity = await findOrCreatePassportIdentity({ phone: phone(2), name: `Two ${RUN}` });
    expect(identity).not.toBeNull();
    const now = new Date();
    await db.insert(passportStampsTable).values([
      { identityId: identity!.id, tenantId: cafeId, stampedAt: now },
      { identityId: identity!.id, tenantId: gymId, stampedAt: now },
      // Stale: outside the 30-day rolling window — must not count.
      {
        identityId: identity!.id,
        tenantId: bakeryId,
        stampedAt: new Date(now.getTime() - 40 * 86_400_000),
      },
    ]);

    // Cafe's challenge (from the CRUD suite) requires 2 businesses in 30 days.
    const first = await evaluatePassportChallenges(identity!, now);
    expect(first).toBe(1);
    // Re-processing is a no-op (unique challenge+identity lock).
    const second = await evaluatePassportChallenges(identity!, now);
    expect(second).toBe(0);

    const issuances = await db
      .select()
      .from(passportRewardIssuancesTable)
      .where(eq(passportRewardIssuancesTable.identityId, identity!.id));
    expect(issuances).toHaveLength(1);
    expect(issuances[0].rewardType).toBe("sweepstakes_entry");
    expect(issuances[0].stampCount).toBe(2); // stale bakery stamp excluded
  });

  it("does not complete when in-window distinct businesses are below N", async () => {
    const { findOrCreatePassportIdentity, evaluatePassportChallenges } = await import(
      "../../lib/passport"
    );
    const identity = await findOrCreatePassportIdentity({ phone: phone(3) });
    await db.insert(passportStampsTable).values([
      { identityId: identity!.id, tenantId: cafeId },
    ]);
    expect(await evaluatePassportChallenges(identity!)).toBe(0);
  });

  it("records the reward announcement as a marketing-origin passport_reward message", async () => {
    const result = await db.execute(
      sql`select origin, kind, to_number from messages where kind = 'passport_reward' and tenant_id = ${cafeId}`,
    );
    const rows = result.rows as Array<{ origin: string; to_number: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].origin).toBe("marketing");
    expect(rows[0].to_number).toBe(phone(2));
  });

  it("paused challenges never complete", async () => {
    const { findOrCreatePassportIdentity, evaluatePassportChallenges } = await import(
      "../../lib/passport"
    );
    // Pause the cafe challenge, then bring a fully-qualified fresh identity.
    await db
      .update(passportChallengesTable)
      .set({ isActive: false })
      .where(eq(passportChallengesTable.sponsorTenantId, cafeId));
    const identity = await findOrCreatePassportIdentity({ phone: phone(4) });
    await db.insert(passportStampsTable).values([
      { identityId: identity!.id, tenantId: cafeId },
      { identityId: identity!.id, tenantId: gymId },
    ]);
    expect(await evaluatePassportChallenges(identity!)).toBe(0);
  });
});

describe("opt-out and split-identity safeguards", () => {
  it("never texts a phone that has opted out anywhere on the network", async () => {
    const { findOrCreatePassportIdentity, evaluatePassportChallenges } = await import(
      "../../lib/passport"
    );
    // Re-activate the cafe challenge (paused in the previous suite).
    await db
      .update(passportChallengesTable)
      .set({ isActive: true })
      .where(eq(passportChallengesTable.sponsorTenantId, cafeId));
    // The person has STOPped at the gym (tenant-scoped record).
    await db.insert(sosCustomersTable).values({
      tenantId: gymId,
      name: `Stopped ${RUN}`,
      phone: phone(6),
      smsOptIn: false,
    });
    const identity = await findOrCreatePassportIdentity({ phone: phone(6) });
    await db.insert(passportStampsTable).values([
      { identityId: identity!.id, tenantId: cafeId },
      { identityId: identity!.id, tenantId: gymId },
    ]);
    // Reward IS issued (they earned it) — but no SMS goes out.
    expect(await evaluatePassportChallenges(identity!)).toBe(1);
    const result = await db.execute(
      sql`select id from messages where kind = 'passport_reward' and to_number = ${phone(6)}`,
    );
    expect(result.rows).toHaveLength(0);
  });

  it("merges split phone/email identities into one passport", async () => {
    const { findOrCreatePassportIdentity } = await import("../../lib/passport");
    const email = `traveler-${RUN}@example.com`;
    // Row A known only by phone (with a stamp), row B only by email (with a
    // different stamp).
    const byPhone = await findOrCreatePassportIdentity({ phone: phone(7) });
    const byEmail = await findOrCreatePassportIdentity({ email });
    expect(byPhone!.id).not.toBe(byEmail!.id);
    await db.insert(passportStampsTable).values([
      { identityId: byPhone!.id, tenantId: cafeId },
      { identityId: byEmail!.id, tenantId: gymId },
      // Overlapping stamp — must dedupe on merge.
      { identityId: byEmail!.id, tenantId: cafeId },
    ]);

    // A lookup carrying BOTH keys reveals they are the same person → merge.
    const merged = await findOrCreatePassportIdentity({ phone: phone(7), email });
    expect(merged!.id).toBe(byPhone!.id); // phone-matched row wins
    expect(merged!.email).toBe(email);

    const survivors = await db
      .select()
      .from(passportIdentitiesTable)
      .where(eq(passportIdentitiesTable.email, email));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe(byPhone!.id);

    const stamps = await db
      .select()
      .from(passportStampsTable)
      .where(eq(passportStampsTable.identityId, byPhone!.id));
    expect(stamps.map((s) => s.tenantId).sort()).toEqual([cafeId, gymId].sort());
  });
});

describe("consumer passport view", () => {
  it("assembles stamps, tiers, progress, and rewards for a phone", async () => {
    const { buildPassportView } = await import("../../lib/passport");
    const view = await buildPassportView({ phone: phone(2) });
    expect(view.stampCount).toBe(3);
    // 3 stamps unlock "Neighborhood Regular" but not "Local VIP".
    expect(view.currentTier).toBe("Neighborhood Regular");
    expect(view.tiers.find((t) => t.name === "Local VIP")?.unlocked).toBe(false);
    expect(view.rewards).toHaveLength(1);
    expect(view.rewards[0].rewardType).toBe("sweepstakes_entry");
    expect(view.rewards[0].sponsorName).toBe(`Pass Cafe ${RUN}`);
  });

  it("returns an empty shell for an unknown person", async () => {
    const { buildPassportView } = await import("../../lib/passport");
    const view = await buildPassportView({ phone: phone(99) });
    expect(view.stampCount).toBe(0);
    expect(view.currentTier).toBeNull();
    expect(view.rewards).toHaveLength(0);
  });
});
