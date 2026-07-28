import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  perkPassesTable,
  coopPerkRedemptionsTable,
  coopAttributionEventsTable,
} from "@workspace/db";
import { findWalletPass, isWalletPassToken } from "./perkPasses";
import { recordPassportStampSafe } from "./passport";
import { recordPerkRedemptionComplianceSafe } from "./coopCompliance";
import { applyRedemptionSplitSafe } from "./coopSponsorship";
import { requestCoopFeedbackSafe } from "./coopFeedback";
import type { CoopDirection } from "./coopTracking";

/**
 * Shared wallet perk-pass redemption used by every machine-driven write path
 * (POS webhook `perk_redeemed` events and the /v1/gateway developer API).
 * Mirrors the native /coop/redemptions integrity rules exactly:
 *   - only a business that is a party to the partnership may redeem;
 *   - the conditional update on redeemed_at IS NULL is the single-use lock;
 *   - each counted redemption produces exactly one attribution event
 *     (unique redemption_id makes replays no-ops).
 * Any new redemption write path MUST go through this function.
 */
export interface WalletRedemptionResult {
  /** processed | ignored | error */
  status: "processed" | "ignored" | "error";
  detail: string;
}

export async function redeemWalletPassAsTenant(
  tenantId: number | null,
  rawToken: string | null | undefined,
  /** Optional extra contact info (e.g. from a POS event) to enrich the passport identity. */
  contact?: { email?: string | null; name?: string | null }
): Promise<WalletRedemptionResult> {
  if (tenantId == null) {
    return { status: "error", detail: "Perk redemption requires a tenant-scoped connection" };
  }
  const token = rawToken?.trim() ?? "";
  if (!token || !isWalletPassToken(token)) {
    return { status: "error", detail: "Missing or unrecognized perk pass token" };
  }
  const row = await findWalletPass(token);
  if (!row) return { status: "error", detail: "Unknown perk pass token" };
  if (row.pass.redeemedAt != null) {
    return { status: "ignored", detail: "Pass was already redeemed" };
  }
  if (row.pass.expiresAt <= new Date()) {
    return { status: "error", detail: "Pass has expired" };
  }
  // Participant enforcement: a leaked token presented through some other
  // tenant's connection is rejected without writes.
  if (tenantId !== row.partnership.hostTenantId && tenantId !== row.partnership.partnerTenantId) {
    return {
      status: "error",
      detail: "Only a business in this partnership can redeem this perk pass",
    };
  }
  // Conditional update is the single-use lock: exactly one redeemer flips
  // redeemed_at.
  const [redeemed] = await db
    .update(perkPassesTable)
    .set({ redeemedAt: new Date(), redeemedByTenantId: tenantId })
    .where(and(eq(perkPassesTable.token, token), isNull(perkPassesTable.redeemedAt)))
    .returning();
  if (!redeemed) {
    return { status: "ignored", detail: "Pass was already redeemed" };
  }
  // Mirror into the shared redemption ledger for partner-side reporting.
  const [redemption] = await db
    .insert(coopPerkRedemptionsTable)
    .values({
      partnershipId: row.partnership.id,
      passCode: token,
      redeemedByTenantId: tenantId,
    })
    .onConflictDoNothing()
    .returning();
  // Attribution: the redeeming tenant is the receiver; the other side of the
  // partnership sent the customer.
  if (redemption) {
    const p = row.partnership;
    const direction: CoopDirection =
      tenantId === p.hostTenantId ? "partner_to_host" : "host_to_partner";
    await db
      .insert(coopAttributionEventsTable)
      .values({
        redemptionId: redemption.id,
        partnershipId: p.id,
        direction,
        sendingTenantId: direction === "host_to_partner" ? p.hostTenantId : p.partnerTenantId,
        receivingTenantId: tenantId,
      })
      .onConflictDoNothing();
    // Neighborhood Passport: stamp the redeeming business on the wallet
    // owner's passport (best-effort; never blocks the redemption).
    await recordPassportStampSafe({
      redeemedByTenantId: tenantId,
      redemptionId: redemption.id,
      person: {
        phone: row.pass.customerPhone,
        email: contact?.email ?? null,
        name: row.pass.customerName ?? contact?.name ?? null,
      },
    });
    // Tax compliance ledger: log the redemption when the perk has monetary
    // terms. Observes only — never blocks or alters redemption processing.
    await recordPerkRedemptionComplianceSafe({
      redemptionId: redemption.id,
      redeemedByTenantId: tenantId,
      otherTenantId: tenantId === p.hostTenantId ? p.partnerTenantId : p.hostTenantId,
      perkValueAmount: p.perkValueAmount,
      perkTitle: p.perkTitle,
      redeemedAt: redemption.redeemedAt ?? new Date(),
    });
    // Sponsorship Hub: revenue-share split accounting runs on every counted
    // redemption regardless of channel (native, POS webhook, gateway API) so
    // wallet ledgers stay in parity across redemption paths. Safe/no-op when
    // the partnership carries no revenue-share terms.
    await applyRedemptionSplitSafe(row.partnership, redemption.id, tenantId);
    // Post-redemption satisfaction follow-up: ask the wallet owner for a
    // quick rating via SMS. Best-effort; never blocks the redemption.
    await requestCoopFeedbackSafe({
      partnershipId: p.id,
      redemptionId: redemption.id,
      redeemedByTenantId: tenantId,
      customerPhone: row.pass.customerPhone,
      customerName: row.pass.customerName ?? contact?.name ?? null,
      perkTitle: p.perkTitle,
      businessName: tenantId === p.hostTenantId ? row.hostTenantName : row.partnerTenantName,
    });
  }
  return { status: "processed", detail: `Perk pass ${token} redeemed` };
}
