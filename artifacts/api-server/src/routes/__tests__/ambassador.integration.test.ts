import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  tenantsTable,
  sosCustomersTable,
  merchantCoopPartnershipsTable,
  passportIdentitiesTable,
  passportStampsTable,
  ambassadorPoolEntriesTable,
  ambassadorReferralsTable,
  ambassadorRewardsTable,
  ambassadorStatusTable,
  walletSessionsTable,
  usersTable,
  userTenantMembershipsTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Co-Op Referral Loyalty & Ambassador Program against the real dev DB.
// Covers: pool pledge accrual on perk redemption (idempotent, opted-in only),
// tier promotion from distinct-partner stamps and converted referrals,
// the referral loop (code minting, friend attach, anti-abuse guards,
// exactly-once conversion, reward minting for both parties), staff reward
// redemption with pool debit attributed to the converting business, the
// merchant program/ledger endpoints, and tenant scoping.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN;
delete process.env.REPLIT_CONNECTORS_HOSTNAME;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;

const RUN = `ambas-${Date.now()}-${process.pid}`;
// Unique per-run phone block so cross-run identities never collide.
const phoneBase = 4000000000 + (Date.now() % 900000000);
const phone = (n: number) => `+1${phoneBase + n}`;

let agent: ReturnType<typeof request.agent>;
let cafeId: number; // opted in
let gymId: number; // opted in
let bakeryId: number; // NOT opted in
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
      { brandName: `Amb Cafe ${RUN}`, subdomain: `${RUN}-cafe`, status: "active" },
      { brandName: `Amb Gym ${RUN}`, subdomain: `${RUN}-gym`, status: "active" },
      { brandName: `Amb Bakery ${RUN}`, subdomain: `${RUN}-bakery`, status: "active" },
    ])
    .returning({ id: tenantsTable.id });
  [cafeId, gymId, bakeryId] = tenants.map((t) => t.id);

  await db.insert(merchantCoopPartnershipsTable).values([
    {
      hostTenantId: cafeId,
      partnerTenantId: gymId,
      perkTitle: `Amb perk gym ${RUN}`,
      redemptionCode: `AMB-GYM-${RUN}`,
      status: "accepted",
      isActive: true,
    },
    {
      hostTenantId: cafeId,
      partnerTenantId: bakeryId,
      perkTitle: `Amb perk bakery ${RUN}`,
      redemptionCode: `AMB-BAK-${RUN}`,
      status: "accepted",
      isActive: true,
    },
  ]);

  // The referrer exists as a customer at all three businesses (same phone).
  const customers = await db
    .insert(sosCustomersTable)
    .values([
      { tenantId: cafeId, name: `Referrer ${RUN}`, phone: phone(1), smsOptIn: true },
      { tenantId: gymId, name: `Referrer G ${RUN}`, phone: phone(1), smsOptIn: true },
      { tenantId: bakeryId, name: `Referrer B ${RUN}`, phone: phone(1), smsOptIn: true },
    ])
    .returning({ id: sosCustomersTable.id });
  [cafeCustomerId, gymCustomerId, bakeryCustomerId] = customers.map((c) => c.id);

  // Cafe and Gym opt in ($6 pledge per redemption — two redemptions fund the
  // $10 referral reward pair); Bakery stays out.
  for (const [tid, pledge] of [
    [cafeId, 6],
    [gymId, 6],
  ] as const) {
    await agent
      .put("/api/coop/ambassador/program")
      .set("x-tenant-id", String(tid))
      .send({ optedIn: true, pledgePerRedemption: pledge })
      .expect(200);
  }
});

