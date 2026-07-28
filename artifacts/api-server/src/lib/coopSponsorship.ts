import {
  db,
  agencySettingsTable,
  coopFeaturedBoostsTable,
  coopWalletEntriesTable,
  merchantCoopPartnershipsTable,
  tenantsTable,
  type CoopFeaturedBoost,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { and, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { recordLedgerEventsSafe } from "./platformLedger";
import { recordRedemptionObligationsSafe } from "./coopSettlement";
import { getUncachableStripeClient, isStripeConfigured } from "./stripeClient";
import {
  MAX_DEPOSIT_RETRY_ATTEMPTS,
  depositRetryBackoffMs,
  toStripeOpFailure,
  type StripeOpFailure,
} from "./noShowShield";

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
// Billing: two payment modes, one execution path (mirroring settlement
// payouts). When Stripe is configured, boosts move real money — flat
// purchases charge the sponsor's card at purchase time (a declined charge
// blocks activation), and auction bids place a manual-capture hold at bid
// time that is captured for the winner and released for every loser at
// resolution. When Stripe is NOT configured (dev/test), everything runs in
// "simulated" mode: internal accounting only, clearly labeled as such on the
// wallet entries and boost records.
// ---------------------------------------------------------------------------

export const BOOST_SURFACES = ["discovery", "booking_confirmation"] as const;
export type BoostSurface = (typeof BOOST_SURFACES)[number];

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const cents = (amount: string) => Math.round(parseFloat(amount) * 100);

// ── Live-mode gate ───────────────────────────────────────────────────────────
// Under NODE_ENV=test real boost charges are disabled by default so the
// sponsorship integration tests exercise the simulated path against the real
// dev DB. Live-mode tests opt back in via the hook below with a mocked
// Stripe client.
let liveBoostChargesForTests: boolean | null = null;

/** Test hook: force live boost charges on/off (null restores default). */
export function __setLiveBoostChargesForTests(value: boolean | null): void {
  liveBoostChargesForTests = value;
}

/** Whether boost purchases should move real money through Stripe. */
export function liveBoostChargesEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return liveBoostChargesForTests ?? false;
  return isStripeConfigured();
}

// ── Stripe primitives (never throw — they return a failure record) ──────────

/**
 * Resolve the sponsor's saved Stripe billing context: the Stripe customer for
 * this tenant plus a reusable card on file. Sponsors are charged off-session
 * at purchase/bid time, so a card MUST already be on file (attached to a
 * Stripe customer tagged with the tenant id in metadata, or matching the
 * tenant's contact email). No card on file is a permanent failure — retrying
 * cannot help until the sponsor adds a payment method.
 */
async function resolveSponsorBillingContext(
  stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>,
  tenantId: number,
): Promise<{ customerId: string; paymentMethodId: string } | { failure: StripeOpFailure }> {
  const noCard = (detail: string): { failure: StripeOpFailure } => ({
    failure: {
      permanent: true,
      message: `No card on file for this business (${detail}). Add a payment method by completing a Stripe checkout for this business first.`,
    },
  });
  try {
    // Prefer an explicit metadata tag; fall back to the tenant's contact email.
    let customerId: string | null = null;
    const search = await stripe.customers.search({
      query: `metadata['gnilTenantId']:'${tenantId}'`,
      limit: 1,
    });
    customerId = search.data[0]?.id ?? null;
    if (!customerId) {
      const [tenant] = await db
        .select({ contactEmail: tenantsTable.contactEmail })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId));
      if (tenant?.contactEmail) {
        const byEmail = await stripe.customers.list({ email: tenant.contactEmail, limit: 1 });
        customerId = byEmail.data[0]?.id ?? null;
      }
    }
    if (!customerId) return noCard("no Stripe customer found for this business");

    const customer = await stripe.customers.retrieve(customerId);
    const defaultPm =
      !("deleted" in customer && customer.deleted) &&
      typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : null;
    if (defaultPm) return { customerId, paymentMethodId: defaultPm };
    const cards = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
    const pm = cards.data[0]?.id ?? null;
    if (!pm) return noCard("the business's Stripe customer has no saved card");
    return { customerId, paymentMethodId: pm };
  } catch (err) {
    logger.error({ err, tenantId }, "Failed to resolve sponsor Stripe billing context");
    return { failure: toStripeOpFailure(err) };
  }
}

