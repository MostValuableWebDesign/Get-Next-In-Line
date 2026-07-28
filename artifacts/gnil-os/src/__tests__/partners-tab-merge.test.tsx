import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// All eight partner-category modules, in the tenant-safe /api/modules shape:
// no slug/connector internals, but partnerBrand IS exposed for this category
// (narrow exception to the white-label contract).
const PARTNER_MODULES = [
  { brand: 'The Hartford', name: 'Commercial Liability & Workers Comp' },
  { brand: 'Vestwell', name: 'Automated Retirement & 401(k)' },
  { brand: 'SimplyInsured', name: 'Group Health Insurance Hub' },
  { brand: 'Gusto', name: 'Integrated W-2 & Contractor Payroll' },
  { brand: 'Deel', name: 'Global Team & HR Management' },
  { brand: 'Next Insurance', name: 'Small Business Insurance & COI' },
  { brand: 'Guideline', name: '401(k) & Employee Benefits' },
  { brand: 'QuickBooks', name: 'General Ledger & Financial Sync' },
].map((p, i) => ({
  id: 20 + i,
  name: p.name,
  category: 'Partner Integrations',
  categorySlug: 'partners',
  description: `${p.name} description`,
  isActive: p.brand !== 'QuickBooks', // one inactive partner → Coming Soon
  wholesalePrice: 0,
  partnerBrand: p.brand,
}));

// Deterministic results for the hooks rendered on these routes
// (Shell health check + the partner sections inside the Partners tab).
vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useHealthCheck: () => ({
      data: { status: 'ok' },
      isError: false,
      isFetched: true,
    }),
    useListModules: () => ({ data: PARTNER_MODULES, isLoading: false }),
    useGetModulesPricing: () => ({ data: [], isLoading: false }),
    useListPartnerConnections: () => ({ data: [], isLoading: false }),
    getListPartnerConnectionsQueryKey: () => ['partner-connections'],
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
  useSessionRole: () => 'super_admin',
}));

import App from '../App';

describe('merged Partners tab in the Operations hub', () => {
  it('shows a single Partners tab with every partner presented by brand', async () => {
    window.history.replaceState(null, '', '/partners');
    render(<App />);

    const tabs = await screen.findByTestId('operations-tabs');
    // Exactly one partner entry in the tab bar
    expect(within(tabs).getByTestId('tab-partners')).toHaveTextContent('Partners');
    expect(within(tabs).queryByText('Partner Integrations')).not.toBeInTheDocument();
    expect(within(tabs).queryByText('Partner Services')).not.toBeInTheDocument();

    // The Partner Integrations heading renders...
    expect(
      screen.getByRole('heading', { name: 'Partner-Direct Integrations' }),
    ).toBeInTheDocument();

    // ...with all eight partners visible by brand name.
    const services = screen.getByTestId('partner-services');
    for (const partner of [
      'The Hartford',
      'Vestwell',
      'SimplyInsured',
      'Gusto',
      'Deel',
      'Next Insurance',
      'Guideline',
      'QuickBooks',
    ]) {
      expect(within(services).getByText(partner)).toBeInTheDocument();
    }
  });

  it('reflects availability from module data and hides connector internals', async () => {
    window.history.replaceState(null, '', '/partners');
    render(<App />);
    const services = await screen.findByTestId('partner-services');

    // Active modules read Available; the inactive one reads Coming Soon.
    expect(within(services).getByTestId('badge-availability-deel')).toHaveTextContent('Available');
    expect(within(services).getByTestId('badge-availability-quickbooks')).toHaveTextContent(
      'Coming Soon',
    );

    // No connector plumbing leaks into the page.
    expect(services.textContent).not.toMatch(/API Gateway|Proxy|slug/i);
  });
});

describe('legacy partner URLs redirect to the merged Partners tab', () => {
  const LEGACY_PATHS = [
    '/sos/partner-services',
    '/sos/employees',
    '/sos/payroll',
    '/sos/business-protection',
    '/sos/employee-benefits',
  ];

  it.each(LEGACY_PATHS)('%s redirects to /partners', async (path) => {
    window.history.replaceState(null, '', path);
    render(<App />);

    // The merged Partners tab content must render...
    await screen.findByTestId('partner-services');
    // ...and the URL is rewritten to /partners (replace, not push).
    expect(window.location.pathname).toBe('/partners');
  });
});
