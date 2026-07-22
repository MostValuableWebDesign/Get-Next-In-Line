import { describe, it, expect } from 'vitest';
import { buildModuleLedgerCsv } from '@/lib/moduleLedgerExport';

describe('buildModuleLedgerCsv', () => {
  it('builds a header plus one row per tenant with MRR formatted to cents', () => {
    const csv = buildModuleLedgerCsv('Smart Booking System', [
      {
        tenantId: 10,
        brandName: 'Apex Salon',
        subdomain: 'apex',
        status: 'active',
        provisionedAt: '2026-03-15T00:00:00Z',
        cadence: 'monthly',
        mrrContribution: 223.5,
      },
      {
        tenantId: 11,
        brandName: 'Metro Clinics',
        subdomain: 'metro',
        status: 'suspended',
        provisionedAt: '2026-04-02T00:00:00Z',
        cadence: 'biweekly',
        mrrContribution: null,
      },
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'Module,Tenant ID,Brand Name,Subdomain,Status,Provisioned At,Billing Cadence,MRR Contribution',
    );
    expect(lines[1]).toBe(
      'Smart Booking System,10,Apex Salon,apex,active,2026-03-15T00:00:00Z,monthly,223.50',
    );
    expect(lines[2]).toBe(
      'Smart Booking System,11,Metro Clinics,metro,suspended,2026-04-02T00:00:00Z,biweekly,',
    );
  });

  it('escapes commas and quotes in field values', () => {
    const csv = buildModuleLedgerCsv('Mod "X", Deluxe', [
      {
        tenantId: 1,
        brandName: 'Cuts, Color & Co.',
        subdomain: 'cuts',
        status: 'active',
        provisionedAt: '2026-01-01T00:00:00Z',
        cadence: 'monthly',
        mrrContribution: 10,
      },
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[1]).toBe(
      '"Mod ""X"", Deluxe",1,"Cuts, Color & Co.",cuts,active,2026-01-01T00:00:00Z,monthly,10.00',
    );
  });
});
