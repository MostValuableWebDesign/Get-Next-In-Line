import { randomBytes } from "node:crypto";
import {
  db,
  ambassadorProgramSettingsTable,
  ambassadorPoolEntriesTable,
  ambassadorReferralCodesTable,
  ambassadorReferralsTable,
  ambassadorRewardsTable,
  ambassadorStatusTable,
  passportIdentitiesTable,
  passportStampsTable,
  tenantsTable,
  type AmbassadorReferral,
  type AmbassadorReward,
  type PassportIdentity,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { findOrCreatePassportIdentity, type PassportPerson } from "./passport";
import { logger } from "./logger";

// ── Co-Op Referral Loyalty & Tiered Ambassador Program ──────────────────────
// Engine on top of the Neighborhood Passport identity: accrues cross-business
// activity, advances customers through network-default ambassador tiers,
// converts pending referrals exactly once, and keeps the merchant-funded
// reward pool ledger balanced. Every entry point that runs inside a
// redemption/checkout flow is a *Safe function — it never throws.

/** Network-default tiers. A tier is reached by EITHER enough distinct
 * partner-business redemptions OR enough converted referrals. */
export const AMBASSADOR_TIERS = [
  {
    key: "member",
    name: "Member",
    minPartners: 0,
    minReferrals: 0,
    discountPercent: 0,
    vip: false,
  },
  {
    key: "advocate",
    name: "Advocate",
    minPartners: 2,
    minReferrals: 1,
    discountPercent: 5,
    vip: false,
  },
  {
    key: "ambassador",
    name: "Community Ambassador",
    minPartners: 4,
    minReferrals: 3,
    discountPercent: 10,
    vip: true,
  },
] as const;

export type AmbassadorTierKey = (typeof AMBASSADOR_TIERS)[number]["key"];

/** Both sides of a converted referral earn this network-wide reward. */
export const REFERRAL_REWARD_AMOUNT = "5.00";

export type AmbassadorTier = (typeof AMBASSADOR_TIERS)[number];

export function tierForCounts(
  distinctPartners: number,
  convertedReferrals: number,
): AmbassadorTier {
  let current: AmbassadorTier = AMBASSADOR_TIERS[0];
  for (const tier of AMBASSADOR_TIERS) {
    const byPartners = tier.minPartners > 0 && distinctPartners >= tier.minPartners;
    const byReferrals = tier.minReferrals > 0 && convertedReferrals >= tier.minReferrals;
    if (tier.minPartners === 0 && tier.minReferrals === 0) current = tier;
    else if (byPartners || byReferrals) current = tier;
  }
  return current;
}

// Unambiguous alphabet (no 0/O, 1/I) for human-entered codes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(prefix: string, length: number): string {
  const bytes = randomBytes(length);
  let s = "";
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${prefix}-${s}`;
}

/** Personal referral code for an identity, minted on first request. */
export async function getOrCreateReferralCode(identityId: number): Promise<string> {
  const [existing] = await db
    .select()
    .from(ambassadorReferralCodesTable)
    .where(eq(ambassadorReferralCodesTable.identityId, identityId));
  if (existing) return existing.code;
  // Retry on the (astronomically rare) code collision; the identity unique
  // constraint resolves a concurrent double-mint to one winner.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [created] = await db
        .insert(ambassadorReferralCodesTable)
        .values({ identityId, code: randomCode("FRIEND", 6) })
        .onConflictDoNothing({ target: ambassadorReferralCodesTable.identityId })
        .returning();
      if (created) return created.code;
      const [raced] = await db
        .select()
        .from(ambassadorReferralCodesTable)
        .where(eq(ambassadorReferralCodesTable.identityId, identityId));
      if (raced) return raced.code;
    } catch (err) {
      // code collision — try a fresh code
      logger.warn({ err, identityId }, "Referral code mint collided — retrying with a fresh code");
    }
  }
  throw new Error("Could not mint a referral code");
}

type Dbx = Pick<typeof db, "select" | "insert" | "update">;

/** Current pool balance: contributions minus reward debits. */
export async function ambassadorPoolBalance(dbx: Dbx = db): Promise<number> {
  const [row] = await dbx
    .select({
      balance: sql<string>`coalesce(sum(case when ${ambassadorPoolEntriesTable.entryType} = 'contribution' then ${ambassadorPoolEntriesTable.amount} else -${ambassadorPoolEntriesTable.amount} end), 0)`,
    })
    .from(ambassadorPoolEntriesTable);
  return Number(row?.balance ?? 0);
}

/** Advisory-lock key serializing pool-funded referral conversions. The pool
 * is one network-global ledger, so the balance check and the reservation
 * must be atomic across concurrent conversions. Transaction-scoped lock:
 * auto-released on commit, rollback, or crash. */
const AMBASSADOR_POOL_LOCK_KEY = 916_316;

/**
 * Recompute an identity's tier from distinct stamped partners + converted
 * referrals and upsert the persisted status row. Idempotent; safe to call
 * from any accrual path.
 */
export async function evaluateAmbassadorTier(identityId: number) {
  const [stampRow] = await db
    .select({ n: sql<number>`count(distinct ${passportStampsTable.tenantId})::int` })
    .from(passportStampsTable)
    .where(eq(passportStampsTable.identityId, identityId));
  const [refRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ambassadorReferralsTable)
    .where(
      and(
        eq(ambassadorReferralsTable.referrerIdentityId, identityId),
        eq(ambassadorReferralsTable.status, "converted"),
      ),
    );
  const distinctPartners = stampRow?.n ?? 0;
  const convertedReferrals = refRow?.n ?? 0;
  const tier = tierForCounts(distinctPartners, convertedReferrals);
  await db
    .insert(ambassadorStatusTable)
    .values({ identityId, tier: tier.key, distinctPartners, convertedReferrals })
    .onConflictDoUpdate({
      target: ambassadorStatusTable.identityId,
      set: { tier: tier.key, distinctPartners, convertedReferrals, updatedAt: new Date() },
    });
  return { tier, distinctPartners, convertedReferrals };
}

export class ReferralAttachError extends Error {}

/**
 * Attach a friend (wallet-authenticated identity) to a referrer's code.
 * Guards: unknown code, self-referral (same identity), friend already
 * referred (unique friend constraint), and friend already active on the
 * network (any passport stamp) — referrals are for NEW foot traffic.
 */
export async function attachReferral(
  friendIdentity: PassportIdentity,
  code: string,
): Promise<AmbassadorReferral> {
  const trimmed = code.trim().toUpperCase();
  const [codeRow] = await db
    .select()
    .from(ambassadorReferralCodesTable)
    .where(eq(ambassadorReferralCodesTable.code, trimmed));
  if (!codeRow) throw new ReferralAttachError("Unknown referral code");
  if (codeRow.identityId === friendIdentity.id) {
    throw new ReferralAttachError("You can't refer yourself");
  }
  const [existingStamp] = await db
    .select({ id: passportStampsTable.id })
    .from(passportStampsTable)
    .where(eq(passportStampsTable.identityId, friendIdentity.id))
    .limit(1);
  if (existingStamp) {
    throw new ReferralAttachError(
      "Referrals are for first-time visitors — you're already active on the network",
    );
  }
  const [created] = await db
    .insert(ambassadorReferralsTable)
    .values({
      referrerIdentityId: codeRow.identityId,
      friendIdentityId: friendIdentity.id,
      code: trimmed,
    })
    .onConflictDoNothing({ target: ambassadorReferralsTable.friendIdentityId })
    .returning();
  if (!created) throw new ReferralAttachError("You've already used a referral code");
  return created;
}

/**
 * Mint both referral rewards AND reserve their cost out of the pool
 * immediately (one reward_debit ledger entry per reward, attributed to the
 * business where the referred foot traffic converted). Reserving at mint
 * time guarantees an issued reward is always redeemable — the pool can never
 * owe more than it holds because conversion is gated on the balance.
 */
async function mintReferralRewards(dbx: Dbx, referral: AmbassadorReferral): Promise<void> {
  const mint = async (identityId: number, source: string) => {
    // Conflict-free retry loop: onConflictDoNothing keeps a code collision
    // from aborting the surrounding transaction (a thrown unique-violation
    // would poison the tx and roll back the conversion).
    for (let attempt = 0; attempt < 3; attempt++) {
      const [reward] = await dbx
        .insert(ambassadorRewardsTable)
        .values({
          identityId,
          code: randomCode("AMB", 8),
          source,
          amount: REFERRAL_REWARD_AMOUNT,
          referralId: referral.id,
        })
        .onConflictDoNothing({ target: ambassadorRewardsTable.code })
        .returning();
      if (reward) return reward;
    }
    throw new Error("Could not mint an ambassador reward code");
  };
  const attributedTenantId = referral.convertedTenantId;
  for (const [identityId, source] of [
    [referral.referrerIdentityId, "referral_referrer"],
    [referral.friendIdentityId, "referral_friend"],
  ] as const) {
    const reward = await mint(identityId, source);
    // Acquisition-cost attribution: the converting business carries the cost
    // of both rewards in the ledger. Unique reward_id makes replays no-ops.
    await dbx
      .insert(ambassadorPoolEntriesTable)
      .values({
        entryType: "reward_debit",
        amount: reward.amount,
        tenantId: attributedTenantId,
        identityId,
        rewardId: reward.id,
        referralId: referral.id,
        description: `Reserved for ambassador reward ${reward.code} (referral conversion)`,
      })
      .onConflictDoNothing();
  }
}

/**
 * Accrue one unit of network activity for a person at a tenant. Called from
 * every co-op redemption path (native scan, wallet pass, POS webhook) and
 * from booking checkout. Never throws.
 *
 * - Pool: when the tenant is opted in and the activity is a perk redemption,
 *   accrue the tenant's pledge into the pool (idempotent per redemption).
 * - Referral: a qualifying visit converts the person's pending referral
 *   exactly once (conditional pending→converted update) and mints rewards
 *   for both parties.
 * - Tier: re-evaluate the person's (and, on conversion, the referrer's) tier.
 */
export async function recordAmbassadorActivitySafe(opts: {
  tenantId: number;
  redemptionId?: number | null;
  person: PassportPerson;
}): Promise<void> {
  try {
    const identity = await findOrCreatePassportIdentity(opts.person);
    if (!identity) return;

    const [settings] = await db
      .select()
      .from(ambassadorProgramSettingsTable)
      .where(eq(ambassadorProgramSettingsTable.tenantId, opts.tenantId));
    const optedIn = settings?.optedIn === true;

    // Pool pledge accrual — only for perk redemptions at opted-in merchants.
    if (optedIn && opts.redemptionId != null && Number(settings!.pledgePerRedemption) > 0) {
      await db
        .insert(ambassadorPoolEntriesTable)
        .values({
          entryType: "contribution",
          amount: settings!.pledgePerRedemption,
          tenantId: opts.tenantId,
          identityId: identity.id,
          redemptionId: opts.redemptionId,
          description: "Pledge accrued from a co-op perk redemption",
        })
        .onConflictDoNothing({ target: ambassadorPoolEntriesTable.redemptionId });
    }

    // Referral conversion — a qualifying visit at any opted-in participant.
    if (optedIn) {
      const [pending] = await db
        .select()
        .from(ambassadorReferralsTable)
        .where(
          and(
            eq(ambassadorReferralsTable.friendIdentityId, identity.id),
            eq(ambassadorReferralsTable.status, "pending"),
          ),
        );
      if (pending && pending.referrerIdentityId !== identity.id) {
        // Conversion is a single transaction under a pool-wide advisory
        // lock: the funding check (pool must cover BOTH rewards), the
        // exactly-once pending→converted flip, and the reward mint + pool
        // reservation commit together or not at all. Concurrent conversions
        // serialize on the lock, so two of them can never both spend the
        // same pool balance; a partial failure rolls everything back and
        // the referral stays pending for the next qualifying visit.
        const converted = await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(${AMBASSADOR_POOL_LOCK_KEY})`);
          const balance = await ambassadorPoolBalance(tx);
          // Funding gate: underfunded visits leave the referral pending — it
          // converts on a later qualifying visit once merchants have pledged
          // enough. This keeps every issued reward redeemable.
          if (balance < 2 * Number(REFERRAL_REWARD_AMOUNT)) return null;
          // Conditional update is the exactly-once conversion lock.
          const [row] = await tx
            .update(ambassadorReferralsTable)
            .set({
              status: "converted",
              convertedTenantId: opts.tenantId,
              convertedAt: new Date(),
            })
            .where(
              and(
                eq(ambassadorReferralsTable.id, pending.id),
                eq(ambassadorReferralsTable.status, "pending"),
              ),
            )
            .returning();
          if (!row) return null;
          await mintReferralRewards(tx, row);
          return row;
        });
        if (converted) {
          await evaluateAmbassadorTier(converted.referrerIdentityId);
        }
      }
    }

    await evaluateAmbassadorTier(identity.id);
  } catch (err) {
    logger.error(
      { err, tenantId: opts.tenantId },
      "Ambassador activity accrual failed; caller flow continues",
    );
  }
}