afterAll(async () => {
  // Tenants cascade partnerships, customers, redemptions, settings.
  const ids = [cafeId, gymId, bakeryId].filter((n) => Number.isInteger(n));
  if (ids.length) {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, ids));
  }
  // Synthetic drain/funding ledger rows carry no identity — clean by RUN tag.
  await db
    .delete(ambassadorPoolEntriesTable)
    .where(like(ambassadorPoolEntriesTable.description, `%${RUN}`));
  // Global (non-tenant) rows: clean by this run's phone block.
  const identities = await db
    .select({ id: passportIdentitiesTable.id })
    .from(passportIdentitiesTable)
    .where(like(passportIdentitiesTable.phone, `+1${phoneBase}%`));
  const identityIds = identities.map((i) => i.id);
  if (identityIds.length) {
    await db
      .delete(ambassadorPoolEntriesTable)
      .where(inArray(ambassadorPoolEntriesTable.identityId, identityIds));
    await db
      .delete(passportIdentitiesTable)
      .where(inArray(passportIdentitiesTable.id, identityIds));
  }
  await db
    .delete(walletSessionsTable)
    .where(like(walletSessionsTable.phone, `+1${phoneBase}%`));
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

/**
 * Normalize the (network-global) pool to a known balance with a RUN-tagged
 * adjustment entry. The pool accumulates residue from prior dev-test runs
 * (identity FK is set-null on cleanup), so tests must never assume an
 * absolute starting balance.
 */
async function setPoolBalance(target: number) {
  const { ambassadorPoolBalance } = await import("../../lib/ambassador");
  const balance = await ambassadorPoolBalance();
  const diff = target - balance;
  if (Math.abs(diff) < 0.005) return;
  await db.insert(ambassadorPoolEntriesTable).values({
    entryType: diff > 0 ? "contribution" : "reward_debit",
    amount: Math.abs(diff).toFixed(2),
    description: `Pool adjustment ${RUN}`,
  });
}

/** Mint a wallet session directly (SMS login is covered by wallet tests). */
async function walletSession(p: string): Promise<string> {
  const token = `ambtest-${RUN}-${p.slice(-4)}-${Math.random().toString(36).slice(2)}`;
  await db.insert(walletSessionsTable).values({
    phone: p,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return token;
}

describe("tenant scoping", () => {
  it("merchant endpoints require x-tenant-id", async () => {
    await agent.get("/api/coop/ambassador/program").expect(400);
    await agent.get("/api/coop/ambassador/ledger").expect(400);
    await agent
      .post("/api/coop/ambassador/rewards/redeem")
      .send({ code: "AMB-NOPE" })
      .expect(400);
  });

  it("wallet endpoints require a wallet session", async () => {
    await agent.get("/api/wallet/ambassador").expect(401);
    await agent.post("/api/wallet/ambassador/referral").send({ code: "X" }).expect(401);
  });
});

describe("pool pledge accrual on perk redemption", () => {
  it("an opted-in merchant's redemption accrues its pledge exactly once", async () => {
    // Gym scans the referrer's classic pass (cafe→gym crossover).
    const res = await redeem(gymId, `AMB-GYM-${RUN}`, `C${cafeCustomerId}`).expect(200);
    expect(res.body.valid).toBe(true);

    const identity = await identityByPhone(phone(1));
    const entries = await db
      .select()
      .from(ambassadorPoolEntriesTable)
      .where(
        and(
          eq(ambassadorPoolEntriesTable.tenantId, gymId),
          eq(ambassadorPoolEntriesTable.entryType, "contribution"),
        ),
      );
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].amount)).toBe(6);
    expect(entries[0].identityId).toBe(identity.id);

    // Re-scanning the same pass instance is rejected and accrues nothing.
    await redeem(gymId, `AMB-GYM-${RUN}`, `C${cafeCustomerId}`).expect(200);
    const again = await db
      .select()
      .from(ambassadorPoolEntriesTable)
      .where(
        and(
          eq(ambassadorPoolEntriesTable.tenantId, gymId),
          eq(ambassadorPoolEntriesTable.entryType, "contribution"),
        ),
      );
    expect(again).toHaveLength(1);
  });

  it("a NON-opted-in merchant's redemption accrues nothing", async () => {
    await redeem(bakeryId, `AMB-BAK-${RUN}`, `C${gymCustomerId}`).expect(200);
    const entries = await db
      .select()
      .from(ambassadorPoolEntriesTable)
      .where(eq(ambassadorPoolEntriesTable.tenantId, bakeryId));
    expect(entries).toHaveLength(0);
  });
});

