import { describe, it, expect } from "vitest";
import {
  normalizeAddressBlock,
  normalizePostalCode,
  samePlaza,
  distanceMeters,
} from "../plaza";

const addr = (
  streetAddress: string | null,
  postalCode: string | null,
  latitude: string | null = null,
  longitude: string | null = null
) => ({ streetAddress, postalCode, latitude, longitude });

describe("normalizePostalCode", () => {
  it("uppercases and strips separators", () => {
    expect(normalizePostalCode(" k1a 0b1 ")).toBe("K1A0B1");
    expect(normalizePostalCode("90210-1234")).toBe("902101234");
  });
  it("is null for empty/missing input", () => {
    expect(normalizePostalCode("")).toBeNull();
    expect(normalizePostalCode(null)).toBeNull();
    expect(normalizePostalCode("  -  ")).toBeNull();
  });
});

describe("normalizeAddressBlock", () => {
  it("derives the hundred-block plus normalized street name", () => {
    expect(normalizeAddressBlock("120 Main St")).toBe("100|main st");
    expect(normalizeAddressBlock("148 MAIN STREET")).toBe("100|main st");
    expect(normalizeAddressBlock("205 Main St")).toBe("200|main st");
  });
  it("strips unit designators", () => {
    expect(normalizeAddressBlock("120 Main St Suite 4")).toBe("100|main st");
    expect(normalizeAddressBlock("120 Main St #4")).toBe("100|main st");
    expect(normalizeAddressBlock("120 Main St, Unit B")).toBe("100|main st");
  });
  it("collapses common suffix aliases", () => {
    expect(normalizeAddressBlock("300 Oak Avenue")).toBe("300|oak ave");
    expect(normalizeAddressBlock("300 Oak Ave.")).toBe("300|oak ave");
  });
  it("is null without a usable leading street number or name", () => {
    expect(normalizeAddressBlock("")).toBeNull();
    expect(normalizeAddressBlock(null)).toBeNull();
    expect(normalizeAddressBlock("Main Street")).toBeNull();
    expect(normalizeAddressBlock("120")).toBeNull();
  });
});

describe("samePlaza", () => {
  it("matches same hundred-block + postal code despite formatting noise", () => {
    expect(
      samePlaza(addr("120 Main St", "90210"), addr("148 MAIN STREET, Suite B", "90210 "))
    ).toBe(true);
  });
  it("does not match different blocks or streets", () => {
    expect(samePlaza(addr("120 Main St", "90210"), addr("220 Main St", "90210"))).toBe(false);
    expect(samePlaza(addr("120 Main St", "90210"), addr("120 Oak St", "90210"))).toBe(false);
  });
  it("does not match adjacent postal codes even on the same block", () => {
    expect(samePlaza(addr("120 Main St", "90210"), addr("130 Main St", "90211"))).toBe(false);
  });
  it("never matches when address data is missing on either side", () => {
    expect(samePlaza(addr(null, null), addr(null, null))).toBe(false);
    expect(samePlaza(addr("120 Main St", "90210"), addr(null, null))).toBe(false);
    expect(samePlaza(addr("", ""), addr("120 Main St", "90210"))).toBe(false);
  });
  it("falls back to lat/long proximity when street data is incomplete", () => {
    // ~55 m apart.
    const a = addr(null, null, "40.7128", "-74.0060");
    const b = addr(null, "90210", "40.7133", "-74.0060");
    expect(samePlaza(a, b)).toBe(true);
    // ~1.1 km apart.
    const far = addr(null, null, "40.7228", "-74.0060");
    expect(samePlaza(a, far)).toBe(false);
  });
  it("prefers the address-block rule over coordinates when both sides have full addresses", () => {
    // Same coordinates but different blocks — different plazas.
    const a = addr("120 Main St", "90210", "40.7128", "-74.0060");
    const b = addr("920 Elm St", "90210", "40.7128", "-74.0060");
    expect(samePlaza(a, b)).toBe(false);
  });
});

describe("distanceMeters", () => {
  it("computes plausible distances", () => {
    const d = distanceMeters(40.7128, -74.006, 40.7133, -74.006);
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThan(70);
  });
});
