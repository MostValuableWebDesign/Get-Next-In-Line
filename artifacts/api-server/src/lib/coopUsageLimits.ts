import {
  db,
  coopPerkRedemptionsTable,
  perkPassesTable,
  type MerchantCoopPartnership,
} from "@workspace/db";
import { and, count, eq, sql } from "drizzle-orm";

/** Drizzle transaction or the root db handle. */
type Dbish = Pick<typeof db, "select" | "insert" | "update" | "execute">;

// ── Perk usage-limit enforcement ─────────────────────────────────────────────
// Limits are enforced against RECORDED redemption rows (coop_perk_redemptions),
// never honor-system. Kinds:
//   unlimited    — no limit (default)
//   per_customer — one counted redemption per customer identity per
//                  partnership (pass instance for classic "C<id>" codes,
//                  wallet phone for wallet passes)
//   total_cap    — at most usageCap counted redemptions overall

/** Customer-safe message when a capped perk is exhausted. */
export const PERK_LIMIT_REACHED_MESSAGE =
  "This perk has reached its redemption limit";

/** Customer-safe message when a one-per-customer perk was already used. */
export const PERK_ALREADY_USED_MESSAGE =
  "This perk has already been redeemed by this customer";

export type UsageLimitPartnership = Pick<
  MerchantCoopPartnership,
  "id" | "usageLimitKind" | "usageCap"
>;

/**
 * Returns the customer-safe rejection reason when redeeming this partnership's
 * perk would exceed its usage limit, else null.
 *
 * `identity` carries whatever customer identity the caller has:
 *  - `passCode`: the classic pass instance (e.g. "C123") — per-customer
 *    identity for classic redemptions.
 *  - `customerPhone`: the wallet pass owner's phone — per-customer identity
 *    across successive wallet passes for the same partnership.
 * When kind=per_customer and no identity is available (e.g. a bare code
 * validation), the per-customer check is skipped — it is re-checked with full
 * identity at redemption time.
 */
export async function usageLimitViolation(
  p: UsageLimitPartnership,
  identity: { passCode?: string | null; customerPhone?: string | null } = {},
  dbx: Dbish = db
): Promise<string | null> {
  if (p.usageLimitKind === "total_cap" && p.usageCap != null) {
    const [row] = await dbx
      .select({ n: count() })
      .from(coopPerkRedemptionsTable)
      .where(eq(coopPerkRedemptionsTable.partnershipId, p.id));
    if ((row?.n ?? 0) >= p.usageCap) return PERK_LIMIT_REACHED_MESSAGE;
    return null;
  }
  if (p.usageLimitKind === "per_customer") {
    if (identity.passCode) {
      const [existing] = await dbx
        .select({ id: coopPerkRedemptionsTable.id })
        .from(coopPerkRedemptionsTable)
        .where(
          and(
            eq(coopPerkRedemptionsTable.partnershipId, p.id),
            eq(coopPerkRedemptionsTable.passCode, identity.passCode)
          )
        )
        .limit(1);
      if (existing) return PERK_ALREADY_USED_MESSAGE;
    }
    if (identity.customerPhone) {
      // Any prior redemption under this partnership through a wallet pass
      // held by the same phone (wallet identities are phone-keyed).
      const [existing] = await dbx
        .select({ id: coopPerkRedemptionsTable.id })
        .from(coopPerkRedemptionsTable)
        .innerJoin(
          perkPassesTable,
          eq(perkPassesTable.token, coopPerkRedemptionsTable.passCode)
        )
        .where(
          and(
            eq(coopPerkRedemptionsTable.partnershipId, p.id),
            eq(perkPassesTable.customerPhone, identity.customerPhone)
          )
        )
        .limit(1);
      if (existing) return PERK_ALREADY_USED_MESSAGE;
    }
    return null;
  }
  return null;
}

/**
 * Serialize limit-counted redemptions per partnership: takes a row lock on
 * the partnership inside the caller's transaction, so a subsequent
 * `usageLimitViolation(..., tx)` check and the redemption insert are atomic
 * with respect to concurrent redemptions — a cap can never be oversubscribed
 * by parallel requests. MUST be called (and the redemption row written)
 * inside the same transaction.
 */
export async function lockPartnershipForRedemption(
  tx: Dbish,
  partnershipId: number
): Promise<void> {
  await tx.execute(
    sql`SELECT id FROM merchant_coop_partnerships WHERE id = ${partnershipId} FOR UPDATE`
  );
}

/**
 * Validate a requested limit change. Returns an error message or null.
 * Normalizes: cap is required for total_cap and cleared for other kinds.
 */
export function validateUsageLimit(
  kind: string | undefined,
  cap: number | null | undefined
): { error: string } | { error: null; usageLimitKind: string; usageCap: number | null } {
  const k = kind ?? "unlimited";
  if (!["unlimited", "per_customer", "total_cap"].includes(k)) {
    return { error: "Invalid usage limit" };
  }
  if (k === "total_cap") {
    if (cap == null || !Number.isInteger(cap) || cap < 1) {
      return { error: "A total redemption cap of at least 1 is required" };
    }
    return { error: null, usageLimitKind: k, usageCap: cap };
  }
  return { error: null, usageLimitKind: k, usageCap: null };
}