describe("referral loop", () => {
  let referrerCode: string;
  let friendSession: string;

  it("the wallet view mints a personal referral code", async () => {
    const session = await walletSession(phone(1));
    const res = await agent
      .get("/api/wallet/ambassador")
      .set("x-wallet-session", session)
      .expect(200);
    referrerCode = res.body.referralCode;
    expect(referrerCode).toMatch(/^FRIEND-/);
    // Stable across reads.
    const res2 = await agent
      .get("/api/wallet/ambassador")
      .set("x-wallet-session", session)
      .expect(200);
    expect(res2.body.referralCode).toBe(referrerCode);
  });

  it("rejects self-referral", async () => {
    const session = await walletSession(phone(1));
    const res = await agent
      .post("/api/wallet/ambassador/referral")
      .set("x-wallet-session", session)
      .send({ code: referrerCode })
      .expect(409);
    expect(res.body.message).toMatch(/yourself/i);
  });

  it("rejects an unknown code", async () => {
    friendSession = await walletSession(phone(2));
    await agent
      .post("/api/wallet/ambassador/referral")
      .set("x-wallet-session", friendSession)
      .send({ code: `FRIEND-NOPE${RUN.slice(-4).toUpperCase()}` })
      .expect(409);
  });

  it("rejects a friend who is already active on the network", async () => {
    // phone(1) already has stamps; a second identity referring them is moot —
    // instead verify an already-stamped person can't attach as a friend.
    const activeSession = await walletSession(phone(1));
    // Mint a second referrer so the code isn't their own.
    const otherSession = await walletSession(phone(3));
    const other = await agent
      .get("/api/wallet/ambassador")
      .set("x-wallet-session", otherSession)
      .expect(200);
    const res = await agent
      .post("/api/wallet/ambassador/referral")
      .set("x-wallet-session", activeSession)
      .send({ code: other.body.referralCode })
      .expect(409);
    expect(res.body.message).toMatch(/already active/i);
  });

  it("attaches a fresh friend as pending, and only once", async () => {
    const res = await agent
      .post("/api/wallet/ambassador/referral")
      .set("x-wallet-session", friendSession)
      .send({ code: referrerCode })
      .expect(200);
    expect(res.body.referredByStatus).toBe("pending");
    // A second attach — even with a different code — is rejected.
    const otherSession = await walletSession(phone(3));
    const other = await agent
      .get("/api/wallet/ambassador")
      .set("x-wallet-session", otherSession)
      .expect(200);
    await agent
      .post("/api/wallet/ambassador/referral")
      .set("x-wallet-session", friendSession)
      .send({ code: other.body.referralCode })
      .expect(409);
  });

  it("converts exactly once on the friend's qualifying visit, mints both rewards, and reserves their cost against the converting business", async () => {
    // Known funded state: the pool covers the 2×$5 reward pair.
    await setPoolBalance(10);
    // The friend becomes a customer at the gym and redeems a perk there.
    const [friendCustomer] = await db
      .insert(sosCustomersTable)
      .values({ tenantId: gymId, name: `Friend ${RUN}`, phone: phone(2), smsOptIn: true })
      .returning({ id: sosCustomersTable.id });
    const res = await redeem(gymId, `AMB-GYM-${RUN}`, `C${friendCustomer.id}`).expect(200);
    expect(res.body.valid).toBe(true);

    const friendIdentity = await identityByPhone(phone(2));
    const [referral] = await db
      .select()
      .from(ambassadorReferralsTable)
      .where(eq(ambassadorReferralsTable.friendIdentityId, friendIdentity.id));
    expect(referral.status).toBe("converted");
    expect(referral.convertedTenantId).toBe(gymId);

    const rewards = await db
      .select()
      .from(ambassadorRewardsTable)
      .where(eq(ambassadorRewardsTable.referralId, referral.id));
    expect(rewards).toHaveLength(2);
    expect(rewards.map((r) => r.source).sort()).toEqual([
      "referral_friend",
      "referral_referrer",
    ]);
    expect(rewards.every((r) => r.status === "issued")).toBe(true);

    // Reserve-at-mint: both rewards were debited from the pool immediately,
    // attributed to the business where the referral converted (the gym).
    const debits = await db
      .select()
      .from(ambassadorPoolEntriesTable)
      .where(eq(ambassadorPoolEntriesTable.referralId, referral.id));
    expect(debits).toHaveLength(2);
    expect(debits.every((d) => d.entryType === "reward_debit")).toBe(true);
    expect(debits.every((d) => d.tenantId === gymId)).toBe(true);
    expect(debits.reduce((s, d) => s + Number(d.amount), 0)).toBe(10);

    // Re-running the accrual (e.g. another visit) never duplicates rewards.
    const { recordAmbassadorActivitySafe } = await import("../../lib/ambassador");
    await recordAmbassadorActivitySafe({ tenantId: gymId, person: { phone: phone(2) } });
    const rewardsAgain = await db
      .select()
      .from(ambassadorRewardsTable)
      .where(eq(ambassadorRewardsTable.referralId, referral.id));
    expect(rewardsAgain).toHaveLength(2);
  });
});

