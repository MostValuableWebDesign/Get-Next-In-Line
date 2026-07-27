import {
  db,
  tenantsTable,
  sosSettingsTable,
  sosAppointmentsTable,
  sosCustomersTable,
  merchantCoopPartnershipsTable,
  coopSuggestionsTable,
  coopSuggestionDismissalsTable,
} from "@workspace/db";
import { and, count, eq, inArray, ne, or } from "drizzle-orm";
import {
  toCoopProfile,
  taxonomyEntry,
  isBlockedPair,
  isolationPartnersOf,
  distanceBetween,
  withinDiscoveryRange,
  type CoopProfile,
} from "./coopFirewall";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Co-Op Matchmaking & Smart Recommendation engine.
//
// Scores candidate partners for a tenant using only signals already in the
// platform:
//   1. Category complementarity — a curated pairing table of sub-categories
//      whose customer bases naturally overlap (barbershop ↔ boutique, gym ↔
//      coffee shop, …), with a general cross-industry baseline.
//   2. Proximity — distance from stored coordinates, city-level fallback.
//   3. Activity — booking volume and customer counts as foot-traffic proxies.
//
// Exclusions (never suggested): same-sub-category competitors and isolation
// pairs (the existing firewall), businesses with any existing partnership or
// pending invite, and suggestions the merchant dismissed.
// ---------------------------------------------------------------------------

/**
 * Curated complementary sub-category pairings (symmetric). Each entry names
 * two taxonomy slugs whose customers naturally cross-shop, plus the blurb
 * shown as the match reason.
 */
const COMPLEMENTARY_PAIRS: Array<{ a: string; b: string; blurb: string }> = [
  { a: "barbershop", b: "boutique", blurb: "Fresh cuts and fresh fits go together" },
  { a: "barbershop", b: "coffee-shop", blurb: "Clients grab coffee before or after a cut" },
  { a: "barbershop", b: "bar", blurb: "A trim and a drink is a classic pairing" },
  { a: "hair-salon", b: "nail-salon", blurb: "Hair and nail appointments are often booked together" },
  { a: "hair-salon", b: "boutique", blurb: "Style-focused customers shop both" },
  { a: "hair-salon", b: "coffee-shop", blurb: "Clients grab coffee around their appointment" },
  { a: "nail-salon", b: "spa", blurb: "Self-care customers book both services" },
  { a: "nail-salon", b: "boutique", blurb: "Style-focused customers shop both" },
  { a: "spa", b: "yoga-studio", blurb: "Wellness clientele overlaps heavily" },
  { a: "spa", b: "florist", blurb: "Relaxation and gifting audiences overlap" },
  { a: "gym", b: "coffee-shop", blurb: "Post-workout coffee and smoothie runs" },
  { a: "gym", b: "restaurant", blurb: "Fitness customers value healthy dining nearby" },
  { a: "gym", b: "spa", blurb: "Training and recovery complement each other" },
  { a: "yoga-studio", b: "coffee-shop", blurb: "Class-goers linger over coffee after sessions" },
  { a: "martial-arts", b: "restaurant", blurb: "Families dine out around class times" },
  { a: "coffee-shop", b: "bakery", blurb: "Coffee and pastries are natural companions" },
  { a: "coffee-shop", b: "boutique", blurb: "Foot traffic flows between cafes and shops" },
  { a: "restaurant", b: "bar", blurb: "Dinner and drinks crowd overlaps" },
  { a: "restaurant", b: "florist", blurb: "Date-night diners pick up flowers" },
  { a: "pet-grooming", b: "veterinary", blurb: "Pet owners use both services" },
  { a: "pet-grooming", b: "coffee-shop", blurb: "Owners wait out grooming appointments nearby" },
  { a: "auto-detailing", b: "coffee-shop", blurb: "Customers wait out a detail with a coffee" },
  { a: "mechanic-shop", b: "coffee-shop", blurb: "Customers wait out repairs nearby" },
  { a: "mechanic-shop", b: "auto-detailing", blurb: "Repair customers are detail customers" },
  { a: "tattoo-studio", b: "barbershop", blurb: "Shared style-conscious clientele" },
  { a: "tattoo-studio", b: "bar", blurb: "Shared late-night, style-driven crowd" },
  { a: "dental", b: "coffee-shop", blurb: "Nearby regulars keep both busy" },
  { a: "clinic", b: "pharmacy", blurb: "Care visits and pickups pair up" },
  { a: "florist", b: "bakery", blurb: "Gifting and celebration customers overlap" },
  { a: "boutique", b: "florist", blurb: "Gifting and style shoppers overlap" },
];

