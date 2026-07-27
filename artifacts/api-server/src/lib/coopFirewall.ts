import { db, sosSettingsTable, coopIsolationPairsTable } from "@workspace/db";
import { eq, inArray, or } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Category Firewall & Proximity Exclusion Engine
//
// Two-level taxonomy (Level 1 Industry → Level 2 Sub-Category), a per-tenant
// co-op discovery radius, an automated competitor-isolation conflict check,
// and the single shared exclusion filter every customer-facing perk surface
// applies. The hard rule: two businesses that share the exact same Level 2
// sub-category never see, invite, or cross-promote each other. Same-industry
// but different-sub-niche pairings (Barbershop + Nail Salon) stay allowed.
// ---------------------------------------------------------------------------

export interface CoopSubCategory {
  slug: string;
  label: string;
  /** Lowercased keywords matched against businessCategory/industryType. */
  keywords: string[];
}

export interface CoopIndustry {
  slug: string;
  label: string;
  subCategories: CoopSubCategory[];
}

/** Curated Industry → Sub-Category taxonomy. */
export const COOP_TAXONOMY: CoopIndustry[] = [
  {
    slug: "personal-care",
    label: "Personal Care",
    subCategories: [
      { slug: "barbershop", label: "Barbershop", keywords: ["barber"] },
      { slug: "hair-salon", label: "Hair Salon", keywords: ["hairsalon", "hair salon", "salon", "beautysalon", "hair"] },
      { slug: "nail-salon", label: "Nail Salon", keywords: ["nail"] },
      { slug: "spa", label: "Spa & Massage", keywords: ["spa", "massage", "daySpa".toLowerCase()] },
      { slug: "tattoo-studio", label: "Tattoo Studio", keywords: ["tattoo", "piercing"] },
    ],
  },
  {
    slug: "automotive",
    label: "Automotive",
    subCategories: [
      { slug: "mechanic-shop", label: "Mechanic Shop", keywords: ["mechanic", "autorepair", "auto repair", "auto shop", "automotive"] },
      { slug: "auto-detailing", label: "Auto Detailing", keywords: ["detail", "carwash", "car wash"] },
      { slug: "tire-shop", label: "Tire Shop", keywords: ["tire"] },
    ],
  },
  {
    slug: "food-beverage",
    label: "Food & Beverage",
    subCategories: [
      { slug: "restaurant", label: "Restaurant", keywords: ["restaurant", "diner", "grill", "bistro"] },
      { slug: "coffee-shop", label: "Coffee Shop / Cafe", keywords: ["coffee", "cafe", "espresso"] },
      { slug: "bakery", label: "Bakery", keywords: ["bakery", "baker", "pastry"] },
      { slug: "bar", label: "Bar / Brewery", keywords: ["barorpub", "brewery", "brewpub", "winery"] },
    ],
  },
  {
    slug: "fitness",
    label: "Fitness & Wellness",
    subCategories: [
      { slug: "gym", label: "Gym / Health Club", keywords: ["gym", "healthclub", "health club", "fitness", "crossfit"] },
      { slug: "yoga-studio", label: "Yoga / Pilates Studio", keywords: ["yoga", "pilates"] },
      { slug: "martial-arts", label: "Martial Arts", keywords: ["martial", "karate", "jiu", "boxing"] },
    ],
  },
  {
    slug: "health",
    label: "Health & Medical",
    subCategories: [
      { slug: "clinic", label: "Clinic / Medical Office", keywords: ["clinic", "medical", "physician", "chiro"] },
      { slug: "dental", label: "Dental Practice", keywords: ["dental", "dentist"] },
      { slug: "optical", label: "Optical / Eye Care", keywords: ["optical", "optometr", "eye care"] },
    ],
  },
  {
    slug: "pets",
    label: "Pets",
    subCategories: [
      { slug: "pet-grooming", label: "Pet Grooming", keywords: ["groom", "pet care", "petstore", "pet store"] },
      { slug: "veterinary", label: "Veterinary", keywords: ["veterinar", "vet "] },
    ],
  },
  {
    slug: "retail",
    label: "Retail",
    subCategories: [
      { slug: "boutique", label: "Boutique / Clothing", keywords: ["boutique", "clothing", "apparel", "store"] },
      { slug: "florist", label: "Florist", keywords: ["florist", "flower"] },
    ],
  },
];

