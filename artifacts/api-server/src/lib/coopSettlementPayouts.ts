// Settlement payout engine — the real money leg of the co-op clearinghouse.
//
// Two payout modes, one execution path (mirroring module checkout):
//   - "simulated": Stripe isn't configured (or the tenant has no payout
//     destination attached) — the payout completes immediately with no real
//     transfer, and the record says so.
//   - "stripe": Stripe IS configured and the tenant has a Connect account
//     attached — a real Stripe transfer moves the funds.
//
// Idempotency: one payout row per statement (unique statementId). New rows
// are claimed via insert ... onConflictDoNothing; failed/stale-pending rows
// are re-claimed with a conditional update, and real transfers carry a Stripe
// idempotency key derived from the payout row id — so re-running a cycle's
// payout step can never double-pay a business.
import {
  db,
  tenantsTable,
  coopSettlementCyclesTable,
  coopSettlementStatementsTable,
  coopSettlementPayoutsTable,
  tenantActivitiesTable,
  type CoopSettlementPayout,
} from "@workspace/db";
import { and, eq, inArray, gt } from "drizzle-orm";
import { getUncachableStripeClient, isStripeConfigured } from "./stripeClient";
import { logger } from "./logger";

// ── Live-mode gate ───────────────────────────────────────────────────────────
// Under NODE_ENV=test real Stripe payouts are disabled by default so payout
// integration tests exercise the simulated path against the real dev DB.
// Live-mode tests opt back in via the hook below with a mocked Stripe client.
let livePayoutsForTests: boolean | null = null;

/** Test hook: force live settlement payouts on/off (null restores default). */
export function __setLiveSettlementPayoutsForTests(value: boolean | null): void {
  livePayoutsForTests = value;
}

/** Whether settlement payouts should move real money through Stripe. */
export function liveSettlementPayoutsEnabled(): boolean {
  if (process.env.NODE_ENV === "test") return livePayoutsForTests ?? false;
  return isStripeConfigured();
}

const toCents = (amount: string) => Math.round(parseFloat(amount) * 100);

export interface PayoutRunResult {
  ok: true;
  cycleId: number;
  eligibleCount: number;
  paidCount: number;
  simulatedCount: number;
  failedCount: number;
  skippedCount: number;
  payouts: CoopSettlementPayout[];
}

export type RunCyclePayoutsResult = PayoutRunResult | { ok: false; reason: "not_found" };

/**
 * Execute (or retry) payouts for every net-positive statement of a closed
 * cycle. Safe to re-run: already paid/simulated statements are skipped,
 * failed ones are retried, and Stripe idempotency keys make even a
 * crash-after-transfer retry single-pay.
 */