const PAIR_INDEX = new Map<string, string>();
for (const p of COMPLEMENTARY_PAIRS) {
  PAIR_INDEX.set(`${p.a}\u0000${p.b}`, p.blurb);
  PAIR_INDEX.set(`${p.b}\u0000${p.a}`, p.blurb);
}

/** Curated complementary blurb for two sub-category slugs, or null. */
export function complementaryBlurb(a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  return PAIR_INDEX.get(`${a}\u0000${b}`) ?? null;
}

export interface SuggestionCandidate {
  tenantId: number;
  name: string;
  category: string | null;
  subCategory: string | null;
  city: string | null;
  distanceMiles: number | null;
  score: number;
  reasons: string[];
}

/** Display label for a profile's category (taxonomy label > raw string). */
function categoryLabel(profile: CoopProfile, raw: string | null): string | null {
  if (profile.subCategory != null) {
    const entry = taxonomyEntry(profile.subCategory);
    if (entry) return entry.sub.label;
  }
  return raw?.trim() || null;
}

interface ScoreInput {
  viewer: CoopProfile;
  candidate: CoopProfile;
  bookings: number;
  customers: number;
}

/**
 * Complementary-fit score, 0-100, with human-readable reasons. Pure so tests
 * can exercise the weighting directly.
 */
export function scoreCandidate({ viewer, candidate, bookings, customers }: ScoreInput): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  // 1. Category complementarity (up to 50).
  const blurb = complementaryBlurb(viewer.subCategory, candidate.subCategory);
  if (blurb) {
    score += 50;
    reasons.push(blurb);
  } else if (
    viewer.industry != null &&
    candidate.industry != null &&
    viewer.industry !== candidate.industry
  ) {
    score += 25;
    reasons.push("Different industry — customers don't overlap with competitors");
  } else {
    score += 10;
  }

  // 2. Proximity (up to 30).
  const dist = distanceBetween(viewer, candidate);
  if (dist != null) {
    if (dist <= 1) {
      score += 30;
      reasons.push("Less than a mile away");
    } else if (dist <= 3) {
      score += 22;
      reasons.push(`About ${Math.round(dist)} mi away — easy foot traffic`);
    } else {
      score += 12;
      reasons.push(`${Math.round(dist)} mi away in your co-op range`);
    }
  } else if (viewer.city != null && viewer.city === candidate.city) {
    score += 18;
    reasons.push("Same city");
  }

  // 3. Activity / customer-base signals (up to 20) — log-scaled so a handful
  // of bookings registers but volume saturates.
  const activity = bookings + customers;
  if (activity > 0) {
    const pts = Math.min(20, Math.round(Math.log10(activity + 1) * 10));
    score += pts;
    if (customers > 0 && bookings > 0) {
      reasons.push(`Active customer base (${customers} customers, ${bookings} bookings)`);
    } else if (customers > 0) {
      reasons.push(`Established customer base (${customers} customers)`);
    } else {
      reasons.push(`Active bookings (${bookings})`);
    }
  }

  return { score: Math.min(100, score), reasons };
}

/** Tenant ids with any non-declined partnership/invite involving `tenantId`. */
async function partneredTenantIds(tenantId: number): Promise<Set<number>> {
  const rows = await db
    .select({
      hostTenantId: merchantCoopPartnershipsTable.hostTenantId,
      partnerTenantId: merchantCoopPartnershipsTable.partnerTenantId,
    })
    .from(merchantCoopPartnershipsTable)
    .where(
      and(
        ne(merchantCoopPartnershipsTable.status, "declined"),
        or(
          eq(merchantCoopPartnershipsTable.hostTenantId, tenantId),
          eq(merchantCoopPartnershipsTable.partnerTenantId, tenantId)
        )
      )
    );
  const out = new Set<number>();
  for (const r of rows) out.add(r.hostTenantId === tenantId ? r.partnerTenantId : r.hostTenantId);
  return out;
}

