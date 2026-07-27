import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyDensity,
  radiusForClassification,
  effectiveCoopRadiusMiles,
  haversineMiles,
  detectDensity,
  clearDetectionCache,
  DENSE_URBAN_MIN_POIS,
  SUBURBAN_MIN_POIS,
  FALLBACK_RADIUS_MILES,
  type Fetcher,
} from "../geoDensity";

// ---------------------------------------------------------------------------
// Pure-function coverage for the automatic co-op radius pipeline: density
// classification thresholds, radius assignment, effective-radius resolution,
// haversine distance, and the geocode+POI pipeline with an injected fetcher
// (no real network calls).
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("classifyDensity thresholds", () => {
  it("classifies at and around the documented boundaries", () => {
    expect(classifyDensity(0)).toBe("rural");
    expect(classifyDensity(SUBURBAN_MIN_POIS - 1)).toBe("rural");
    expect(classifyDensity(SUBURBAN_MIN_POIS)).toBe("suburban");
    expect(classifyDensity(DENSE_URBAN_MIN_POIS - 1)).toBe("suburban");
    expect(classifyDensity(DENSE_URBAN_MIN_POIS)).toBe("dense_urban");
    expect(classifyDensity(10_000)).toBe("dense_urban");
  });

  it("maps classifications to radii inside the spec'd ranges", () => {
    const dense = radiusForClassification("dense_urban");
    const suburban = radiusForClassification("suburban");
    const rural = radiusForClassification("rural");
    expect(dense).toBeGreaterThanOrEqual(1);
    expect(dense).toBeLessThanOrEqual(2);
    expect(suburban).toBeGreaterThanOrEqual(3);
    expect(suburban).toBeLessThanOrEqual(5);
    expect(rural).toBeGreaterThanOrEqual(10);
    expect(rural).toBeLessThanOrEqual(15);
  });
});

describe("effectiveCoopRadiusMiles", () => {
  it("prefers the merchant override", () => {
    expect(
      effectiveCoopRadiusMiles({ coopRadiusOverrideMiles: "7.5", coopRadiusAutoMiles: "4.0" }),
    ).toBe(7.5);
  });
  it("falls back to the auto radius when no override", () => {
    expect(
      effectiveCoopRadiusMiles({ coopRadiusOverrideMiles: null, coopRadiusAutoMiles: "12.0" }),
    ).toBe(12);
  });
  it("falls back to the Suburban default when both are unusable", () => {
    expect(
      effectiveCoopRadiusMiles({ coopRadiusOverrideMiles: null, coopRadiusAutoMiles: null }),
    ).toBe(FALLBACK_RADIUS_MILES);
  });
});

describe("haversineMiles", () => {
  it("is ~0 for identical points and accurate for a known pair", () => {
    expect(haversineMiles(40.7128, -74.006, 40.7128, -74.006)).toBeCloseTo(0, 6);
    // NYC → Philadelphia ≈ 80.5 miles
    const d = haversineMiles(40.7128, -74.006, 39.9526, -75.1652);
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(85);
  });
});

describe("detectDensity pipeline (injected fetcher)", () => {
  beforeEach(() => clearDetectionCache());

  const overpassCount = (total: number) =>
    jsonResponse({ elements: [{ tags: { total: String(total) } }] });

  it("geocodes then classifies from the POI count", async () => {
    const fetcher: Fetcher = async (url) => {
      const u = String(url);
      if (u.includes("nominatim")) return jsonResponse([{ lat: "40.7", lon: "-74.0" }]);
      return overpassCount(250);
    };
    const result = await detectDensity("350 5th Ave, New York, NY", fetcher);
    expect(result.detected).toBe(true);
    expect(result.lat).toBeCloseTo(40.7);
    expect(result.lng).toBeCloseTo(-74.0);
    expect(result.classification).toBe("dense_urban");
    expect(result.radiusMiles).toBe(radiusForClassification("dense_urban"));
  });

  it("uses known coordinates without geocoding when provided", async () => {
    let geocodeCalled = false;
    const fetcher: Fetcher = async (url) => {
      const u = String(url);
      if (u.includes("nominatim")) {
        geocodeCalled = true;
        return jsonResponse([]);
      }
      return overpassCount(3);
    };
    const result = await detectDensity("somewhere rural", fetcher, { lat: 44.1, lng: -72.5 });
    expect(geocodeCalled).toBe(false);
    expect(result.classification).toBe("rural");
    expect(result.radiusMiles).toBe(radiusForClassification("rural"));
  });

  it("falls back to Suburban when geocoding finds nothing", async () => {
    const fetcher: Fetcher = async () => jsonResponse([]);
    const result = await detectDensity("nonsense address zzz", fetcher);
    expect(result.detected).toBe(false);
    expect(result.classification).toBe("suburban");
    expect(result.radiusMiles).toBe(FALLBACK_RADIUS_MILES);
    expect(result.lat).toBeNull();
  });

  it("falls back to Suburban when the external service errors", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("network down");
    };
    const result = await detectDensity("123 Main St", fetcher);
    expect(result.detected).toBe(false);
    expect(result.classification).toBe("suburban");
    expect(result.radiusMiles).toBe(FALLBACK_RADIUS_MILES);
  });

  it("caches results per address (no repeat external calls)", async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      calls++;
      const u = String(url);
      if (u.includes("nominatim")) return jsonResponse([{ lat: "40.7", lon: "-74.0" }]);
      return overpassCount(50);
    };
    const first = await detectDensity("42 Cached Ln, Springfield", fetcher);
    const callsAfterFirst = calls;
    const second = await detectDensity("42 Cached Ln, Springfield", fetcher);
    expect(second).toEqual(first);
    expect(calls).toBe(callsAfterFirst);
    expect(first.classification).toBe("suburban");
  });
});
