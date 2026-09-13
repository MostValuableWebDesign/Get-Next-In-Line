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
    useGetModulesPricing: () => ({ data: [], isLoading: false }),
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
  useSessionRole: () => 'super_admin',
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

  it.each([
    '/tenants',
    '/tenants/7',
    '/billing',
    '/master',
    '/governance',
    '/franchise',
  ])('%s cannot open multi-business administration', async (path) => {
    window.history.replaceState(null, '', path);
    render(<App />);

    const hub = await screen.findByTestId('command-center-hub');
    expect(within(hub).getByTestId('tab-dashboard')).toHaveAttribute('data-state', 'active');
    expect(window.location.pathname).toBe('/');
    expect(within(hub).queryByText(/tenants|master overview|franchise|governance/i)).not.toBeInTheDocument();
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