/** Tenant ids this merchant has dismissed from the suggestions feed. */
export async function dismissedTenantIds(tenantId: number): Promise<Set<number>> {
  const rows = await db
    .select({ dismissedTenantId: coopSuggestionDismissalsTable.dismissedTenantId })
    .from(coopSuggestionDismissalsTable)
    .where(eq(coopSuggestionDismissalsTable.tenantId, tenantId));
  return new Set(rows.map((r) => r.dismissedTenantId));
}

/**
 * Compute the ranked suggestion list for a tenant, applying every exclusion:
 * self, inactive tenants, firewall-blocked pairs (same sub-category /
 * isolation), out-of-range businesses, existing/pending partners, and
 * dismissals.
 */
export async function computeSuggestions(tenantId: number): Promise<SuggestionCandidate[]> {
  const [meRow] = await db
    .select()
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));
  const viewer = toCoopProfile(meRow ?? null);

  const [rows, isolated, partnered, dismissed] = await Promise.all([
    db
      .select({
        id: tenantsTable.id,
        name: tenantsTable.brandName,
        businessCategory: sosSettingsTable.businessCategory,
        industryType: sosSettingsTable.industryType,
        coopSubCategory: sosSettingsTable.coopSubCategory,
        coopRadiusMiles: sosSettingsTable.coopRadiusMiles,
        latitude: sosSettingsTable.latitude,
        longitude: sosSettingsTable.longitude,
        city: sosSettingsTable.addressLocality,
      })
      .from(tenantsTable)
      .leftJoin(sosSettingsTable, eq(sosSettingsTable.tenantId, tenantsTable.id))
      .where(and(ne(tenantsTable.id, tenantId), eq(tenantsTable.status, "active"))),
    isolationPartnersOf(tenantId),
    partneredTenantIds(tenantId),
    dismissedTenantIds(tenantId),
  ]);

  const candidateIds = rows
    .map((r) => r.id)
    .filter((id) => !partnered.has(id) && !dismissed.has(id));
  if (candidateIds.length === 0) return [];

  // Activity signals per candidate: booking volume + customer counts.
  const [bookingRows, customerRows] = await Promise.all([
    db
      .select({ tenantId: sosAppointmentsTable.tenantId, n: count() })
      .from(sosAppointmentsTable)
      .where(inArray(sosAppointmentsTable.tenantId, candidateIds))
      .groupBy(sosAppointmentsTable.tenantId),
    db
      .select({ tenantId: sosCustomersTable.tenantId, n: count() })
      .from(sosCustomersTable)
      .where(inArray(sosCustomersTable.tenantId, candidateIds))
      .groupBy(sosCustomersTable.tenantId),
  ]);
  const bookings = new Map(bookingRows.map((r) => [r.tenantId, Number(r.n)]));
  const customers = new Map(customerRows.map((r) => [r.tenantId, Number(r.n)]));

  const out: SuggestionCandidate[] = [];
  for (const r of rows) {
    if (partnered.has(r.id) || dismissed.has(r.id)) continue;
    const candidate = toCoopProfile(
      r.businessCategory != null
        ? {
            coopSubCategory: r.coopSubCategory ?? "",
            businessCategory: r.businessCategory,
            industryType: r.industryType ?? "",
            coopRadiusMiles: r.coopRadiusMiles ?? 4,
            latitude: r.latitude ?? "",
            longitude: r.longitude ?? "",
            addressLocality: r.city ?? "",
          }
        : null
    );
    // Same-industry guardrail + isolation pairs: never suggest a competitor.
    if (isBlockedPair(viewer, candidate, isolated.has(r.id))) continue;
    // Local scope: viewer radius (coords) with city fallback.
    if (!withinDiscoveryRange(viewer, candidate)) continue;

    const { score, reasons } = scoreCandidate({
      viewer,
      candidate,
      bookings: bookings.get(r.id) ?? 0,
      customers: customers.get(r.id) ?? 0,
    });
    const dist = distanceBetween(viewer, candidate);
    out.push({
      tenantId: r.id,
      name: r.name,
      category: categoryLabel(candidate, r.businessCategory?.trim() || r.industryType?.trim() || null),
      subCategory: candidate.subCategory,
      city: r.city?.trim() || null,
      distanceMiles: dist == null ? null : Math.round(dist * 10) / 10,
      score,
      reasons,
    });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out;
}

