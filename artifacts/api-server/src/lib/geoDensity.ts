import { db, sosSettingsTable } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Automatic co-op radius from local commercial density.
//
// Pipeline: street address → geocode (Nominatim, free/no-key) → count
// commercial POIs within a ~1-square-mile circle (Overpass API) → classify
// Dense Urban / Suburban / Rural → assign a default co-op radius.
//
// Everything here is best-effort: onboarding and settings saves must never
// block or fail on the external services. On any failure the tenant keeps
// (or falls back to) the documented Suburban default, and detection re-runs
// the next time the address changes.
// ---------------------------------------------------------------------------

export type DensityClassification = "dense_urban" | "suburban" | "rural";

/** A circle with the area of 1 square mile has radius ≈ 0.564 mi ≈ 908 m. */
export const POI_SEARCH_RADIUS_METERS = 908;

// Classification thresholds: commercial POIs within the ~1 sq mi circle.
export const DENSE_URBAN_MIN_POIS = 100;
export const SUBURBAN_MIN_POIS = 20;

// Default co-op radius (miles) per classification — midpoints of the spec'd
// ranges: Dense Urban 1–2, Suburban 3–5, Rural 10–15.
export const RADIUS_BY_CLASSIFICATION: Record<DensityClassification, number> = {
  dense_urban: 1.5,
  suburban: 4,
  rural: 12,
};

/** Documented fallback when the address is missing or lookups fail. */
export const FALLBACK_CLASSIFICATION: DensityClassification = "suburban";
export const FALLBACK_RADIUS_MILES = RADIUS_BY_CLASSIFICATION[FALLBACK_CLASSIFICATION];

/** Classify a location by how many commercial POIs surround it. */
export function classifyDensity(poiCount: number): DensityClassification {
  if (poiCount >= DENSE_URBAN_MIN_POIS) return "dense_urban";
  if (poiCount >= SUBURBAN_MIN_POIS) return "suburban";
  return "rural";
}

export function radiusForClassification(c: DensityClassification): number {
  return RADIUS_BY_CLASSIFICATION[c];
}

/** Effective co-op radius: merchant override wins, else the auto default. */
export function effectiveCoopRadiusMiles(s: {
  coopRadiusOverrideMiles: string | null;
  coopRadiusAutoMiles: string | null;
}): number {
  const override = s.coopRadiusOverrideMiles != null ? parseFloat(s.coopRadiusOverrideMiles) : NaN;
  if (Number.isFinite(override) && override > 0) return override;
  const auto = s.coopRadiusAutoMiles != null ? parseFloat(s.coopRadiusAutoMiles) : NaN;
  return Number.isFinite(auto) && auto > 0 ? auto : FALLBACK_RADIUS_MILES;
}

/** Geodesic (haversine) distance in miles between two coordinates. */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 3958.7613; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export type Fetcher = typeof fetch;

const EXTERNAL_TIMEOUT_MS = 8000;
const USER_AGENT = "GetNextInLine-CoopRadius/1.0 (co-op radius auto-detection)";