export async function runCyclePayouts(cycleId: number): Promise<RunCyclePayoutsResult> {
  const [cycle] = await db
    .select()
    .from(coopSettlementCyclesTable)
    .where(eq(coopSettlementCyclesTable.id, cycleId));
  if (!cycle) return { ok: false, reason: "not_found" };

  // Creditors only: statements with a positive net balance.
  const statements = await db
    .select()
    .from(coopSettlementStatementsTable)
    .where(
      and(
        eq(coopSettlementStatementsTable.cycleId, cycleId),
        gt(coopSettlementStatementsTable.netAmount, "0"),
      ),
    )
    .orderBy(coopSettlementStatementsTable.tenantId);

  const empty: PayoutRunResult = {
    ok: true,
    cycleId,
    eligibleCount: statements.length,
    paidCount: 0,
    simulatedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    payouts: [],
  };
  if (statements.length === 0) return empty;

  // Seed one payout row per statement (idempotent — existing rows survive).
  await db
    .insert(coopSettlementPayoutsTable)
    .values(
      statements.map((s) => ({
        cycleId,
        statementId: s.id,
        tenantId: s.tenantId,
        amount: s.netAmount,
        status: "pending",
        mode: "simulated",
      })),
    )
    .onConflictDoNothing();

  // Claim everything not already terminally settled: pending rows (fresh or
  // left by a crashed run) and failed rows (explicit retry). Paid/simulated
  // rows are never touched — that's the never-double-pay guarantee.
  const claimed = await db
    .update(coopSettlementPayoutsTable)
    .set({ status: "pending", failureReason: null })
    .where(
      and(
        eq(coopSettlementPayoutsTable.cycleId, cycleId),
        inArray(coopSettlementPayoutsTable.status, ["pending", "failed"]),
      ),
    )
    .returning();

  const live = liveSettlementPayoutsEnabled();
  const tenantIds = [...new Set(claimed.map((p) => p.tenantId))];
  const tenants = tenantIds.length
    ? await db
        .select({
          id: tenantsTable.id,
          brandName: tenantsTable.brandName,
          payoutStripeAccountId: tenantsTable.payoutStripeAccountId,
        })
        .from(tenantsTable)
        .where(inArray(tenantsTable.id, tenantIds))
    : [];
  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  let paidCount = 0;
  let simulatedCount = 0;
  let failedCount = 0;

  for (const payout of claimed) {
    const tenant = tenantById.get(payout.tenantId);
    const destination = tenant?.payoutStripeAccountId ?? null;

    if (live && destination) {
      try {
        const stripe = await getUncachableStripeClient();
        const transfer = await stripe.transfers.create(
          {
            amount: toCents(payout.amount),
            currency: "usd",
            destination,
            description: `Co-op settlement cycle #${cycleId} payout — ${tenant?.brandName ?? `tenant ${payout.tenantId}`}`,
            metadata: {
              coopSettlementPayoutId: String(payout.id),
              cycleId: String(cycleId),
              tenantId: String(payout.tenantId),
            },
          },
          // Keyed to the payout row: a crash-after-transfer retry replays the
          // same transfer instead of creating a second one.
          { idempotencyKey: `coop-settlement-payout-${payout.id}` },
        );
        await db
          .update(coopSettlementPayoutsTable)
          .set({
            status: "paid",
            mode: "stripe",
            providerRef: transfer.id,
            destination,
            failureReason: null,
            paidAt: new Date(),
          })
          .where(eq(coopSettlementPayoutsTable.id, payout.id));
        paidCount++;
        await recordPayoutActivitySafe(payout.tenantId, cycleId, payout.amount, "paid");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, payoutId: payout.id, cycleId, tenantId: payout.tenantId },
          "Settlement payout transfer FAILED — visible on the statement, retryable",
        );
        await db
          .update(coopSettlementPayoutsTable)
          .set({ status: "failed", mode: "stripe", destination, failureReason: reason })
          .where(eq(coopSettlementPayoutsTable.id, payout.id));
        failedCount++;
      }
      continue;
    }

    // Simulated mode — Stripe unconfigured or no payout destination attached.
    await db
      .update(coopSettlementPayoutsTable)
      .set({
        status: "simulated",
        mode: "simulated",
        providerRef: null,
        destination: null,
        failureReason: null,
        paidAt: new Date(),
      })
      .where(eq(coopSettlementPayoutsTable.id, payout.id));
    simulatedCount++;
    await recordPayoutActivitySafe(payout.tenantId, cycleId, payout.amount, "simulated");
  }

  const payouts = await db
    .select()
    .from(coopSettlementPayoutsTable)
    .where(eq(coopSettlementPayoutsTable.cycleId, cycleId))
    .orderBy(coopSettlementPayoutsTable.tenantId);

  const result: PayoutRunResult = {
    ok: true,
    cycleId,
    eligibleCount: statements.length,
    paidCount,
    simulatedCount,
    failedCount,
    skippedCount: statements.length - claimed.length,
    payouts,
  };
  logger.info(
    { ...result, payouts: undefined },
    "co-op settlement payout run executed",
  );
  return result;
}

/** Payout rows for a cycle, keyed by statement id. */
export async function payoutsForCycle(
  cycleId: number,
): Promise<Map<number, CoopSettlementPayout>> {
  const rows = await db
    .select()
    .from(coopSettlementPayoutsTable)
    .where(eq(coopSettlementPayoutsTable.cycleId, cycleId));
  return new Map(rows.map((r) => [r.statementId, r]));
}

/** Activity-log entry for a completed payout; never throws. */
async function recordPayoutActivitySafe(
  tenantId: number,
  cycleId: number,
  amount: string,
  kind: "paid" | "simulated",
): Promise<void> {
  try {
    await db.insert(tenantActivitiesTable).values({
      tenantId,
      action: kind === "paid" ? "Settlement payout sent" : "Settlement payout (simulated)",
      details:
        `$${amount} for settlement cycle #${cycleId}` +
        (kind === "paid"
          ? " — funds transferred via Stripe"
          : " — SIMULATED payout, no funds moved"),
    });
  } catch (err) {
    logger.error({ err, tenantId, cycleId }, "settlement payout activity log failed");
  }
}
