import { randomBytes } from "crypto";
import { db, merchantCoopPartnershipsTable } from "@workspace/db";
import { eq, isNull, or } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Direction-aware cross-promotion tracking codes.
 *
 * Each partnership carries two unguessable codes — one per traffic
 * direction. hostTrackingCode travels with the HOST's customers (redeemed at
 * the partner → "host_to_partner"); partnerTrackingCode is the mirror. The
 * codes are what the customer-facing pass QR encodes, so every redemption
 * can be attributed to the specific sending business.
 */

export type CoopDirection = "host_to_partner" | "partner_to_host";

/** 20 chars from a 31-char unambiguous alphabet ≈ 99 bits — unguessable. */
export function generateTrackingCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `CPT-${out}`;
}

/**
 * Idempotent startup backfill: give every pre-existing partnership its two
 * direction tracking codes. New rows get codes at insert time, so this only
 * ever touches legacy rows (tracking columns NULL).
 */
export async function backfillCoopTrackingCodes(): Promise<void> {
  const rows = await db
    .select({ id: merchantCoopPartnershipsTable.id })
    .from(merchantCoopPartnershipsTable)
    .where(
      or(
        isNull(merchantCoopPartnershipsTable.hostTrackingCode),
        isNull(merchantCoopPartnershipsTable.partnerTrackingCode)
      )
    );
  for (const row of rows) {
    // Per-row update with fresh codes; a (vanishingly rare) unique collision
    // just fails this row and is retried on the next boot.
    try {
      await db
        .update(merchantCoopPartnershipsTable)
        .set({
          hostTrackingCode: generateTrackingCode(),
          partnerTrackingCode: generateTrackingCode(),
          updatedAt: new Date(),
        })
        .where(eq(merchantCoopPartnershipsTable.id, row.id));
    } catch (err) {
      logger.error({ err, partnershipId: row.id }, "Coop tracking code backfill failed for row");
    }
  }
  if (rows.length > 0) {
    logger.info({ count: rows.length }, "Backfilled co-op tracking codes");
  }
}