async function fetchJson(
  fetcher: Fetcher,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  try {
    const res = await fetcher(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Geocode a street address via OSM Nominatim. Returns null when not found. */
export async function geocodeAddress(
  address: string,
  fetcher: Fetcher = fetch,
): Promise<{ lat: number; lng: number } | null> {
  const q = address.trim();
  if (!q) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const data = (await fetchJson(fetcher, url)) as Array<{ lat: string; lon: string }>;
  if (!Array.isArray(data) || data.length === 0) return null;
  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Count storefront/commercial POIs within ~1 square mile of the coordinates
 * via the OSM Overpass API (shops, food/drink amenities, offices, tourism
 * storefronts — things a customer walks into).
 */
export async function countCommercialPois(
  lat: number,
  lng: number,
  fetcher: Fetcher = fetch,
): Promise<number> {
  const around = `(around:${POI_SEARCH_RADIUS_METERS},${lat},${lng})`;
  const query = `
[out:json][timeout:8];
(
  nwr[shop]${around};
  nwr[amenity~"^(restaurant|cafe|bar|pub|fast_food|bank|pharmacy|clinic|dentist|veterinary|cinema|theatre|gym|fitness_centre|marketplace)$"]${around};
  nwr[office]${around};
  nwr[tourism~"^(hotel|motel|guest_house|gallery|museum)$"]${around};
);
out count;`;
  const data = (await fetchJson(fetcher, "https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  })) as { elements?: Array<{ tags?: { total?: string } }> };
  const total = data.elements?.[0]?.tags?.total;
  const n = total != null ? parseInt(total, 10) : NaN;
  if (!Number.isFinite(n)) throw new Error("Overpass count response malformed");
  return n;
}

export interface DetectionResult {
  lat: number | null;
  lng: number | null;
  classification: DensityClassification;
  radiusMiles: number;
  /** True when external lookups succeeded (vs. the Suburban fallback). */
  detected: boolean;
}

// Light cache: identical addresses (e.g. repeated saves) skip re-hitting the
// external services for a day. Also acts as rate-limit courtesy.
const detectionCache = new Map<string, { at: number; result: DetectionResult }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Full detection pipeline for a formatted address. Never throws — falls back
 * to the Suburban default on any failure.
 */
export async function detectDensity(
  address: string,
  fetcher: Fetcher = fetch,
  knownCoords?: { lat: number; lng: number } | null,
): Promise<DetectionResult> {
  const cacheKey = `${address.trim().toLowerCase()}|${knownCoords?.lat ?? ""},${knownCoords?.lng ?? ""}`;
  const cached = detectionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

  let result: DetectionResult;
  try {
    const coords = knownCoords ?? (await geocodeAddress(address, fetcher));
    if (!coords) {
      result = {
        lat: null,
        lng: null,
        classification: FALLBACK_CLASSIFICATION,
        radiusMiles: FALLBACK_RADIUS_MILES,
        detected: false,
      };
    } else {
      const poiCount = await countCommercialPois(coords.lat, coords.lng, fetcher);
      const classification = classifyDensity(poiCount);
      result = {
        lat: coords.lat,
        lng: coords.lng,
        classification,
        radiusMiles: radiusForClassification(classification),
        detected: true,
      };
    }
  } catch (err) {
    logger.warn({ err, address }, "co-op density detection failed; using Suburban fallback");
    result = {
      lat: knownCoords?.lat ?? null,
      lng: knownCoords?.lng ?? null,
      classification: FALLBACK_CLASSIFICATION,
      radiusMiles: FALLBACK_RADIUS_MILES,
      detected: false,
    };
  }
  detectionCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** Format the stored address columns into a single geocodable string. */
export function formatAddress(s: {
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
}): string {
  return [s.streetAddress, s.addressLocality, s.addressRegion, s.postalCode]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Background detection for a settings row: geocode + classify, then persist
 * coordinates (only when not manually entered), classification, and the auto
 * radius. Never touches the merchant's radius override. Safe to fire-and-
 * forget — all failures are logged, never thrown.
 */
export async function runDensityDetectionForSettings(
  settingsId: number,
  fetcher: Fetcher = fetch,
): Promise<void> {
  try {
    const [s] = await db
      .select()
      .from(sosSettingsTable)
      .where(eq(sosSettingsTable.id, settingsId));
    if (!s) return;

    const address = formatAddress(s);
    const manualLat = parseFloat(s.latitude);
    const manualLng = parseFloat(s.longitude);
    const hasManualCoords =
      s.coordinatesSource === "manual" &&
      Number.isFinite(manualLat) &&
      Number.isFinite(manualLng);

    if (!address && !hasManualCoords) {
      // Nothing to detect from — keep/restore the documented Suburban default.
      await db
        .update(sosSettingsTable)
        .set({
          densityClassification: FALLBACK_CLASSIFICATION,
          coopRadiusAutoMiles: FALLBACK_RADIUS_MILES.toFixed(1),
        })
        .where(eq(sosSettingsTable.id, settingsId));
      return;
    }

    const result = await detectDensity(
      address,
      fetcher,
      hasManualCoords ? { lat: manualLat, lng: manualLng } : null,
    );

    const updates: Partial<typeof sosSettingsTable.$inferInsert> = {
      densityClassification: result.classification,
      coopRadiusAutoMiles: result.radiusMiles.toFixed(1),
    };
    if (!hasManualCoords && result.lat != null && result.lng != null) {
      updates.latitude = result.lat.toFixed(6);
      updates.longitude = result.lng.toFixed(6);
      updates.coordinatesSource = "auto";
    }
    // Guard: never flip coordinates that turned manual mid-flight.
    await db
      .update(sosSettingsTable)
      .set(updates)
      .where(
        hasManualCoords || !(result.lat != null && result.lng != null)
          ? eq(sosSettingsTable.id, settingsId)
          : and(
              eq(sosSettingsTable.id, settingsId),
              ne(sosSettingsTable.coordinatesSource, "manual"),
            ),
      );
  } catch (err) {
    logger.warn({ err, settingsId }, "co-op density detection persist failed");
  }
}

/**
 * Fire-and-forget detection trigger — used from onboarding and settings PATCH
 * so the request path never waits on Nominatim/Overpass. Disabled under test
 * (unit tests exercise the pipeline directly with an injected fetcher).
 */
export function scheduleDensityDetection(settingsId: number): void {
  if (process.env.NODE_ENV === "test" || process.env.COOP_GEO_DISABLED === "1") return;
  setImmediate(() => {
    void runDensityDetectionForSettings(settingsId);
  });
}

/** Test-only: clear the in-memory detection cache. */
export function clearDetectionCache(): void {
  detectionCache.clear();
}