/**
 * Charge the sponsor for a flat boost purchase (immediate capture,
 * off-session against the card on file). Success requires the PaymentIntent
 * to land in a terminal `succeeded` state — anything else (processing,
 * requires_action/SCA, requires_payment_method) blocks activation.
 */
export async function createBoostCharge(
  boost: CoopFeaturedBoost,
): Promise<{ paymentIntentId: string } | { failure: StripeOpFailure }> {
  try {
    const stripe = await getUncachableStripeClient();
    const billing = await resolveSponsorBillingContext(stripe, boost.tenantId);
    if ("failure" in billing) return billing;
    const intent = await stripe.paymentIntents.create(
      {
        amount: cents(boost.amount),
        currency: "usd",
        customer: billing.customerId,
        payment_method: billing.paymentMethodId,
        confirm: true,
        off_session: true,
        payment_method_types: ["card"],
        description: `Co-op featured boost #${boost.id} (flat) — ${boost.surface}`,
        metadata: { coopBoostId: String(boost.id), tenantId: String(boost.tenantId) },
      },
      { idempotencyKey: `coop-boost-charge-${boost.id}` },
    );
    if (intent.status !== "succeeded") {
      // Off-session charges cannot complete SCA/next_action challenges, and a
      // non-terminal status means no money has verifiably moved — never
      // activate on it.
      return {
        failure: {
          permanent: intent.status === "requires_action" || intent.status === "requires_payment_method",
          message: `Stripe charge did not complete (status: ${intent.status}) — the boost was not paid for.`,
        },
      };
    }
    return { paymentIntentId: intent.id };
  } catch (err) {
    logger.error({ err, boostId: boost.id }, "Stripe boost charge failed");
    return { failure: toStripeOpFailure(err) };
  }
}

/**
 * Place a manual-capture hold for an auction bid (off-session against the
 * card on file). The hold is captured only if the bid wins; losers' holds
 * are released at resolution. Success requires the PaymentIntent to be in
 * `requires_capture` — the only state in which the authorization is actually
 * capturable later.
 */
export async function createBoostBidHold(
  boost: CoopFeaturedBoost,
): Promise<{ paymentIntentId: string } | { failure: StripeOpFailure }> {
  try {
    const stripe = await getUncachableStripeClient();
    const billing = await resolveSponsorBillingContext(stripe, boost.tenantId);
    if ("failure" in billing) return billing;
    const intent = await stripe.paymentIntents.create(
      {
        amount: cents(boost.amount),
        currency: "usd",
        customer: billing.customerId,
        payment_method: billing.paymentMethodId,
        confirm: true,
        off_session: true,
        capture_method: "manual",
        payment_method_types: ["card"],
        description: `Co-op featured boost #${boost.id} (auction bid hold) — ${boost.surface}`,
        metadata: { coopBoostId: String(boost.id), tenantId: String(boost.tenantId) },
      },
      { idempotencyKey: `coop-boost-hold-${boost.id}` },
    );
    if (intent.status !== "requires_capture") {
      return {
        failure: {
          permanent: intent.status === "requires_action" || intent.status === "requires_payment_method",
          message: `Stripe card hold was not authorized (status: ${intent.status}) — the bid cannot be entered without a capturable hold.`,
        },
      };
    }
    return { paymentIntentId: intent.id };
  } catch (err) {
    logger.error({ err, boostId: boost.id }, "Stripe boost bid hold failed");
    return { failure: toStripeOpFailure(err) };
  }
}

/**
 * Capture a winning bid's hold. Idempotent per PaymentIntent. Success
 * requires the captured PaymentIntent to report `succeeded`; any other
 * status is treated as a transient failure and retried.
 */
