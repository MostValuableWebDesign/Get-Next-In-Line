import {
  db,
  passportIdentitiesTable,
  passportStampsTable,
  passportChallengesTable,
  passportRewardIssuancesTable,
  coopPerkRedemptionsTable,
  perkPassesTable,
  sosCustomersTable,
  clientProfilesTable,
  tenantsTable,
  type PassportIdentity,
  type PassportChallenge,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { normalizeToE164 } from "./sms";
import { sendMessageSafe } from "./messaging";
import { isWalletPassToken } from "./perkPasses";
import { logger } from "./logger";

// ── Co-Op Neighborhood Passport ──────────────────────────────────────────────
// Every unique partner business where a customer redeems a co-op perk earns a
// passport stamp, recorded against a cross-tenant identity (normalized
// phone / lowercased email). After each new stamp, active merchant-sponsored
// milestone challenges are evaluated; completions issue their reward exactly
// once per customer (unique (challenge, identity) constraint) and notify the
// customer through the unified messaging pipeline.

/** Tiered status badges, in ascending threshold order. */
export const PASSPORT_TIERS = [
  { name: "First Stamp", threshold: 1 },
  { name: "Neighborhood Regular", threshold: 3 },
  { name: "Local VIP", threshold: 6 },
  { name: "Neighborhood Legend", threshold: 10 },
] as const;

export const PASSPORT_REWARD_TYPES = [
  "bonus_perk",
  "sweepstakes_entry",
  "free_upgrade",
] as const;
export type PassportRewardType = (typeof PASSPORT_REWARD_TYPES)[number];

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PassportPerson {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
}

/**
 * Find or create the cross-tenant identity for a person. Match order: exact
 * normalized phone, then lowercased email. Contact fields are merged onto an
 * existing identity when it's missing one side (phone-matched row learns the
 * email, and vice versa) so future matches from either key converge on the
 * same passport.
 */
export async function findOrCreatePassportIdentity(
  person: PassportPerson,
): Promise<PassportIdentity | null> {
  const phone = normalizeToE164(person.phone ?? null);
  const email = normalizeEmail(person.email);
  if (!phone && !email) return null;

  const conditions = [];
  if (phone) conditions.push(eq(passportIdentitiesTable.phone, phone));
  if (email) conditions.push(eq(passportIdentitiesTable.email, email));
  const matches = await db
    .select()
    .from(passportIdentitiesTable)
    .where(or(...conditions));
  // Phone match wins over email match when both hit different rows.
  const phoneMatch = phone ? matches.find((m) => m.phone === phone) : undefined;
  const emailMatch = email ? matches.find((m) => m.email === email) : undefined;
  // Split identity (one row by phone, another by email — same person):
  // deterministically merge into the phone-matched row so stamps and reward
  // progress never fragment across two passports.
  if (phoneMatch && emailMatch && phoneMatch.id !== emailMatch.id) {
    return await mergePassportIdentities(phoneMatch, emailMatch);
  }
  const existing = phoneMatch ?? emailMatch;
  if (existing) {
    const updates: Partial<typeof passportIdentitiesTable.$inferInsert> = {};
    if (phone && existing.phone == null) updates.phone = phone;
    if (email && existing.email == null) updates.email = email;
    if (person.name && existing.displayName == null) updates.displayName = person.name;
    if (Object.keys(updates).length > 0) {
      try {
        const [updated] = await db
          .update(passportIdentitiesTable)
          .set(updates)
          .where(eq(passportIdentitiesTable.id, existing.id))
          .returning();
        return updated;
      } catch (err) {
        // Unique collision (the other key already belongs to another
        // identity) — keep the matched row as-is.
        logger.warn(
          { err, identityId: existing.id },
          "Passport identity enrichment skipped: update collided with another identity",
        );
        return existing;
      }
    }
    return existing;
  }

  try {
    const [created] = await db
      .insert(passportIdentitiesTable)
      .values({ phone, email, displayName: person.name ?? null })
      .returning();
    return created;
  } catch (err) {
    // Concurrent create raced us — re-select.
    logger.warn({ err }, "Passport identity insert raced a concurrent create — re-selecting");
    const [row] = await db
      .select()
      .from(passportIdentitiesTable)
      .where(or(...conditions))
      .limit(1);
    return row ?? null;
  }
}

/**
 * Merge a split identity pair (same person known by phone on one row and by
 * email on another) into the phone-matched winner, in one transaction:
 * re-parent stamps and reward issuances (dropping rows the winner already
 * has via its unique constraints), delete the loser, and fill the winner's
 * missing contact fields.
 */
async function mergePassportIdentities(
  winner: PassportIdentity,
  loser: PassportIdentity,
): Promise<PassportIdentity> {
  return await db.transaction(async (tx) => {
    // Stamps: move all, then drop duplicates the winner already holds.
    const loserStamps = await tx
      .select()
      .from(passportStampsTable)
      .where(eq(passportStampsTable.identityId, loser.id));
    for (const s of loserStamps) {
      const [moved] = await tx
        .insert(passportStampsTable)
        .values({
          identityId: winner.id,
          tenantId: s.tenantId,
          redemptionId: s.redemptionId,
          stampedAt: s.stampedAt,
        })
        .onConflictDoNothing()
        .returning();
      void moved; // duplicate business → winner's stamp stands.
    }
    // Reward issuances: same re-parenting, unique (challenge, identity) keeps
    // exactly-once intact.
    const loserRewards = await tx
      .select()
      .from(passportRewardIssuancesTable)
      .where(eq(passportRewardIssuancesTable.identityId, loser.id));
    for (const r of loserRewards) {
      await tx
        .insert(passportRewardIssuancesTable)
        .values({
          challengeId: r.challengeId,
          identityId: winner.id,
          rewardType: r.rewardType,
          rewardDescription: r.rewardDescription,
          stampCount: r.stampCount,
          issuedAt: r.issuedAt,
        })
        .onConflictDoNothing();
    }
    // Loser goes away (cascades clean its remaining stamp/reward rows), then
    // the winner absorbs any contact fields it was missing.
    await tx.delete(passportIdentitiesTable).where(eq(passportIdentitiesTable.id, loser.id));
    const updates: Partial<typeof passportIdentitiesTable.$inferInsert> = {};
    if (winner.phone == null && loser.phone != null) updates.phone = loser.phone;
    if (winner.email == null && loser.email != null) updates.email = loser.email;
    if (winner.displayName == null && loser.displayName != null)
      updates.displayName = loser.displayName;
    if (Object.keys(updates).length > 0) {
      const [updated] = await tx
        .update(passportIdentitiesTable)
        .set(updates)
        .where(eq(passportIdentitiesTable.id, winner.id))
        .returning();
      return updated;
    }
    return winner;
  });
}

/**
 * STOP/opt-out guard for passport reward texts. Opt-out state lives on
 * tenant-scoped customer records, but the passport identity is global — so
 * treat a STOP on ANY record with this phone (SOS customer or concierge
 * client profile) as a network-wide opt-out for passport marketing.
 */
export async function phoneHasSmsOptOut(phone: string): Promise<boolean> {
  const optedOutCustomers = await db
    .select({ id: sosCustomersTable.id })
    .from(sosCustomersTable)
    .where(and(eq(sosCustomersTable.phone, phone), eq(sosCustomersTable.smsOptIn, false)))
    .limit(1);
  if (optedOutCustomers.length > 0) return true;
  const optedOutProfiles = await db
    .select({ id: clientProfilesTable.id })
    .from(clientProfilesTable)
    .where(and(eq(clientProfilesTable.phone, phone), eq(clientProfilesTable.smsOptIn, false)))
    .limit(1);
  return optedOutProfiles.length > 0;
}

/** Challenges currently accepting completions (isActive + open date window). */
function activeChallengeWindow(now: Date) {
  return and(
    eq(passportChallengesTable.isActive, true),
    or(isNull(passportChallengesTable.startsAt), lte(passportChallengesTable.startsAt, now)),
    or(isNull(passportChallengesTable.endsAt), gte(passportChallengesTable.endsAt, now)),
  );
}

/**
 * Evaluate every active challenge for an identity: count distinct stamped
 * businesses inside each challenge's rolling window; on completion, insert
 * the reward issuance (exactly-once via the unique constraint) and text the
 * customer. Returns the number of rewards newly issued.
 */
export async function evaluatePassportChallenges(
  identity: PassportIdentity,
  now: Date = new Date(),
): Promise<number> {
  const challenges = await db
    .select()
    .from(passportChallengesTable)
    .where(activeChallengeWindow(now));
  if (challenges.length === 0) return 0;

  const stamps = await db
    .select({ tenantId: passportStampsTable.tenantId, stampedAt: passportStampsTable.stampedAt })
    .from(passportStampsTable)
    .where(eq(passportStampsTable.identityId, identity.id));

  let issued = 0;
  for (const challenge of challenges) {
    const cutoff = new Date(now.getTime() - challenge.windowDays * MS_PER_DAY);
    const distinct = new Set(
      stamps.filter((s) => s.stampedAt >= cutoff).map((s) => s.tenantId),
    );
    if (distinct.size < challenge.requiredBusinesses) continue;
    // Exactly-once: the unique (challenge, identity) constraint makes
    // re-processing a no-op — no returning row means already issued.
    const [issuance] = await db
      .insert(passportRewardIssuancesTable)
      .values({
        challengeId: challenge.id,
        identityId: identity.id,
        rewardType: challenge.rewardType,
        rewardDescription: challenge.rewardDescription,
        stampCount: distinct.size,
      })
      .onConflictDoNothing()
      .returning();
    if (!issuance) continue;
    issued++;
    await notifyRewardIssued(identity, challenge, distinct.size);
  }
  return issued;
}

function rewardNoun(rewardType: string): string {
  switch (rewardType) {
    case "sweepstakes_entry":
      return "a sweepstakes entry";
    case "free_upgrade":
      return "a free service upgrade";
    default:
      return "a bonus perk";
  }
}

async function notifyRewardIssued(
  identity: PassportIdentity,
  challenge: PassportChallenge,
  stampCount: number,
): Promise<void> {
  if (!identity.phone) return; // email-only identities can't receive SMS.
  // STOP anywhere on the network suppresses passport marketing texts.
  if (await phoneHasSmsOptOut(identity.phone)) return;
  const [sponsor] = await db
    .select({ brandName: tenantsTable.brandName })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, challenge.sponsorTenantId));
  await sendMessageSafe({
    tenantId: challenge.sponsorTenantId,
    origin: "marketing",
    toNumber: identity.phone,
    kind: "passport_reward",
    body:
      `🎉 Neighborhood Passport: you completed "${challenge.title}" by visiting ` +
      `${stampCount} local businesses! You've earned ${rewardNoun(challenge.rewardType)}: ` +
      `${challenge.rewardDescription}${sponsor ? ` — sponsored by ${sponsor.brandName}` : ""}. ` +
      `It's waiting on your passport.`,
    context: { challengeId: challenge.id, identityId: identity.id },
  });
}