describe("tier promotion", () => {
  it("advances by distinct partner businesses (Advocate at 2)", async () => {
    const identity = await identityByPhone(phone(1)); // gym stamp so far
    // Second distinct business: bakery scans their pass.
    await redeem(bakeryId, `AMB-BAK-${RUN}`, `C${bakeryCustomerId}`).expect(200);
    const [status] = await db
      .select()
      .from(ambassadorStatusTable)
      .where(eq(ambassadorStatusTable.identityId, identity.id));
    expect(status.distinctPartners).toBeGreaterThanOrEqual(2);
    expect(["advocate", "ambassador"]).toContain(status.tier);
  });

  it("advances by converted referrals too (OR semantics)", async () => {
    const { evaluateAmbassadorTier } = await import("../../lib/ambassador");
    const referrer = await identityByPhone(phone(1));
    const result = await evaluateAmbassadorTier(referrer.id);
    expect(result.convertedReferrals).toBe(1);
    // 2 partners OR 1 referral → at least Advocate.
    expect(["advocate", "ambassador"]).toContain(result.tier.key);
  });

  it("reaches Community Ambassador at 3 converted referrals", async () => {
    const { tierForCounts } = await import("../../lib/ambassador");
    expect(tierForCounts(0, 3).key).toBe("ambassador");
    expect(tierForCounts(4, 0).key).toBe("ambassador");
    expect(tierForCounts(1, 0).key).toBe("member");
    expect(tierForCounts(2, 0).key).toBe("advocate");
  });
});

