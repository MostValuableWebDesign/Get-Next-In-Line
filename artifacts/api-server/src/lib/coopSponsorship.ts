import {
  db,
  agencySettingsTable,
  coopFeaturedBoostsTable,
  coopWalletEntriesTable,
  merchantCoopPartnershipsTable,
  type CoopFeaturedBoost,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { recordLedgerEventsSafe } from "./platformLedger";
import { recordRedemptionObligationsSafe } from "./coopSettlement";

// ---------------------------------------------------------------------------
// Co-Op Sponsorship Hub — featured-slot boosts and revenue-share accounting.
//
// Boost lifecycle:
//   flat  → active at purchase (overlap-checked), expired after endsAt.
//   bid   → pending until the window starts; resolveCoopBoosts settles the
//           auction (highest amount wins, earliest bid breaks ties), the
//           winner becomes active + gets charged, losers become lost.
// Rendering only ever honors status='active' AND now inside the window, so
// expiry is failsafe even between ticks.
//
// All amounts are internal accounting (simulated billing) — no real charges.
// ---------------------------------------------------------------------------

export const BOOST_SURFACES = ["discovery", "booking_confirmation"] as const;
export type BoostSurface = (typeof BOOST_SURFACES)[number];

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** Operator-configured platform transaction fee (percent). */
export async function coopPlatformFeePercent(): Promise<number> {
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const fee = parseFloat(settings?.coopPlatformFeePercent ?? "10");
  return Number.isFinite(fee) ? fee : 10;
}

/** Charge a boost to the sponsor's wallet + mirror it into the platform ledger. */
async function chargeBoost(boost: CoopFeaturedBoost, label: string): Promise<void> {
  await db.insert(coopWalletEntriesTable).values({
    tenantId: boost.tenantId,
    entryType: "boost_purchase",
    amount: money(-parseFloat(boost.amount)),
    partnershipId: boost.partnershipId,
    boostId: boost.id,
    description: label,
  });
  await recordLedgerEventsSafe([
    {
      source: "coop_boost",
      sourceRef: `coop_featured_boosts:${boost.id}`,
      tenantId: boost.tenantId,
      category: "Co-Op Sponsorships",
      description: label,
      amount: boost.amount,
      platformMargin: boost.amount,
      occurredAt: new Date(),
    },
  ]);
}

/** Flat purchase: activates immediately. Records the charge. */
export async function activateFlatBoost(boost: CoopFeaturedBoost): Promise<void> {
  await chargeBoost(
    boost,
    `Featured Spot (flat) — ${boost.surface === "discovery" ? "Local Discovery" : "Booking Confirmation"}`,
  );
}

export interface BoostResolutionResult {
  auctionsSettled: number;
  boostsActivated: number;
  bidsLost: number;
  boostsExpired: number;
}

/**
 * Scheduled resolution (concierge tick): settle due auctions and expire
 * ended boosts. Runs inside the tick's advisory-locked transaction context
 * (uses the shared db handle like the other sweeps — each statement is
 * small and idempotent by state transition).
 */
export async function resolveCoopBoosts(now: Date = new Date()): Promise<BoostResolutionResult> {
  const result: BoostResolutionResult = {
    auctionsSettled: 0,
    boostsActivated: 0,
    bidsLost: 0,
    boostsExpired: 0,
  };

  // 1) Settle due auctions: pending bids whose window has started, grouped by
  //    exact (surface, startsAt, endsAt) slot.
  const dueBids = await db
    .select()
    .from(coopFeaturedBoostsTable)
    .where(
      and(
        eq(coopFeaturedBoostsTable.status, "pending"),
        eq(coopFeaturedBoostsTable.pricingType, "bid"),
        lte(coopFeaturedBoostsTable.startsAt, now),
      ),
    );
  const auctions = new Map<string, CoopFeaturedBoost[]>();
  for (const bid of dueBids) {
    const key = `${bid.surface}|${bid.startsAt.getTime()}|${bid.endsAt.getTime()}`;
    const list = auctions.get(key) ?? [];
    list.push(bid);
    auctions.set(key, list);
  }
  for (const bids of auctions.values()) {
    // Highest bid wins; ties broken by earliest bid (then lowest id).
    const sorted = [...bids].sort(
      (a, b) =>
        parseFloat(b.amount) - parseFloat(a.amount) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id - b.id,
    );
    const [winner, ...losers] = sorted;
    // Skip windows already over — expire the whole auction unsettled? No:
    // the winner still gets any remaining window; a fully-elapsed window
    // just loses everyone without charges.
    const windowOver = winner.endsAt <= now;
    if (windowOver) {
      await db
        .update(coopFeaturedBoostsTable)
        .set({ status: "lost", updatedAt: now })
        .where(inArray(coopFeaturedBoostsTable.id, sorted.map((b) => b.id)));
      result.bidsLost += sorted.length;
      result.auctionsSettled++;
      continue;
    }
    const [activated] = await db
      .update(coopFeaturedBoostsTable)
      .set({ status: "active", updatedAt: now })
      .where(
        and(eq(coopFeaturedBoostsTable.id, winner.id), eq(coopFeaturedBoostsTable.status, "pending")),
      )
      .returning();
    if (activated) {
      await chargeBoost(
        activated,
        `Featured Spot (winning bid) — ${activated.surface === "discovery" ? "Local Discovery" : "Booking Confirmation"}`,
      );
      result.boostsActivated++;
    }
    if (losers.length > 0) {
      await db
        .update(coopFeaturedBoostsTable)
        .set({ status: "lost", updatedAt: now })
        .where(
          and(
            inArray(coopFeaturedBoostsTable.id, losers.map((b) => b.id)),
            eq(coopFeaturedBoostsTable.status, "pending"),
          ),
        );
      result.bidsLost += losers.length;
    }
    result.auctionsSettled++;
  }

  // 2) Activate scheduled flat purchases whose window has opened. Flats are
  //    charged at purchase time; a future-dated flat sits pending until here.
  //    Fully-elapsed windows go straight to expired (counted as expired, not
  //    activated, so the tick result reflects what actually rendered).
  const lapsedFlats = await db
    .update(coopFeaturedBoostsTable)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(coopFeaturedBoostsTable.status, "pending"),
        eq(coopFeaturedBoostsTable.pricingType, "flat"),
        lte(coopFeaturedBoostsTable.endsAt, now),
      ),
    )
    .returning({ id: coopFeaturedBoostsTable.id });
  result.boostsExpired += lapsedFlats.length;
  const dueFlats = await db
    .update(coopFeaturedBoostsTable)
    .set({ status: "active", updatedAt: now })
    .where(
      and(
        eq(coopFeaturedBoostsTable.status, "pending"),
        eq(coopFeaturedBoostsTable.pricingType, "flat"),
        lte(coopFeaturedBoostsTable.startsAt, now),
        gt(coopFeaturedBoostsTable.endsAt, now),
      ),
    )
    .returning({ id: coopFeaturedBoostsTable.id });
  result.boostsActivated += dueFlats.length;

  // 3) Expire ended boosts.
  const expired = await db
    .update(coopFeaturedBoostsTable)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(eq(coopFeaturedBoostsTable.status, "active"), lte(coopFeaturedBoostsTable.endsAt, now)),
    )
    .returning({ id: coopFeaturedBoostsTable.id });
  result.boostsExpired += expired.length;

  if (
    result.auctionsSettled > 0 ||
    result.boostsExpired > 0
  ) {
    logger.info({ ...result }, "co-op boost resolution ran");
  }
  return result;
}