// ── staff reward redemption ──────────────────────────────────────────────────

export interface RewardRedemptionOutcome {
  valid: boolean;
  reason: string | null;
  reward: AmbassadorReward | null;
}

/**
 * Redeem an ambassador reward code at a storefront. Always resolves (never
 * throws for business outcomes) with a valid flag, mirroring the perk
 * redemption endpoints. The issued→redeemed conditional update is the
 * single-use lock. The pool cost was already reserved (and attributed to the
 * converting business) at mint time, so an issued reward is always
 * redeemable at any opted-in storefront — no funding check here.
 */
export async function redeemAmbassadorReward(opts: {
  tenantId: number;
  code: string;
}): Promise<RewardRedemptionOutcome> {
  const [settings] = await db
    .select()
    .from(ambassadorProgramSettingsTable)
    .where(eq(ambassadorProgramSettingsTable.tenantId, opts.tenantId));
  if (settings?.optedIn !== true) {
    return {
      valid: false,
      reason: "This business is not opted in to the Ambassador Program",
      reward: null,
    };
  }
  const code = opts.code.trim().toUpperCase();
  const [reward] = await db
    .select()
    .from(ambassadorRewardsTable)
    .where(eq(ambassadorRewardsTable.code, code));
  if (!reward) return { valid: false, reason: "Unknown reward code", reward: null };
  if (reward.status !== "issued") {
    return { valid: false, reason: "This reward was already redeemed", reward };
  }
  const [redeemed] = await db
    .update(ambassadorRewardsTable)
    .set({ status: "redeemed", redeemedByTenantId: opts.tenantId, redeemedAt: new Date() })
    .where(and(eq(ambassadorRewardsTable.id, reward.id), eq(ambassadorRewardsTable.status, "issued")))
    .returning();
  if (!redeemed) {
    return { valid: false, reason: "This reward was already redeemed", reward };
  }
  return { valid: true, reason: null, reward: redeemed };
}