async function captureBoostHold(paymentIntentId: string): Promise<StripeOpFailure | null> {
  try {
    const stripe = await getUncachableStripeClient();
    const captured = await stripe.paymentIntents.capture(paymentIntentId);
    if (captured.status !== "succeeded") {
      return {
        permanent: false,
        message: `Stripe capture did not complete (status: ${captured.status})`,
      };
    }
    return null;
  } catch (err) {
    logger.error({ err, paymentIntentId }, "Stripe boost hold capture failed");
    return toStripeOpFailure(err);
  }
}

/** Release (cancel) a losing bid's hold. Idempotent per PaymentIntent. */
async function releaseBoostHold(paymentIntentId: string): Promise<StripeOpFailure | null> {
  try {
    const stripe = await getUncachableStripeClient();
    await stripe.paymentIntents.cancel(paymentIntentId);
    return null;
  } catch (err) {
    logger.error({ err, paymentIntentId }, "Stripe boost hold release failed");
    return toStripeOpFailure(err);
  }
}

/** Operator-configured platform transaction fee (percent). */
export async function coopPlatformFeePercent(): Promise<number> {
  const [settings] = await db.select().from(agencySettingsTable).limit(1);
  const fee = parseFloat(settings?.coopPlatformFeePercent ?? "10");
  return Number.isFinite(fee) ? fee : 10;
}

/**
 * Record a boost charge in the sponsor's wallet + mirror it into the platform
 * ledger. The entry shapes are unchanged from simulated-only days; the
 * description carries the payment reference (real charge) or a SIMULATED
 * label so both surfaces show which mode billed the boost.
 */
async function chargeBoost(boost: CoopFeaturedBoost, label: string): Promise<void> {
  const suffix =
    boost.paymentMode === "stripe" && boost.stripePaymentIntentId
      ? ` — paid via Stripe (${boost.stripePaymentIntentId})`
      : " — SIMULATED (no real charge)";
  const description = `${label}${suffix}`;
  await db.insert(coopWalletEntriesTable).values({
    tenantId: boost.tenantId,
    entryType: "boost_purchase",
    amount: money(-parseFloat(boost.amount)),
    partnershipId: boost.partnershipId,
    boostId: boost.id,
    description,
  });
  await recordLedgerEventsSafe([
    {
      source: "coop_boost",
      sourceRef: `coop_featured_boosts:${boost.id}`,
      tenantId: boost.tenantId,
      category: "Co-Op Sponsorships",
      description,
      amount: boost.amount,
      platformMargin: boost.amount,
      occurredAt: new Date(),
    },
  ]);
}

const surfaceLabel = (surface: string) =>
  surface === "discovery" ? "Local Discovery" : "Booking Confirmation";

export type FlatBoostChargeResult =
  | { ok: true; boost: CoopFeaturedBoost }
  | { ok: false; failure: StripeOpFailure };

/**
 * Flat purchase: charge the sponsor, then record the charge. In live mode a
 * failed Stripe charge blocks activation — the caller must delete the
 * reserved row and surface the decline. In simulated mode this never fails.
 */
export async function activateFlatBoost(boost: CoopFeaturedBoost): Promise<FlatBoostChargeResult> {
  let charged = boost;
  if (liveBoostChargesEnabled()) {
    const res = await createBoostCharge(boost);
    if ("failure" in res) return { ok: false, failure: res.failure };
    const [updated] = await db
      .update(coopFeaturedBoostsTable)
      .set({
        paymentMode: "stripe",
        stripePaymentIntentId: res.paymentIntentId,
        updatedAt: new Date(),
      })
      .where(eq(coopFeaturedBoostsTable.id, boost.id))
      .returning();
    charged = updated ?? { ...boost, paymentMode: "stripe", stripePaymentIntentId: res.paymentIntentId };
  }
  await chargeBoost(charged, `Featured Spot (flat) — ${surfaceLabel(boost.surface)}`);
  return { ok: true, boost: charged };
}