describe("reward redemption", () => {
  it("an issued reward is redeemable at any opted-in storefront, exactly once", async () => {
    const referrer = await identityByPhone(phone(1));
    const [reward] = await db
      .select()
      .from(ambassadorRewardsTable)
      .where(
        and(
          eq(ambassadorRewardsTable.identityId, referrer.id),
          eq(ambassadorRewardsTable.status, "issued"),
        ),
      );
    expect(reward).toBeDefined();

    // Redeemed at the CAFE even though the referral converted at the GYM —
    // rewards are network-wide; the cost was already reserved at mint time.
    const res = await agent
      .post("/api/coop/ambassador/rewards/redeem")
      .set("x-tenant-id", String(cafeId))
      .send({ code: reward.code })
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.reward.status).toBe("redeemed");

    // A second scan of the same code is rejected.
    const replay = await agent
      .post("/api/coop/ambassador/rewards/redeem")
      .set("x-tenant-id", String(cafeId))
      .send({ code: reward.code })
      .expect(200);
    expect(replay.body.valid).toBe(false);
    expect(replay.body.reason).toMatch(/already redeemed/i);
  });

  it("defers conversion while the pool is underfunded, then converts once funded", async () => {
    const { recordAmbassadorActivitySafe, ambassadorPoolBalance } = await import(
      "../../lib/ambassador"
    );
    // Second referral pair: referrer phone(1) → fresh friend phone(5).
    const referrerSession = await walletSession(phone(1));
    const codeRes = await agent
      .get("/api/wallet/ambassador")
      .set("x-wallet-session", referrerSession)
      .expect(200);
    const friend2Session = await walletSession(phone(5));
    await agent
      .post("/api/wallet/ambassador/referral")
      .set("x-wallet-session", friend2Session)
      .send({ code: codeRes.body.referralCode })
      .expect(200);

    // Drain the pool below the 2×$5 reserve.
    await setPoolBalance(0);

    // Qualifying visit while underfunded → referral stays pending, no rewards.
    await recordAmbassadorActivitySafe({ tenantId: gymId, person: { phone: phone(5) } });
    const friend2 = await identityByPhone(phone(5));
    let [referral] = await db
      .select()
      .from(ambassadorReferralsTable)
      .where(eq(ambassadorReferralsTable.friendIdentityId, friend2.id));
    expect(referral.status).toBe("pending");

    // Fund the pool, then a later qualifying visit converts.
    await db.insert(ambassadorPoolEntriesTable).values({
      entryType: "contribution",
      amount: "10.00",
      tenantId: cafeId,
      description: `Test funding ${RUN}`,
    });
    await recordAmbassadorActivitySafe({ tenantId: gymId, person: { phone: phone(5) } });
    [referral] = await db
      .select()
      .from(ambassadorReferralsTable)
      .where(eq(ambassadorReferralsTable.friendIdentityId, friend2.id));
    expect(referral.status).toBe("converted");
    const rewards = await db
      .select()
      .from(ambassadorRewardsTable)
      .where(eq(ambassadorRewardsTable.referralId, referral.id));
    expect(rewards).toHaveLength(2);
  });

  it("a non-opted-in business cannot redeem network rewards", async () => {
    const friend = await identityByPhone(phone(2));
    const [reward] = await db
      .select()
      .from(ambassadorRewardsTable)
      .where(
        and(
          eq(ambassadorRewardsTable.identityId, friend.id),
          eq(ambassadorRewardsTable.status, "issued"),
        ),
      );
    const res = await agent
      .post("/api/coop/ambassador/rewards/redeem")
      .set("x-tenant-id", String(bakeryId))
      .send({ code: reward.code })
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toMatch(/not opted in/i);
  });

  it("an unknown code is rejected with a clear reason", async () => {
    const res = await agent
      .post("/api/coop/ambassador/rewards/redeem")
      .set("x-tenant-id", String(cafeId))
      .send({ code: `AMB-UNKNOWN${RUN.slice(-4).toUpperCase()}` })
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toMatch(/unknown/i);
  });
});

describe("merchant program & ledger views", () => {
  it("shows pool balance, per-merchant contribution vs. benefit, and referral stats", async () => {
    const gym = await agent
      .get("/api/coop/ambassador/program")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    // Gym contributed 2×$2 (two redemptions) and carries the $5 acquisition
    // cost for the converted referral redeemed at the cafe.
    expect(gym.body.settings.optedIn).toBe(true);
    // Gym pledged $6 on multiple counted redemptions and carries the $10
    // reserve for the referral that converted there (attributed at mint).
    expect(gym.body.myContribution).toBeGreaterThanOrEqual(12);
    expect(gym.body.myBenefit).toBeGreaterThanOrEqual(10);
    expect(gym.body.referralStats.convertedAtThisBusiness).toBeGreaterThanOrEqual(1);
    expect(gym.body.tiers).toHaveLength(3);
    expect(gym.body.topAmbassadors.length).toBeGreaterThanOrEqual(1);

    const ledger = await agent
      .get("/api/coop/ambassador/ledger")
      .set("x-tenant-id", String(gymId))
      .expect(200);
    const types = ledger.body.entries.map((e: { entryType: string }) => e.entryType);
    expect(types).toContain("contribution");
    expect(types).toContain("reward_debit");
  });

  it("the friend's wallet view shows tier progress and their welcome reward", async () => {
    const session = await walletSession(phone(2));
    const res = await agent
      .get("/api/wallet/ambassador")
      .set("x-wallet-session", session)
      .expect(200);
    expect(res.body.referredByStatus).toBe("converted");
    expect(res.body.rewards.some((r: { source: string }) => r.source === "referral_friend")).toBe(
      true,
    );
    expect(res.body.distinctPartners).toBeGreaterThanOrEqual(1);
    expect(res.body.nextTier).not.toBeNull();
  });
});