// ── merchant + consumer views ────────────────────────────────────────────────

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `•••${phone.slice(-4)}`;
}

export function tierListJson() {
  return AMBASSADOR_TIERS.map((t) => ({
    key: t.key,
    name: t.name,
    minPartners: t.minPartners,
    minReferrals: t.minReferrals,
    discountPercent: t.discountPercent,
    vip: t.vip,
  }));
}

/** Merchant dashboard payload: settings, pool, my balance, leaders, stats. */
export async function buildAmbassadorProgramView(tenantId: number) {
  const [settings] = await db
    .select()
    .from(ambassadorProgramSettingsTable)
    .where(eq(ambassadorProgramSettingsTable.tenantId, tenantId));
  const poolBalance = await ambassadorPoolBalance();
  const [mine] = await db
    .select({
      contributed: sql<string>`coalesce(sum(case when ${ambassadorPoolEntriesTable.entryType} = 'contribution' then ${ambassadorPoolEntriesTable.amount} else 0 end), 0)`,
      benefit: sql<string>`coalesce(sum(case when ${ambassadorPoolEntriesTable.entryType} = 'reward_debit' then ${ambassadorPoolEntriesTable.amount} else 0 end), 0)`,
    })
    .from(ambassadorPoolEntriesTable)
    .where(eq(ambassadorPoolEntriesTable.tenantId, tenantId));

  const top = await db
    .select({
      status: ambassadorStatusTable,
      displayName: passportIdentitiesTable.displayName,
      phone: passportIdentitiesTable.phone,
    })
    .from(ambassadorStatusTable)
    .innerJoin(
      passportIdentitiesTable,
      eq(ambassadorStatusTable.identityId, passportIdentitiesTable.id),
    )
    .orderBy(
      desc(sql`case ${ambassadorStatusTable.tier} when 'ambassador' then 2 when 'advocate' then 1 else 0 end`),
      desc(ambassadorStatusTable.distinctPartners),
      desc(ambassadorStatusTable.convertedReferrals),
    )
    .limit(10);

  const [refTotals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      converted: sql<number>`count(*) filter (where ${ambassadorReferralsTable.status} = 'converted')::int`,
      convertedHere: sql<number>`count(*) filter (where ${ambassadorReferralsTable.convertedTenantId} = ${tenantId})::int`,
    })
    .from(ambassadorReferralsTable);

  return {
    settings: {
      optedIn: settings?.optedIn ?? false,
      pledgePerRedemption: settings ? Number(settings.pledgePerRedemption) : 1,
    },
    poolBalance,
    myContribution: Number(mine?.contributed ?? 0),
    myBenefit: Number(mine?.benefit ?? 0),
    tiers: tierListJson(),
    topAmbassadors: top.map((t) => ({
      displayName: t.displayName ?? maskPhone(t.phone) ?? "Neighborhood customer",
      phoneMasked: maskPhone(t.phone),
      tier: t.status.tier,
      distinctPartners: t.status.distinctPartners,
      convertedReferrals: t.status.convertedReferrals,
    })),
    referralStats: {
      totalReferrals: refTotals?.total ?? 0,
      convertedReferrals: refTotals?.converted ?? 0,
      convertedAtThisBusiness: refTotals?.convertedHere ?? 0,
    },
  };
}