const SUBCATEGORY_INDEX = new Map<string, { industry: CoopIndustry; sub: CoopSubCategory }>();
for (const industry of COOP_TAXONOMY) {
  for (const sub of industry.subCategories) {
    SUBCATEGORY_INDEX.set(sub.slug, { industry, sub });
  }
}

export function taxonomyEntry(slug: string) {
  return SUBCATEGORY_INDEX.get(slug) ?? null;
}

/**
 * Map a free-form category string (businessCategory or industryType) to a
 * curated sub-category slug. Returns null when nothing matches.
 */
export function mapCategoryToSubCategory(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (SUBCATEGORY_INDEX.has(s)) return s;
  for (const industry of COOP_TAXONOMY) {
    for (const sub of industry.subCategories) {
      if (sub.keywords.some((k) => s.includes(k))) return sub.slug;
    }
  }
  return null;
}

/** Minimal settings shape the firewall needs. */
export interface CoopProfileSettings {
  coopSubCategory: string;
  businessCategory: string;
  industryType: string;
  coopRadiusMiles: number;
  latitude: string;
  longitude: string;
  addressLocality: string;
}

export interface CoopProfile {
  /** Effective Level 2 sub-category key, or null when unclassifiable. */
  subCategory: string | null;
  /** Whether subCategory is a curated taxonomy slug (vs a raw fallback key). */
  curated: boolean;
  /** Level 1 industry slug (curated only), or null. */
  industry: string | null;
  radiusMiles: number;
  lat: number | null;
  lng: number | null;
  city: string | null;
}

/**
 * Effective sub-category for a settings row: the explicit column when set,
 * else the taxonomy keyword mapping of businessCategory/industryType, else a
 * raw fallback key ("other:<category>") so two businesses with the identical
 * unmapped category string still count as direct competitors (this preserves
 * the pre-taxonomy exact-match guardrail behavior).
 */
export function effectiveSubCategory(
  s: Pick<CoopProfileSettings, "coopSubCategory" | "businessCategory" | "industryType"> | null | undefined
): { subCategory: string | null; curated: boolean } {
  if (!s) return { subCategory: null, curated: false };
  const explicit = s.coopSubCategory.trim().toLowerCase();
  if (explicit) {
    return { subCategory: explicit, curated: SUBCATEGORY_INDEX.has(explicit) };
  }
  // industryType defaults to "salon" for every fresh settings row; an
  // untouched default must NOT classify the business (it would make every
  // unconfigured tenant a competitor of every other). Only an explicitly set
  // businessCategory, or a non-default industryType, derives a sub-category.
  const industry = s.industryType.trim();
  const raw =
    s.businessCategory.trim() ||
    (industry.toLowerCase() === "salon" ? "" : industry);
  if (!raw) return { subCategory: null, curated: false };
  const mapped = mapCategoryToSubCategory(raw);
  if (mapped) return { subCategory: mapped, curated: true };
  return { subCategory: `other:${raw.toLowerCase()}`, curated: false };
}

export function toCoopProfile(s: CoopProfileSettings | null | undefined): CoopProfile {
  const { subCategory, curated } = effectiveSubCategory(s);
  const industry = subCategory && curated ? SUBCATEGORY_INDEX.get(subCategory)!.industry.slug : subCategory ? "other" : null;
  const lat = s ? parseFloat(s.latitude) : NaN;
  const lng = s ? parseFloat(s.longitude) : NaN;
  return {
    subCategory,
    curated,
    industry,
    radiusMiles: clampRadius(s?.coopRadiusMiles ?? DEFAULT_COOP_RADIUS_MILES),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    city: s?.addressLocality.trim() ? s.addressLocality.trim().toLowerCase() : null,
  };
}

