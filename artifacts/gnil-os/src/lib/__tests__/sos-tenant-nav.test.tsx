import { describe, it, expect } from 'vitest';
import { withSosTenant, parseTenantParam } from '../sos-tenant-url';

// Tenant-scoped navigation builds hrefs through withSosTenant so moving between
// Business SOS and Operations pages never drops the selected business.
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

  it('carries ?tenant forward onto Operations links', () => {
    expect(withSosTenant('/operations', '?tenant=42')).toBe('/operations?tenant=42');
    expect(withSosTenant('/operations/integrations', '?tenant=42')).toBe(
      '/operations/integrations?tenant=42',
    );
  });

  it('leaves unrelated links untouched', () => {
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
