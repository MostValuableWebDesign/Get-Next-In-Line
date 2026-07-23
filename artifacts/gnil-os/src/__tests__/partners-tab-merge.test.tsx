import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// Deterministic results for the hooks rendered on these routes
// (Shell health check + the ModuleGrid inside the Partners tab).
vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useHealthCheck: () => ({
      data: { status: 'ok' },
      isError: false,
      isFetched: true,
    }),
    useListModules: () => ({ data: [], isLoading: false }),
    useGetModulesPricing: () => ({ data: [], isLoading: false }),
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
}));

import App from '../App';

describe('merged Partners tab in the Operations hub', () => {
  it('shows a single Partners tab combining the grid and the partner service details', async () => {
    window.history.replaceState(null, '', '/partners');
    render(<App />);

    const tabs = await screen.findByTestId('operations-tabs');
    // Exactly one partner entry in the tab bar
    expect(within(tabs).getByTestId('tab-partners')).toHaveTextContent('Partners');
    expect(within(tabs).queryByText('Partner Integrations')).not.toBeInTheDocument();
    expect(within(tabs).queryByText('Partner Services')).not.toBeInTheDocument();

    // The 0%-markup integrations grid renders...
    expect(
      screen.getByRole('heading', { name: 'Partner Integrations' }),
    ).toBeInTheDocument();

    // ...alongside all four former partner-service detail cards.
    const services = screen.getByTestId('partner-services');
    for (const partner of ['Deel', 'Gusto', 'Next Insurance', 'Guideline']) {
      expect(within(services).getByText(partner)).toBeInTheDocument();
    }
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
