import { and, gt, isNull, lte, or, type SQL } from "drizzle-orm";
import { merchantCoopPartnershipsTable } from "@workspace/db";

/**
 * Platform liability disclaimer that must accompany every displayed co-op
 * perk, on every surface (hub, checkout, receipt, customer pass, public
 * landing perks). Single source of truth — the UI and public HTML render
 * whatever the API sends, never a copy-pasted string.
 */
export const COOP_PERK_DISCLAIMER =
  "Each participating business operates independently and is solely responsible and liable for its own goods, services, and customer experiences. The platform facilitates perk display only and is not a party to any perk offer.";

/**
 * SQL condition: the perk's optional date window is currently open.
 * NULL bounds are treated as always-active on that side.
 */
export function perkWindowOpen(now: Date = new Date()): SQL {
  return and(
    or(
      isNull(merchantCoopPartnershipsTable.perkStartsAt),
      lte(merchantCoopPartnershipsTable.perkStartsAt, now)
    ),
    or(
      isNull(merchantCoopPartnershipsTable.perkEndsAt),
      gt(merchantCoopPartnershipsTable.perkEndsAt, now)
    )
  )!;
}

export type PerkWindowState = "scheduled" | "open" | "expired";

/** Where the perk sits relative to its optional date window. */
export function perkWindowState(
  p: { perkStartsAt: Date | null; perkEndsAt: Date | null },
  now: Date = new Date()
): PerkWindowState {
  if (p.perkEndsAt != null && p.perkEndsAt <= now) return "expired";
  if (p.perkStartsAt != null && p.perkStartsAt > now) return "scheduled";
  return "open";
}

/**
 * Validate an optional start/end pair. Returns an error message when the end
 * is not strictly after the start, else null. Accepts ISO strings.
 */
export function validatePerkWindow(
  startsAt: string | Date | null | undefined,
  endsAt: string | Date | null | undefined
): string | null {
  if (!startsAt || !endsAt) return null;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Invalid perk date";
  }
  if (end <= start) return "The perk end date must be after the start date";
  return null;
}