describe("staff-role redemption authorization", () => {
  let staffUserId: number;
  const staffToken = `tok-${RUN}-staff`;
  let staffAgent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const app = (await import("../../app")).default;
    const [user] = await db
      .insert(usersTable)
      .values({ username: `staff-${RUN}`, isPlatformAdmin: false, role: "staff", loginToken: staffToken })
      .returning({ id: usersTable.id });
    staffUserId = user.id;
    await db.insert(userTenantMembershipsTable).values({ userId: staffUserId, tenantId: cafeId });
    staffAgent = request.agent(app);
    await staffAgent.post("/api/auth/login").send({ loginToken: staffToken }).expect(200);
  });

  afterAll(async () => {
    await db
      .delete(userTenantMembershipsTable)
      .where(eq(userTenantMembershipsTable.userId, staffUserId));
    await db.delete(usersTable).where(eq(usersTable.id, staffUserId));
  });

  it("staff at the register CAN redeem ambassador reward codes", async () => {
    // Mint an issued reward directly for a run identity.
    const identity = await identityByPhone(phone(2));
    const [reward] = await db
      .insert(ambassadorRewardsTable)
      .values({
        identityId: identity.id,
        code: `AMB-STAFF${RUN.slice(-6).toUpperCase()}`,
        source: "referral_friend",
        amount: "5.00",
      })
      .returning();
    const res = await staffAgent
      .post("/api/coop/ambassador/rewards/redeem")
      .set("x-tenant-id", String(cafeId))
      .send({ code: reward.code })
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.reward.status).toBe("redeemed");
  });

  it("staff remain read-only on program settings and other co-op writes", async () => {
    await staffAgent
      .put("/api/coop/ambassador/program")
      .set("x-tenant-id", String(cafeId))
      .send({ optedIn: true, pledgePerRedemption: 1 })
      .expect(403);
  });
});

describe("concurrent conversion funding race", () => {
  it("two racing conversions can never over-reserve the pool", async () => {
    const { recordAmbassadorActivitySafe, ambassadorPoolBalance } = await import(
      "../../lib/ambassador"
    );
    // One referrer, two pending friends, pool funded for exactly ONE
    // conversion (2 × $5). Both friends' qualifying visits race — exactly
    // one may convert; the other must stay pending (not drive the pool
    // negative).
    const referrerSession = await walletSession(phone(1));
    const codeRes = await agent
      .get("/api/wallet/ambassador")
      .set("x-wallet-session", referrerSession)
      .expect(200);
    for (const p of [phone(6), phone(7)]) {
      const s = await walletSession(p);
      await agent
        .post("/api/wallet/ambassador/referral")
        .set("x-wallet-session", s)
        .send({ code: codeRes.body.referralCode })
        .expect(200);
    }
    await setPoolBalance(10);

    await Promise.all([
      recordAmbassadorActivitySafe({ tenantId: gymId, person: { phone: phone(6) } }),
      recordAmbassadorActivitySafe({ tenantId: cafeId, person: { phone: phone(7) } }),
    ]);

    const f6 = await identityByPhone(phone(6));
    const f7 = await identityByPhone(phone(7));
    const referrals = await db
      .select()
      .from(ambassadorReferralsTable)
      .where(inArray(ambassadorReferralsTable.friendIdentityId, [f6.id, f7.id]));
    const statuses = referrals.map((r) => r.status).sort();
    expect(statuses).toEqual(["converted", "pending"]);

    // Exactly one reward pair was minted and reserved; the pool never went
    // below zero.
    const rewards = await db
      .select()
      .from(ambassadorRewardsTable)
      .where(
        inArray(
          ambassadorRewardsTable.referralId,
          referrals.map((r) => r.id),
        ),
      );
    expect(rewards).toHaveLength(2);
    expect(await ambassadorPoolBalance()).toBeGreaterThanOrEqual(0);
  });
});