/** How many suggestions we persist/serve per tenant. */
export const MAX_SUGGESTIONS = 8;

/**
 * Recompute and persist the tenant's suggestion feed (replace-all). Returns
 * the number of stored suggestions.
 */
export async function refreshCoopSuggestions(tenantId: number): Promise<number> {
  const suggestions = (await computeSuggestions(tenantId)).slice(0, MAX_SUGGESTIONS);
  await db.delete(coopSuggestionsTable).where(eq(coopSuggestionsTable.tenantId, tenantId));
  if (suggestions.length > 0) {
    await db
      .insert(coopSuggestionsTable)
      .values(
        suggestions.map((s) => ({
          tenantId,
          suggestedTenantId: s.tenantId,
          score: s.score,
          reasons: s.reasons,
        }))
      )
      .onConflictDoNothing();
  }
  return suggestions.length;
}

/**
 * Like refreshCoopSuggestions but never throws — suggestion bookkeeping must
 * never block onboarding or settings updates.
 */
export async function refreshCoopSuggestionsSafe(tenantId: number): Promise<number> {
  try {
    return await refreshCoopSuggestions(tenantId);
  } catch (err) {
    logger.error({ err, tenantId }, "Co-op suggestion refresh failed; continuing");
    return 0;
  }
}

// ── Auto-generated proposal terms ────────────────────────────────────────────

export interface ProposalDraft {
  perkTitle: string;
  perkDescription: string;
  mutualRewardTerms: string;
}

/** Short customer-facing noun for a sub-category, used in perk copy. */
const PERK_NOUNS: Record<string, string> = {
  barbershop: "cut",
  "hair-salon": "appointment",
  "nail-salon": "manicure",
  spa: "treatment",
  "tattoo-studio": "session",
  "mechanic-shop": "service",
  "auto-detailing": "detail",
  "tire-shop": "service",
  restaurant: "meal",
  "coffee-shop": "drink",
  bakery: "order",
  bar: "round",
  gym: "membership month",
  "yoga-studio": "class",
  "martial-arts": "class",
  clinic: "visit",
  dental: "visit",
  optical: "exam",
  "pet-grooming": "groom",
  veterinary: "visit",
  boutique: "purchase",
  florist: "bouquet",
};

function nounFor(subCategory: string | null): string {
  return (subCategory && PERK_NOUNS[subCategory]) || "visit";
}

/**
 * Sensible default cross-promotion terms derived from both businesses'
 * categories — fully editable before the invite is sent.
 */
export function buildDefaultProposal(opts: {
  myName: string;
  myCategoryNoun: string;
  partnerName: string;
  partnerCategoryNoun: string;
}): ProposalDraft {
  return {
    perkTitle: `10% off your first ${opts.partnerCategoryNoun} at ${opts.partnerName}`,
    perkDescription:
      `Customers of ${opts.myName} show their receipt or pass at ${opts.partnerName} ` +
      `for 10% off, and vice versa. Honor the code at the register.`,
    mutualRewardTerms:
      `${opts.myName} promotes ${opts.partnerName} on its checkout, receipts, and customer passes; ` +
      `${opts.partnerName} does the same in return. Each business honors 10% off one ` +
      `${opts.myCategoryNoun !== opts.partnerCategoryNoun ? `${opts.partnerCategoryNoun} / ${opts.myCategoryNoun}` : opts.myCategoryNoun} ` +
      `for customers referred by the other.`,
  };
}

/** Proposal draft for a viewer→candidate pairing using taxonomy nouns. */
export function proposalForPair(
  myName: string,
  mySubCategory: string | null,
  partnerName: string,
  partnerSubCategory: string | null
): ProposalDraft {
  return buildDefaultProposal({
    myName,
    myCategoryNoun: nounFor(mySubCategory),
    partnerName,
    partnerCategoryNoun: nounFor(partnerSubCategory),
  });
}
