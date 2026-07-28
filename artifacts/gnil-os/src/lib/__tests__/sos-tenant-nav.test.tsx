import { describe, it, expect } from 'vitest';
import { withSosTenant, parseTenantParam } from '../sos-tenant-url';

// The SOS sidebar builds every nav href through withSosTenant so navigating
// between /sos pages (e.g. Business Bookings -> Tax & Compliance) never drops
// the ?tenant=<id> scope. Dropping it would reset the x-tenant-id header and
// tenant-required APIs (all /api/coop/compliance/* endpoints) would 400.
describe('SOS nav tenant propagation (withSosTenant)', () => {
  it('carries ?tenant forward onto /sos links', () => {
    expect(withSosTenant('/sos/tax-compliance', '?tenant=42')).toBe(
      '/sos/tax-compliance?tenant=42',
    );
    expect(withSosTenant('/sos/bookings', '?tenant=7&foo=bar')).toBe('/sos/bookings?tenant=7');
  });

  it('appends with & when the path already has a query string', () => {
    expect(withSosTenant('/sos/bookings?tab=reports', '?tenant=5')).toBe(
      '/sos/bookings?tab=reports&tenant=5',
    );
  });

  it('leaves non-/sos links untouched', () => {
    expect(withSosTenant('/operations', '?tenant=42')).toBe('/operations');
    expect(withSosTenant('/', '?tenant=42')).toBe('/');
  });

  it('is a no-op without a valid tenant in scope', () => {
    expect(withSosTenant('/sos/tax-compliance', '')).toBe('/sos/tax-compliance');
    expect(withSosTenant('/sos/tax-compliance', '?tenant=banana')).toBe('/sos/tax-compliance');
    expect(withSosTenant('/sos/tax-compliance', '?tenant=-1')).toBe('/sos/tax-compliance');
  });

  it('parseTenantParam accepts only positive integers', () => {
    expect(parseTenantParam('?tenant=12')).toBe(12);
    expect(parseTenantParam('?tenant=0')).toBeNull();
    expect(parseTenantParam('')).toBeNull();
  });
});
