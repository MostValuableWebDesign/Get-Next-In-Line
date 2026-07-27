/**
 * Plaza (commercial complex) matching for the co-op network.
 *
 * Two businesses are "in the same plaza" when their existing address
 * settings point at the same address block:
 *   1. Primary rule — same normalized postal code AND same normalized street
 *      name AND same hundred-block of the street number (e.g. "120 Main St"
 *      and "148 MAIN STREET, Suite B" share the 100-block of "main st").
 *   2. Fallback — when either side lacks a usable street address but both
 *      have lat/long, coordinates within ~150 m count as the same complex.
 *
 * Missing data never matches: a business with no address on file is never
 * considered to share a plaza with anyone.
 */

export interface PlazaAddress {
  streetAddress: string | null | undefined;
  postalCode: string | null | undefined;
  latitude: string | null | undefined;
  longitude: string | null | undefined;
}

/** Max coordinate distance (meters) treated as the same commercial complex. */
export const PLAZA_PROXIMITY_METERS = 150;

// Common street-suffix aliases collapsed to one token so "St" == "Street".
const SUFFIX_ALIASES: Record<string, string> = {
  street: "st",
  st: "st",
  avenue: "ave",
  ave: "ave",
  av: "ave",
  boulevard: "blvd",
  blvd: "blvd",
  road: "rd",
  rd: "rd",
  drive: "dr",
  dr: "dr",
  lane: "ln",
  ln: "ln",
  court: "ct",
  ct: "ct",
  place: "pl",
  pl: "pl",
  parkway: "pkwy",
  pkwy: "pkwy",
  highway: "hwy",
  hwy: "hwy",
  way: "way",
  circle: "cir",
  cir: "cir",
  terrace: "ter",
  ter: "ter",
  square: "sq",
  sq: "sq",
};

// Unit designators (and everything after them) are not part of the block.
const UNIT_TOKENS = new Set([
  "suite",
  "ste",
  "unit",
  "apt",
  "apartment",
  "#",
  "no",
  "floor",
  "fl",
  "bldg",
  "building",
  "room",
  "rm",
]);

/** Normalized postal code: uppercase, alphanumeric only. Null when empty. */
export function normalizePostalCode(raw: string | null | undefined): string | null {
  const code = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code ? code : null;
}

/**
 * Address block key from a free-form street address: hundred-block of the
 * leading street number + normalized street name, e.g. "100|main st".
 * Null when there is no usable leading street number.
 */
export function normalizeAddressBlock(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "")
    .toLowerCase()
    // Keep '#' so unit markers like "#4" can be cut off below.
    .replace(/[^a-z0-9#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(" ");
  // No leading street number — can't derive an address block.
  if (!/^\d/.test(tokens[0])) return null;
  const streetNumber = Number.parseInt(tokens[0], 10);
  if (!Number.isFinite(streetNumber)) return null;
  const nameTokens: string[] = [];
  for (const t of tokens.slice(1)) {
    if (UNIT_TOKENS.has(t) || t.startsWith("#")) break;
    nameTokens.push(SUFFIX_ALIASES[t] ?? t);
  }
  if (nameTokens.length === 0) return null;
  const block = Math.floor(streetNumber / 100) * 100;
  return `${block}|${nameTokens.join(" ")}`;
}

function parseCoord(raw: string | null | undefined): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Haversine distance in meters. */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Same-plaza detection from existing address settings. Missing data on
 * either side never matches.
 */
export function samePlaza(a: PlazaAddress, b: PlazaAddress): boolean {
  const postalA = normalizePostalCode(a.postalCode);
  const postalB = normalizePostalCode(b.postalCode);
  const blockA = normalizeAddressBlock(a.streetAddress);
  const blockB = normalizeAddressBlock(b.streetAddress);

  if (postalA && postalB && blockA && blockB) {
    return postalA === postalB && blockA === blockB;
  }

  // Fallback: lat/long proximity when the street/postal rule can't apply.
  const latA = parseCoord(a.latitude);
  const lonA = parseCoord(a.longitude);
  const latB = parseCoord(b.latitude);
  const lonB = parseCoord(b.longitude);
  if (latA == null || lonA == null || latB == null || lonB == null) return false;
  return distanceMeters(latA, lonA, latB, lonB) <= PLAZA_PROXIMITY_METERS;
}