/** Network pool ledger, newest first, with business names resolved. */
export async function buildAmbassadorLedger(limit = 100) {
  const entries = await db
    .select({
      entry: ambassadorPoolEntriesTable,
      tenantName: tenantsTable.brandName,
    })
    .from(ambassadorPoolEntriesTable)
    .leftJoin(tenantsTable, eq(ambassadorPoolEntriesTable.tenantId, tenantsTable.id))
    .orderBy(desc(ambassadorPoolEntriesTable.createdAt), desc(ambassadorPoolEntriesTable.id))
    .limit(limit);
  return {
    poolBalance: await ambassadorPoolBalance(),
    entries: entries.map(({ entry, tenantName }) => ({
      id: entry.id,
      entryType: entry.entryType,
      amount: Number(entry.amount),
      businessName: tenantName,
      description: entry.description,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

/** Consumer wallet payload: tier, progress, referral code, rewards. */
export async function buildConsumerAmbassadorView(identity: PassportIdentity) {
  const { tier, distinctPartners, convertedReferrals } = await evaluateAmbassadorTier(identity.id);
  const referralCode = await getOrCreateReferralCode(identity.id);
  const idx = AMBASSADOR_TIERS.findIndex((t) => t.key === tier.key);
  const next = idx + 1 < AMBASSADOR_TIERS.length ? AMBASSADOR_TIERS[idx + 1] : null;

  const rewards = await db
    .select({
      reward: ambassadorRewardsTable,
      redeemedAtName: tenantsTable.brandName,
    })
    .from(ambassadorRewardsTable)
    .leftJoin(tenantsTable, eq(ambassadorRewardsTable.redeemedByTenantId, tenantsTable.id))
    .where(eq(ambassadorRewardsTable.identityId, identity.id))
    .orderBy(desc(ambassadorRewardsTable.createdAt));

  const [referredBy] = await db
    .select({ status: ambassadorReferralsTable.status })
    .from(ambassadorReferralsTable)
    .where(eq(ambassadorReferralsTable.friendIdentityId, identity.id));

  return {
    tier: { key: tier.key, name: tier.name, discountPercent: tier.discountPercent, vip: tier.vip },
    distinctPartners,
    convertedReferrals,
    nextTier: next
      ? {
          key: next.key,
          name: next.name,
          minPartners: next.minPartners,
          minReferrals: next.minReferrals,
          partnersRemaining: Math.max(0, next.minPartners - distinctPartners),
          referralsRemaining: Math.max(0, next.minReferrals - convertedReferrals),
        }
      : null,
    tiers: tierListJson(),
    referralCode,
    referredByStatus: referredBy?.status ?? null,
    rewards: rewards.map(({ reward, redeemedAtName }) => ({
      id: reward.id,
      code: reward.code,
      source: reward.source,
      amount: Number(reward.amount),
      status: reward.status,
      redeemedAtBusiness: redeemedAtName,
      redeemedAt: reward.redeemedAt ? reward.redeemedAt.toISOString() : null,
      createdAt: reward.createdAt.toISOString(),
    })),
  };
}

/** Resolve identities that could match a set of tenant customer rows. */
export async function identitiesForPhones(phones: string[]): Promise<PassportIdentity[]> {
  if (phones.length === 0) return [];
  return db
    .select()
    .from(passportIdentitiesTable)
    .where(inArray(passportIdentitiesTable.phone, phones));
}