/**
 * Boosts currently rendering on a surface: status active AND now inside the
 * window (belt-and-braces so an expired-but-unswept boost never renders).
 */
export async function activeBoostsForSurface(
  surface: BoostSurface,
  now: Date = new Date(),
): Promise<CoopFeaturedBoost[]> {
  return db
    .select()
    .from(coopFeaturedBoostsTable)
    .where(
      and(
        eq(coopFeaturedBoostsTable.surface, surface),
        eq(coopFeaturedBoostsTable.status, "active"),
        lte(coopFeaturedBoostsTable.startsAt, now),
        gt(coopFeaturedBoostsTable.endsAt, now),
      ),
    );
}

/**
 * Revenue-share split accounting for a perk redemption.
 *
 * The redeeming business (where the referred customer showed up) pays the
 * referring partner (the other side of the partnership):
 *   bounty  → flat revenueShareValue dollars per redemption
 *   percent → revenueShareValue % of revenueShareBaseAmount (the agreed
 *             nominal transaction value per redemption)
 * The platform fee is deducted from the earner's share and mirrored into the
 * platform compliance ledger. Idempotent per redemption: skipped when
 * entries for this redemptionId already exist.
 *
 * Never throws — accounting failures are logged loudly but must not break
 * the redemption itself (the redemption row is the source of truth and the
 * ledger is recoverable).
 */
