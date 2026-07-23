import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PARTNER_OFFERINGS } from '../OperationsHub';

/**
 * Guard: every partner brand seeded by the API server (CONNECTOR_MAPPING in
 * artifacts/api-server/src/lib/connectorSeed.ts) must have a matching entry in
 * PARTNER_OFFERINGS, otherwise its section on the Partner Integrations tab
 * silently renders with no offerings list. If you rename or add a partner in
 * the seed, add/update the corresponding PARTNER_OFFERINGS entry in
 * OperationsHub.tsx.
 */

const SEED_PATH = path.resolve(
  __dirname,
  '../../../../api-server/src/lib/connectorSeed.ts',
);

function seededPartnerBrands(): string[] {
  const source = readFileSync(SEED_PATH, 'utf8');
  // partnerBrand is only ever set (as a string literal) on partner-category
  // entries in CONNECTOR_MAPPING; other occurrences are property reads like
  // `entry.partnerBrand`, which this pattern does not match.
  const brands = [...source.matchAll(/partnerBrand:\s*"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(brands)];
}

describe('PARTNER_OFFERINGS coverage of seeded partner brands', () => {
  it('finds partner brands in the connector seed (guard against silent parsing breakage)', () => {
    expect(seededPartnerBrands().length).toBeGreaterThan(0);
  });

  it('has an offerings entry (title, description, features) for every seeded partner brand', () => {
    const missing = seededPartnerBrands().filter((brand) => !PARTNER_OFFERINGS[brand]);
    expect(
      missing,
      `Partner brand(s) ${missing.join(', ')} are seeded in connectorSeed.ts but missing from PARTNER_OFFERINGS in OperationsHub.tsx — their Partner Integrations sections would render with no offerings list. Add matching entries (and PARTNER_ORDER placement) or update the renamed key.`,
    ).toEqual([]);
  });

  it('every offerings entry has a non-empty feature list', () => {
    for (const [brand, content] of Object.entries(PARTNER_OFFERINGS)) {
      expect(content.features.length, `${brand} has an empty features list`).toBeGreaterThan(0);
    }
  });

  it('has no orphaned offerings entries for brands no longer in the seed', () => {
    const seeded = new Set(seededPartnerBrands());
    const orphans = Object.keys(PARTNER_OFFERINGS).filter((brand) => !seeded.has(brand));
    expect(
      orphans,
      `PARTNER_OFFERINGS contains ${orphans.join(', ')} but the connector seed no longer seeds those brands — likely a rename; update the PARTNER_OFFERINGS key to match connectorSeed.ts.`,
    ).toEqual([]);
  });
});