/**
 * Record a passport stamp for a redemption: resolve/create the identity,
 * insert the stamp (unique per identity + business), and — only when the
 * stamp is new — evaluate milestone challenges. Never throws: passport
 * bookkeeping must never block a redemption.
 */
export async function recordPassportStampSafe(opts: {
  /** Business where the perk was redeemed — the stamp on the passport. */
  redeemedByTenantId: number;
  redemptionId?: number | null;
  person: PassportPerson;
  now?: Date;
}): Promise<void> {
  try {
    const identity = await findOrCreatePassportIdentity(opts.person);
    if (!identity) return; // no phone or email — nothing to key the passport on.
    const [stamp] = await db
      .insert(passportStampsTable)
      .values({
        identityId: identity.id,
        tenantId: opts.redeemedByTenantId,
        redemptionId: opts.redemptionId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!stamp) return; // repeat visit at the same business — no new stamp.
    await evaluatePassportChallenges(identity, opts.now ?? new Date());
  } catch (err) {
    logger.error(
      { err, tenantId: opts.redeemedByTenantId },
      "Passport stamping failed; redemption flow continues",
    );
  }
}

/**
 * Resolve the customer identity behind a classic pass code. Customer-pass
 * QR payloads carry "C<sosCustomerId>" as the instance code; anything else
 * (POS receipt codes, manual entries) has no resolvable person.
 */
export async function personFromClassicPassCode(
  passCode: string,
): Promise<PassportPerson | null> {
  const m = /^C(\d+)$/.exec(passCode.trim());
  if (!m) return null;
  const [customer] = await db
    .select({
      phone: sosCustomersTable.phone,
      email: sosCustomersTable.email,
      name: sosCustomersTable.name,
    })
    .from(sosCustomersTable)
    .where(eq(sosCustomersTable.id, Number(m[1])));
  return customer ?? null;
}

/**
 * Idempotent backfill: create stamps for historical redemptions so existing
 * customers start with credit. Wallet-token redemptions resolve through
 * perk_passes (phone-keyed); classic "C<id>" codes resolve through
 * sos_customers. Deliberately does NOT evaluate challenges or send messages —
 * historical credit should never trigger a retroactive SMS blast; the next
 * live stamp evaluates against the full history anyway.
 */
export async function backfillPassportStamps(): Promise<number> {
  const redemptions = await db
    .select({
      id: coopPerkRedemptionsTable.id,
      passCode: coopPerkRedemptionsTable.passCode,
      redeemedByTenantId: coopPerkRedemptionsTable.redeemedByTenantId,
      redeemedAt: coopPerkRedemptionsTable.redeemedAt,
    })
    .from(coopPerkRedemptionsTable);
  if (redemptions.length === 0) return 0;

  // Resolve wallet tokens in one query.
  const tokens = redemptions.map((r) => r.passCode).filter((c) => isWalletPassToken(c));
  const passByToken = new Map<string, { phone: string; name: string | null }>();
  if (tokens.length > 0) {
    const passes = await db
      .select({
        token: perkPassesTable.token,
        phone: perkPassesTable.customerPhone,
        name: perkPassesTable.customerName,
      })
      .from(perkPassesTable)
      .where(inArray(perkPassesTable.token, tokens));
    for (const p of passes) passByToken.set(p.token, { phone: p.phone, name: p.name });
  }

  let stamped = 0;
  for (const r of redemptions) {
    if (r.redeemedByTenantId == null) continue;
    let person: PassportPerson | null = null;
    if (isWalletPassToken(r.passCode)) {
      person = passByToken.get(r.passCode) ?? null;
    } else {
      person = await personFromClassicPassCode(r.passCode);
    }
    if (!person) continue;
    const identity = await findOrCreatePassportIdentity(person);
    if (!identity) continue;
    const [stamp] = await db
      .insert(passportStampsTable)
      .values({
        identityId: identity.id,
        tenantId: r.redeemedByTenantId,
        redemptionId: r.id,
        stampedAt: r.redeemedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (stamp) stamped++;
  }
  if (stamped > 0) {
    logger.info({ stamped }, "Backfilled passport stamps from historical redemptions");
  }
  return stamped;
}

/** Never-throwing wrapper for startup use. */
export async function backfillPassportStampsSafe(): Promise<void> {
  try {
    await backfillPassportStamps();
  } catch (err) {
    logger.error({ err }, "Passport stamp backfill failed");
  }
}

// ── consumer passport view ───────────────────────────────────────────────────

export interface PassportView {
  stamps: {
    businessName: string;
    stampedAt: string;
  }[];
  stampCount: number;
  tiers: { name: string; threshold: number; unlocked: boolean }[];
  currentTier: string | null;
  challenges: {
    id: number;
    title: string;
    sponsorName: string;
    requiredBusinesses: number;
    windowDays: number;
    rewardType: string;
    rewardDescription: string;
    /** Distinct businesses stamped inside the rolling window right now. */
    progress: number;
    completed: boolean;
    endsAt: string | null;
  }[];
  rewards: {
    id: number;
    challengeTitle: string;
    sponsorName: string;
    rewardType: string;
    rewardDescription: string;
    issuedAt: string;
  }[];
}

/** Assemble the consumer passport for an identity (or an empty shell). */
export async function buildPassportView(
  person: PassportPerson,
  now: Date = new Date(),
): Promise<PassportView> {
  const phone = normalizeToE164(person.phone ?? null);
  const email = normalizeEmail(person.email);
  const conditions = [];
  if (phone) conditions.push(eq(passportIdentitiesTable.phone, phone));
  if (email) conditions.push(eq(passportIdentitiesTable.email, email));
  const [identity] =
    conditions.length > 0
      ? await db.select().from(passportIdentitiesTable).where(or(...conditions)).limit(1)
      : [];

  const stamps = identity
    ? await db
        .select({
          tenantId: passportStampsTable.tenantId,
          stampedAt: passportStampsTable.stampedAt,
          businessName: tenantsTable.brandName,
        })
        .from(passportStampsTable)
        .innerJoin(tenantsTable, eq(passportStampsTable.tenantId, tenantsTable.id))
        .where(eq(passportStampsTable.identityId, identity.id))
        .orderBy(passportStampsTable.stampedAt)
    : [];
  const stampCount = stamps.length;

  const tiers = PASSPORT_TIERS.map((t) => ({
    name: t.name,
    threshold: t.threshold,
    unlocked: stampCount >= t.threshold,
  }));
  const currentTier = [...tiers].reverse().find((t) => t.unlocked)?.name ?? null;

  const challengeRows = await db
    .select({
      challenge: passportChallengesTable,
      sponsorName: tenantsTable.brandName,
    })
    .from(passportChallengesTable)
    .innerJoin(tenantsTable, eq(passportChallengesTable.sponsorTenantId, tenantsTable.id))
    .where(activeChallengeWindow(now));

  const issuances = identity
    ? await db
        .select({
          issuance: passportRewardIssuancesTable,
          challengeTitle: passportChallengesTable.title,
          sponsorTenantId: passportChallengesTable.sponsorTenantId,
        })
        .from(passportRewardIssuancesTable)
        .innerJoin(
          passportChallengesTable,
          eq(passportRewardIssuancesTable.challengeId, passportChallengesTable.id),
        )
        .where(eq(passportRewardIssuancesTable.identityId, identity.id))
    : [];
  const sponsorIds = [...new Set(issuances.map((i) => i.sponsorTenantId))];
  const sponsorNames = new Map<number, string>(
    sponsorIds.length > 0
      ? (
          await db
            .select({ id: tenantsTable.id, brandName: tenantsTable.brandName })
            .from(tenantsTable)
            .where(inArray(tenantsTable.id, sponsorIds))
        ).map((t) => [t.id, t.brandName])
      : [],
  );
  const completedChallengeIds = new Set(issuances.map((i) => i.issuance.challengeId));

  return {
    stamps: stamps.map((s) => ({
      businessName: s.businessName,
      stampedAt: s.stampedAt.toISOString(),
    })),
    stampCount,
    tiers,
    currentTier,
    challenges: challengeRows.map(({ challenge: c, sponsorName }) => {
      const cutoff = new Date(now.getTime() - c.windowDays * MS_PER_DAY);
      const progress = new Set(
        stamps.filter((s) => s.stampedAt >= cutoff).map((s) => s.tenantId),
      ).size;
      return {
        id: c.id,
        title: c.title,
        sponsorName,
        requiredBusinesses: c.requiredBusinesses,
        windowDays: c.windowDays,
        rewardType: c.rewardType,
        rewardDescription: c.rewardDescription,
        progress: Math.min(progress, c.requiredBusinesses),
        completed: completedChallengeIds.has(c.id),
        endsAt: c.endsAt ? c.endsAt.toISOString() : null,
      };
    }),
    rewards: issuances
      .sort((a, b) => b.issuance.issuedAt.getTime() - a.issuance.issuedAt.getTime())
      .map((i) => ({
        id: i.issuance.id,
        challengeTitle: i.challengeTitle,
        sponsorName: sponsorNames.get(i.sponsorTenantId) ?? "a local business",
        rewardType: i.issuance.rewardType,
        rewardDescription: i.issuance.rewardDescription,
        issuedAt: i.issuance.issuedAt.toISOString(),
      })),
  };
}

/** Completion counts per challenge for a sponsor's console. */
export async function challengeCompletionCounts(
  sponsorTenantId: number,
): Promise<Map<number, number>> {
  const rows = await db
    .select({
      challengeId: passportRewardIssuancesTable.challengeId,
      count: sql<number>`count(*)::int`,
    })
    .from(passportRewardIssuancesTable)
    .innerJoin(
      passportChallengesTable,
      eq(passportRewardIssuancesTable.challengeId, passportChallengesTable.id),
    )
    .where(eq(passportChallengesTable.sponsorTenantId, sponsorTenantId))
    .groupBy(passportRewardIssuancesTable.challengeId);
  return new Map(rows.map((r) => [r.challengeId, r.count]));
}