export async function applyRedemptionSplitSafe(
  partnership: MerchantCoopPartnership,
  redemptionId: number,
  redeemingTenantId: number,
): Promise<void> {
  try {
    // Settlement clearinghouse: record the inter-business obligation this
    // redemption creates (referral fee or perk-value balance). This is the
    // single choke point every redemption path already flows through.
    await recordRedemptionObligationsSafe(partnership, redemptionId, redeemingTenantId);
    if (!partnership.revenueShareKind) return;
    if (
      redeemingTenantId !== partnership.hostTenantId &&
      redeemingTenantId !== partnership.partnerTenantId
    ) {
      return; // splits only apply between the two participants
    }
    const earnerTenantId =
      redeemingTenantId === partnership.hostTenantId
        ? partnership.partnerTenantId
        : partnership.hostTenantId;

    const value = parseFloat(partnership.revenueShareValue ?? "0");
    let gross = 0;
    if (partnership.revenueShareKind === "bounty") {
      gross = value;
    } else if (partnership.revenueShareKind === "percent") {
      const base = parseFloat(partnership.revenueShareBaseAmount ?? "0");
      gross = (base * value) / 100;
    }
    gross = Math.round(gross * 100) / 100;
    if (!(gross > 0)) return;

    const feePercent = await coopPlatformFeePercent();
    const fee = Math.round(gross * feePercent) / 100; // gross * pct / 100, cents-rounded
    const net = Math.round((gross - fee) * 100) / 100;

    await db.transaction(async (tx) => {
      // Idempotency: one split per redemption.
      const existing = await tx
        .select({ id: coopWalletEntriesTable.id })
        .from(coopWalletEntriesTable)
        .where(eq(coopWalletEntriesTable.redemptionId, redemptionId))
        .limit(1);
      if (existing.length > 0) return;
      await tx.insert(coopWalletEntriesTable).values([
        {
          tenantId: earnerTenantId,
          entryType: "redemption_earning",
          amount: money(net),
          fee: money(fee),
          partnershipId: partnership.id,
          redemptionId,
          description:
            partnership.revenueShareKind === "bounty"
              ? `Referral bounty — "${partnership.perkTitle}"`
              : `Revenue split (${value}% of $${money(parseFloat(partnership.revenueShareBaseAmount ?? "0"))}) — "${partnership.perkTitle}"`,
        },
        {
          tenantId: redeemingTenantId,
          entryType: "redemption_charge",
          amount: money(-gross),
          partnershipId: partnership.id,
          redemptionId,
          description: `Referral share owed to partner — "${partnership.perkTitle}"`,
        },
      ]);
    });
    await recordLedgerEventsSafe([
      {
        source: "coop_split_fee",
        sourceRef: `coop_perk_redemptions:${redemptionId}`,
        tenantId: earnerTenantId,
        category: "Co-Op Sponsorships",
        description: `Platform fee (${feePercent}%) on co-op revenue split`,
        amount: money(fee),
        platformMargin: money(fee),
        occurredAt: new Date(),
      },
    ]);
  } catch (err) {
    logger.error(
      { err, redemptionId, partnershipId: partnership.id },
      "CO-OP SPLIT ACCOUNTING FAILED — wallet ledger is missing entries for this redemption",
    );
  }
}

/** Load a partnership row by id (for split hooks that only have the id). */
export async function partnershipById(id: number): Promise<MerchantCoopPartnership | null> {
  const [row] = await db
    .select()
    .from(merchantCoopPartnershipsTable)
    .where(eq(merchantCoopPartnershipsTable.id, id));
  return row ?? null;
}

/** Wallet aggregates for one tenant. */
export async function walletTotals(tenantId: number): Promise<{
  balance: number;
  lifetimeEarnings: number;
  totalFees: number;
}> {
  const [row] = await db
    .select({
      balance: sql<string>`coalesce(sum(${coopWalletEntriesTable.amount}) filter (where ${coopWalletEntriesTable.status} = 'pending'), 0)`,
      lifetimeEarnings: sql<string>`coalesce(sum(${coopWalletEntriesTable.amount}) filter (where ${coopWalletEntriesTable.amount} > 0), 0)`,
      totalFees: sql<string>`coalesce(sum(${coopWalletEntriesTable.fee}), 0)`,
    })
    .from(coopWalletEntriesTable)
    .where(eq(coopWalletEntriesTable.tenantId, tenantId));
  return {
    balance: parseFloat(row?.balance ?? "0"),
    lifetimeEarnings: parseFloat(row?.lifetimeEarnings ?? "0"),
    totalFees: parseFloat(row?.totalFees ?? "0"),
  };
}