export type BidHoldResult =
  | { ok: true; boost: CoopFeaturedBoost }
  | { ok: false; failure: StripeOpFailure };

/**
 * Auction bid: in live mode place a manual-capture hold on the sponsor's
 * card at bid time. A failed hold blocks the bid — the caller must delete
 * the row and surface the decline. Simulated mode records nothing (losers
 * were never going to be charged anyway).
 */
export async function placeBidHold(boost: CoopFeaturedBoost): Promise<BidHoldResult> {
  if (!liveBoostChargesEnabled()) return { ok: true, boost };
  const res = await createBoostBidHold(boost);
  if ("failure" in res) return { ok: false, failure: res.failure };
  const [updated] = await db
    .update(coopFeaturedBoostsTable)
    .set({
      paymentMode: "stripe",
      stripePaymentIntentId: res.paymentIntentId,
      updatedAt: new Date(),
    })
    .where(eq(coopFeaturedBoostsTable.id, boost.id))
    .returning();
  return {
    ok: true,
    boost: updated ?? { ...boost, paymentMode: "stripe", stripePaymentIntentId: res.paymentIntentId },
  };
}

export interface BoostResolutionResult {
  auctionsSettled: number;
  boostsActivated: number;
  bidsLost: number;
  boostsExpired: number;
  /** Pending Stripe capture/release retries attempted this run. */
  chargeRetries: number;
}

/**
 * Handle a failed Stripe capture for a settled auction's winner, following
 * the deposit-hold failure taxonomy: permanent failures (card declines,
 * invalid requests) go terminally "lost" — the boost never activates and the
 * sponsor is never charged; transient failures keep the winner "pending" with
 * retry bookkeeping the concierge sweep re-attempts. Retry-budget exhaustion
 * also goes terminal so nothing sticks silently.
 */
async function recordWinnerCaptureFailure(
  boost: CoopFeaturedBoost,
  failure: StripeOpFailure,
  attemptsMade: number,
  now: Date,
): Promise<void> {
  if (failure.permanent || attemptsMade >= MAX_DEPOSIT_RETRY_ATTEMPTS) {
    await db
      .update(coopFeaturedBoostsTable)
      .set({
        status: "lost",
        paymentFailureReason: failure.permanent
          ? `Winning bid capture FAILED permanently — the boost was not activated and the sponsor was not charged. The card hold may still be active on Stripe and needs operator attention: ${failure.message}`
          : `Winning bid capture failed ${attemptsMade} times and the automatic retry budget is exhausted — the boost was not activated. The card hold may still be active on Stripe and needs operator attention. Last error: ${failure.message}`,
        retryOperation: null,
        nextRetryAt: null,
        updatedAt: now,
      })
      .where(
        and(eq(coopFeaturedBoostsTable.id, boost.id), eq(coopFeaturedBoostsTable.status, "pending")),
      );
    return;
  }
  const nextRetryAt = new Date(now.getTime() + depositRetryBackoffMs(attemptsMade));
  await db
    .update(coopFeaturedBoostsTable)
    .set({
      retryOperation: "capture",
      retryAttempts: attemptsMade,
      nextRetryAt,
      paymentFailureReason: `Winning bid capture failed (attempt ${attemptsMade} of ${MAX_DEPOSIT_RETRY_ATTEMPTS}) — will retry automatically at ${nextRetryAt.toISOString()}. Error: ${failure.message}`,
      updatedAt: now,
    })
    .where(
      and(eq(coopFeaturedBoostsTable.id, boost.id), eq(coopFeaturedBoostsTable.status, "pending")),
    );
}

