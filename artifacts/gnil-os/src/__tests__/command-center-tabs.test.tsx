import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// Only the hooks used by the components actually rendered on these routes
// (Shell + the Command Center tab under test) need deterministic results.
vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useHealthCheck: () => ({
      data: { status: 'ok' },
      isError: false,
      isFetched: true,
    }),
    // Tenants tab
    useListTenants: () => ({
      data: [
        {
          id: 7,
          brandName: 'Acme Corp',
          subdomain: 'acme',
          contactName: 'Jane Doe',
          contactEmail: 'jane@acme.com',
          status: 'active',
          mrr: 500,
          modulesEnabled: 3,
        },
      ],
      isLoading: false,
    }),
    // Billing tab
    useGetBillingSummary: () => ({
      data: { totalMrr: 500, byCategory: [], topTenants: [] },
      isLoading: false,
    }),
    useGetModulesPricing: () => ({ data: [], isLoading: false }),
    // Billing waits for the module list (partner pass-through classification)
    useListModules: () => ({ data: [], isLoading: false }),
    // Agency Settings tab (Configuration + connector registry section)
    useGetSosSettings: () => ({
      data: {
        id: 1,
        businessName: 'Sunrise Clinic',
        industryType: 'Clinic',
        resourceLabel: 'Room',
        aiReceptionistEnabled: true,
        waitlistAutoFillEnabled: false,
        smsFromNumber: '+15551234567',
        smsMode: 'simulated',
        smsActiveFromNumber: null,
        smsInboundWebhookUrl: null,
        smsInboundReady: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      isLoading: false,
    }),
    useUpdateSosSettings: () => ({ mutate: () => {}, isPending: false }),
    useGetConnectorRegistry: () => ({ data: [], isLoading: false }),
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
}));

import App from '../App';

describe('Command Center tabbed hub', () => {
  it('the sidebar no longer has standalone Tenants / Billing / Configuration entries', async () => {
    window.history.replaceState(null, '', '/tenants');
    render(<App />);
    await screen.findByTestId('command-center-hub');

    expect(screen.queryByRole('link', { name: /Tenant Dashboards/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Billing$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Configuration/ })).not.toBeInTheDocument();
    // The three remaining entries are still there.
    expect(screen.getByRole('link', { name: /Command Center/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Operations/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Business Bookings/ })).toBeInTheDocument();
  });

  it('/tenants deep link lands on the Tenants tab and survives refresh (URL unchanged)', async () => {
    window.history.replaceState(null, '', '/tenants');
    render(<App />);

    const hub = await screen.findByTestId('command-center-hub');
    expect(within(hub).getByTestId('tab-tenants')).toHaveAttribute('data-state', 'active');
    // The tenant grid renders, with its rows.
    expect(await within(hub).findByTestId('row-tenant-7')).toBeInTheDocument();
    // Tab state lives in the URL so refresh/link-sharing keeps the tab.
    expect(window.location.pathname).toBe('/tenants');
  });

  it('/billing deep link lands on the Billing tab', async () => {
    window.history.replaceState(null, '', '/billing');
    render(<App />);

    const hub = await screen.findByTestId('command-center-hub');
    expect(within(hub).getByTestId('tab-billing')).toHaveAttribute('data-state', 'active');
    expect(
      await within(hub).findByRole('heading', { name: /Billing & Finance/ }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/billing');
  });

  it('/settings deep link lands on the Agency Settings tab', async () => {
    window.history.replaceState(null, '', '/settings');
    render(<App />);

    const hub = await screen.findByTestId('command-center-hub');
    expect(within(hub).getByTestId('tab-agency-settings')).toHaveAttribute('data-state', 'active');
    const page = await within(hub).findByTestId('page-settings');
    expect(within(page).getByRole('heading', { name: 'Configuration' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
  });

  it('/settings#connectors hash deep link renders the connector registry section on the Agency Settings tab', async () => {
    window.history.replaceState(null, '', '/settings#connectors');
    render(<App />);

    const hub = await screen.findByTestId('command-center-hub');
    expect(within(hub).getByTestId('tab-agency-settings')).toHaveAttribute('data-state', 'active');
    const page = await within(hub).findByTestId('page-settings');
    expect(within(page).getByTestId('section-connectors')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.hash).toBe('#connectors');
  });

  it('the root URL shows the Dashboard tab as active', async () => {
    window.history.replaceState(null, '', '/');
    render(<App />);

    const hub = await screen.findByTestId('command-center-hub');
    expect(within(hub).getByTestId('tab-dashboard')).toHaveAttribute('data-state', 'active');
  });
});
