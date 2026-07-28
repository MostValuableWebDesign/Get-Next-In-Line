import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// Only the hooks used by the components actually rendered on this route
// (Shell + Settings) need deterministic results; keep the rest real.
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
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
  useSessionRole: () => 'super_admin',
}));

import App from '../App';

describe('legacy /sos/settings redirect', () => {
  it('redirects old /sos/settings bookmarks to the unified Configuration screen', async () => {
    window.history.replaceState(null, '', '/sos/settings');
    render(<App />);

    // The unified Configuration (Settings) screen must render...
    const page = await screen.findByTestId('page-settings');
    expect(
      within(page).getByRole('heading', { name: 'Configuration' }),
    ).toBeInTheDocument();

    // ...and the URL must be rewritten to /settings (replace, not push).
    expect(window.location.pathname).toBe('/settings');
  });
});