export const DEFAULT_COOP_RADIUS_MILES = 4;
export const MIN_COOP_RADIUS_MILES = 1;
export const MAX_COOP_RADIUS_MILES = 15;

export function clampRadius(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_COOP_RADIUS_MILES;
  return Math.min(MAX_COOP_RADIUS_MILES, Math.max(MIN_COOP_RADIUS_MILES, Math.round(n)));
}

/** Great-circle distance in miles. */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.7613; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Two profiles are direct competitors when they share the exact same L2 key. */
export function sameSubCategory(a: CoopProfile, b: CoopProfile): boolean {
  return a.subCategory != null && b.subCategory != null && a.subCategory === b.subCategory;
}

/** Same Level 1 industry (curated industries only — informational). */
export function sameIndustryL1(a: CoopProfile, b: CoopProfile): boolean {
  return (
    a.industry != null &&
    b.industry != null &&
    a.industry !== "other" &&
    a.industry === b.industry
  );
}

/**
 * Distance between two profiles in miles when both have coordinates;
 * null otherwise.
 */
export function distanceBetween(a: CoopProfile, b: CoopProfile): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  return haversineMiles(a.lat, a.lng, b.lat, b.lng);
}

/**
 * Local-discovery scope: within the viewer's radius when both sides have
 * coordinates; graceful city-match fallback when either side lacks them; and
 * inclusive when there isn't enough location data to judge either way.
 */
export function withinDiscoveryRange(viewer: CoopProfile, other: CoopProfile): boolean {
  const dist = distanceBetween(viewer, other);
  if (dist != null) return dist <= viewer.radiusMiles;
  if (viewer.city != null && other.city != null) return viewer.city === other.city;
  return true;
}

/** Load co-op profiles for a set of tenants (missing settings → empty profile). */
export async function loadCoopProfiles(tenantIds: number[]): Promise<Map<number, CoopProfile>> {
  const out = new Map<number, CoopProfile>();
  if (tenantIds.length === 0) return out;
  const rows = await db
    .select({
      tenantId: sosSettingsTable.tenantId,
      coopSubCategory: sosSettingsTable.coopSubCategory,
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
      coopRadiusMiles: sosSettingsTable.coopRadiusMiles,
      latitude: sosSettingsTable.latitude,
      longitude: sosSettingsTable.longitude,
      addressLocality: sosSettingsTable.addressLocality,
    })
    .from(sosSettingsTable)
    .where(inArray(sosSettingsTable.tenantId, tenantIds));
  for (const r of rows) {
    if (r.tenantId != null) out.set(r.tenantId, toCoopProfile(r));
  }
  for (const id of tenantIds) {
    if (!out.has(id)) out.set(id, toCoopProfile(null));
  }
  return out;
}

/** The set of tenant ids the given tenant is isolation-paired with. */
export async function isolationPartnersOf(tenantId: number): Promise<Set<number>> {
  const rows = await db
    .select({
      a: coopIsolationPairsTable.tenantAId,
      b: coopIsolationPairsTable.tenantBId,
    })
    .from(coopIsolationPairsTable)
    .where(
      or(
        eq(coopIsolationPairsTable.tenantAId, tenantId),
        eq(coopIsolationPairsTable.tenantBId, tenantId)
      )
    );
  const out = new Set<number>();
  for (const r of rows) out.add(r.a === tenantId ? r.b : r.a);
  return out;
}

/**
 * The core firewall predicate: `other` must be hidden from `viewer` when they
 * share the exact same Level 2 sub-category, or when a persisted isolation
 * pair exists between them AND their sub-categories still match (pairs stop
 * applying only once the two businesses' sub-categories diverge).
 */
export function isBlockedPair(
  viewer: CoopProfile,
  other: CoopProfile,
  isolated: boolean
): boolean {
  if (sameSubCategory(viewer, other)) return true;
  if (isolated && viewer.subCategory != null && viewer.subCategory === other.subCategory)
    return true;
  return false;
}