/** Same taxonomy for a loser's hold release (the boost is already lost). */
async function recordLoserReleaseFailure(
  boost: CoopFeaturedBoost,
  failure: StripeOpFailure,
  attemptsMade: number,
  now: Date,
): Promise<void> {
  if (failure.permanent || attemptsMade >= MAX_DEPOSIT_RETRY_ATTEMPTS) {
    await db
      .update(coopFeaturedBoostsTable)
      .set({
        paymentFailureReason: failure.permanent
          ? `Losing bid hold release FAILED permanently — the card hold may still be active on Stripe and needs operator attention: ${failure.message}`
          : `Losing bid hold release failed ${attemptsMade} times and the automatic retry budget is exhausted — the card hold may still be active on Stripe and needs operator attention. Last error: ${failure.message}`,
        retryOperation: null,
        nextRetryAt: null,
        updatedAt: now,
      })
      .where(eq(coopFeaturedBoostsTable.id, boost.id));
    return;
  }
  const nextRetryAt = new Date(now.getTime() + depositRetryBackoffMs(attemptsMade));
  await db
    .update(coopFeaturedBoostsTable)
    .set({
      retryOperation: "release",
      retryAttempts: attemptsMade,
      nextRetryAt,
      paymentFailureReason: `Losing bid hold release failed (attempt ${attemptsMade} of ${MAX_DEPOSIT_RETRY_ATTEMPTS}) — will retry automatically at ${nextRetryAt.toISOString()}. Error: ${failure.message}`,
      updatedAt: now,
    })
    .where(eq(coopFeaturedBoostsTable.id, boost.id));
}

/**
 * Settle an auction winner: capture the live hold first (when one exists),
 * then activate under a conditional pending→active claim and record the
 * wallet/ledger charge. Returns true when the boost was activated.
 */
async function settleAuctionWinner(winner: CoopFeaturedBoost, now: Date): Promise<boolean> {
  if (winner.paymentMode === "stripe" && winner.stripePaymentIntentId) {
    const failure = await captureBoostHold(winner.stripePaymentIntentId);
    if (failure) {
      await recordWinnerCaptureFailure(winner, failure, winner.retryAttempts + 1, now);
      return false;
    }
  }
  const [activated] = await db
    .update(coopFeaturedBoostsTable)
    .set({
      status: "active",
      paymentFailureReason: null,
      retryOperation: null,
      nextRetryAt: null,
      updatedAt: now,
    })
    .where(
      and(eq(coopFeaturedBoostsTable.id, winner.id), eq(coopFeaturedBoostsTable.status, "pending")),
    )
    .returning();
  if (!activated) return false;
  await chargeBoost(
    activated,
    `Featured Spot (winning bid) — ${surfaceLabel(activated.surface)}`,
  );
  return true;
}

/** Release the live holds of losing bids; losers are never charged. */
async function releaseLoserHolds(losers: CoopFeaturedBoost[], now: Date): Promise<void> {
  for (const loser of losers) {
    if (loser.paymentMode !== "stripe" || !loser.stripePaymentIntentId) continue;
    const failure = await releaseBoostHold(loser.stripePaymentIntentId);
    if (failure) {
      await recordLoserReleaseFailure(loser, failure, loser.retryAttempts + 1, now);
    } else {
      await db
        .update(coopFeaturedBoostsTable)
        .set({ paymentFailureReason: null, retryOperation: null, nextRetryAt: null, updatedAt: now })
        .where(eq(coopFeaturedBoostsTable.id, loser.id));
    }
  }
}

/**
 * Concierge sweep: re-attempt Stripe captures/releases that failed
 * transiently. The conditional attempt-bump claim is the double-attempt
 * lock, so this is safe to run on every tick.
 */
