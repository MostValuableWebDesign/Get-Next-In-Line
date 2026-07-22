import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// Only the hooks used by the components actually rendered on this route
// (Shell + Settings + Connector Registry section) need deterministic results.
vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useHealthCheck: () => ({
      data: { status: 'ok' },
      isError: false,
      isFetched: true,
    }),
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
    useGetConnectorRegistry: () => ({
      data: [
        {
          id: 1,
          name: 'Reputation Manager',
          slug: 'reputation',
          category: 'Marketing',
          categorySlug: 'marketing',
          hiddenConnector: 'GHL Reviews',
          upstreamVendor: 'HighLevel',
          proxyNotes: null,
        },
      ],
      isLoading: false,
    }),
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
}));

import App from '../App';

describe('legacy /connectors redirect', () => {
  it('redirects old /connectors bookmarks to the Configuration Connectors section', async () => {
    window.history.replaceState(null, '', '/connectors');
    render(<App />);

    // The Configuration screen must render with the Connectors section...
    const page = await screen.findByTestId('page-settings');
    const section = within(page).getByTestId('section-connectors');
    expect(
      within(section).getByRole('heading', { name: /Connector Registry/ }),
    ).toBeInTheDocument();
    // ...including the actual registry rows.
    expect(within(section).getByTestId('row-module-1')).toBeInTheDocument();

    // The URL must be rewritten to /settings#connectors (replace, not push).
    expect(window.location.pathname).toBe('/settings');
    expect(window.location.hash).toBe('#connectors');

    // The standalone sidebar entry is gone.
    expect(screen.queryByRole('link', { name: 'Connector Registry' })).not.toBeInTheDocument();
  });
});