/**
 * Automated conflict check, run when a business joins or changes its
 * sub-category / radius / location: find same-sub-category competitors within
 * either party's radius (city match when coordinates are missing) and persist
 * mutual isolation pairs. Idempotent — existing pairs are left untouched.
 */
export async function runCoopConflictCheck(tenantId: number): Promise<number> {
  const [me] = await db
    .select({
      tenantId: sosSettingsTable.tenantId,
      coopSubCategory: sosSettingsTable.coopSubCategory,
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
      coopRadiusMiles: sosSettingsTable.coopRadiusMiles,
      latitude: sosSettingsTable.latitude,
      longitude: sosSettingsTable.longitude,
      addressLocality: sosSettingsTable.addressLocality,
    })
    .from(sosSettingsTable)
    .where(eq(sosSettingsTable.tenantId, tenantId));
  if (!me) return 0;
  const mine = toCoopProfile(me);
  if (mine.subCategory == null) return 0;

  const others = await db
    .select({
      tenantId: sosSettingsTable.tenantId,
      coopSubCategory: sosSettingsTable.coopSubCategory,
      businessCategory: sosSettingsTable.businessCategory,
      industryType: sosSettingsTable.industryType,
      coopRadiusMiles: sosSettingsTable.coopRadiusMiles,
      latitude: sosSettingsTable.latitude,
      longitude: sosSettingsTable.longitude,
      addressLocality: sosSettingsTable.addressLocality,
    })
    .from(sosSettingsTable);

  const values: (typeof coopIsolationPairsTable.$inferInsert)[] = [];
  for (const row of others) {
    if (row.tenantId == null || row.tenantId === tenantId) continue;
    const theirs = toCoopProfile(row);
    if (!sameSubCategory(mine, theirs)) continue;
    // Overlap = within either party's radius when both have coordinates,
    // else a city match when both have cities. Not enough location data →
    // no isolation record (the sub-category rule still blocks globally).
    const dist = distanceBetween(mine, theirs);
    let basis: "radius" | "city" | null = null;
    if (dist != null) {
      if (dist <= mine.radiusMiles || dist <= theirs.radiusMiles) basis = "radius";
    } else if (mine.city != null && theirs.city != null && mine.city === theirs.city) {
      basis = "city";
    }
    if (basis == null) continue;
    values.push({
      tenantAId: Math.min(tenantId, row.tenantId),
      tenantBId: Math.max(tenantId, row.tenantId),
      subCategory: mine.subCategory,
      matchBasis: basis,
    });
  }
  if (values.length === 0) return 0;
  const inserted = await db
    .insert(coopIsolationPairsTable)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: coopIsolationPairsTable.id });
  return inserted.length;
}

/**
 * The single shared consumer-surface exclusion filter. Given the tenant whose
 * customer-facing surface is rendering (checkout confirmation, receipt,
 * pass/wallet, public landing) and a list of partnerships, drop every
 * partnership whose counterpart business is in the viewer tenant's same
 * Level 2 sub-category or isolation list — regardless of how or when the
 * partnership was created (including legacy admin-created overrides).
 */
export async function filterPartnershipsForConsumerSurface<
  T extends { hostTenantId: number; partnerTenantId: number },
>(viewerTenantId: number, partnerships: T[]): Promise<T[]> {
  if (partnerships.length === 0) return partnerships;
  const counterpartIds = [
    ...new Set(
      partnerships.map((p) =>
        p.hostTenantId === viewerTenantId ? p.partnerTenantId : p.hostTenantId
      )
    ),
  ];
  const [profiles, isolated] = await Promise.all([
    loadCoopProfiles([viewerTenantId, ...counterpartIds]),
    isolationPartnersOf(viewerTenantId),
  ]);
  const viewer = profiles.get(viewerTenantId)!;
  return partnerships.filter((p) => {
    const otherId = p.hostTenantId === viewerTenantId ? p.partnerTenantId : p.hostTenantId;
    const other = profiles.get(otherId)!;
    return !isBlockedPair(viewer, other, isolated.has(otherId));
  });
}