export async function sweepBoostChargeRetries(now: Date = new Date()): Promise<number> {
  const candidates = await db
    .select()
    .from(coopFeaturedBoostsTable)
    .where(
      and(
        isNotNull(coopFeaturedBoostsTable.retryOperation),
        lte(coopFeaturedBoostsTable.nextRetryAt, now),
      ),
    );
  let attempted = 0;
  for (const candidate of candidates) {
    // Claim: exactly one worker performs this attempt. Bumps the attempt
    // count and reschedules pessimistically; success or terminal failure
    // below overwrites the rescheduled state.
    const [claimed] = await db
      .update(coopFeaturedBoostsTable)
      .set({
        retryAttempts: sql`${coopFeaturedBoostsTable.retryAttempts} + 1`,
        nextRetryAt: new Date(now.getTime() + depositRetryBackoffMs(candidate.retryAttempts + 1)),
      })
      .where(
        and(
          eq(coopFeaturedBoostsTable.id, candidate.id),
          isNotNull(coopFeaturedBoostsTable.retryOperation),
          lte(coopFeaturedBoostsTable.nextRetryAt, now),
        ),
      )
      .returning();
    if (!claimed || !claimed.stripePaymentIntentId) continue;
    attempted++;

    if (claimed.retryOperation === "capture") {
      // The window may have fully elapsed while retrying — capturing would
      // charge for a slot that never rendered. Release instead.
      if (claimed.endsAt <= now) {
        const failure = await releaseBoostHold(claimed.stripePaymentIntentId);
        if (failure) {
          await recordLoserReleaseFailure(claimed, failure, claimed.retryAttempts, now);
          continue;
        }
        await db
          .update(coopFeaturedBoostsTable)
          .set({
            status: "lost",
            paymentFailureReason: `Winning bid window elapsed before the capture retry succeeded — the hold was released and the sponsor was not charged.`,
            retryOperation: null,
            nextRetryAt: null,
            updatedAt: now,
          })
          .where(eq(coopFeaturedBoostsTable.id, claimed.id));
        continue;
      }
      const failure = await captureBoostHold(claimed.stripePaymentIntentId);
      if (failure) {
        await recordWinnerCaptureFailure(claimed, failure, claimed.retryAttempts, now);
        continue;
      }
      const [activated] = await db
        .update(coopFeaturedBoostsTable)
        .set({
          status: "active",
          paymentFailureReason: null,
          retryOperation: null,
          nextRetryAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(coopFeaturedBoostsTable.id, claimed.id),
            eq(coopFeaturedBoostsTable.status, "pending"),
          ),
        )
        .returning();
      if (activated) {
        await chargeBoost(
          activated,
          `Featured Spot (winning bid) — ${surfaceLabel(activated.surface)}`,
        );
      }
    } else {
      const failure = await releaseBoostHold(claimed.stripePaymentIntentId);
      if (failure) {
        await recordLoserReleaseFailure(claimed, failure, claimed.retryAttempts, now);
        continue;
      }
      await db
        .update(coopFeaturedBoostsTable)
        .set({ paymentFailureReason: null, retryOperation: null, nextRetryAt: null, updatedAt: now })
        .where(eq(coopFeaturedBoostsTable.id, claimed.id));
    }
  }
  return attempted;
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
    chargeRetries: 0,
  };

  // 0) Re-attempt transiently-failed Stripe captures/releases first, so a
  //    recovered winner activates before this run's expiry pass.
  result.chargeRetries = await sweepBoostChargeRetries(now);

  // 1) Settle due auctions: pending bids whose window has started, grouped by
  //    exact (surface, startsAt, endsAt) slot. Bids carrying retry
  //    bookkeeping belong to an already-settled auction awaiting a capture
  //    retry — the sweep above owns those, not the auction grouping.
  const dueBids = await db
    .select()
    .from(coopFeaturedBoostsTable)
    .where(
      and(
        eq(coopFeaturedBoostsTable.status, "pending"),
        eq(coopFeaturedBoostsTable.pricingType, "bid"),
        lte(coopFeaturedBoostsTable.startsAt, now),
        sql`${coopFeaturedBoostsTable.retryOperation} is null`,
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
      // Nobody is charged for a fully-elapsed window — release every hold.
      await releaseLoserHolds(sorted, now);
      result.bidsLost += sorted.length;
      result.auctionsSettled++;
      continue;
    }
    // Winner: capture the live hold (when one exists) then activate + charge.
    // A permanent capture failure marks the boost lost; a transient one keeps
    // it pending with retry bookkeeping for the sweep — either way losers are
    // settled below, because the auction outcome is already decided.
    if (await settleAuctionWinner(winner, now)) {
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
      // Losers are never charged: release their live holds.
      await releaseLoserHolds(losers, now);
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
