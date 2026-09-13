import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the hooks used by the components actually rendered on this route
// (Shell + Business Bookings incl. the AI Receptionist tab) need
// deterministic results; keep the rest real.
vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useHealthCheck: () => ({
      data: { status: 'ok' },
      isError: false,
      isFetched: true,
    }),
    useListSosAppointments: () => ({ data: [], isLoading: false }),
    useListSosVisits: () => ({ data: [], isLoading: false }),
    useGetSosDashboard: () => ({ data: undefined, isLoading: false }),
    useGetSosSettings: () => ({
      data: {
        id: 1,
        businessName: 'Sunrise Clinic',
        industryType: 'Clinic',
        resourceLabel: 'Room',
        aiReceptionistEnabled: true,
        serviceNames: 'haircut, color',
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
    useListSosCalls: () => ({ data: [] }),
    useListSosMessages: () => ({ data: [] }),
    useSimulateSosCall: () => ({ mutate: () => {}, isPending: false }),
    useSendSosMessage: () => ({ mutate: () => {}, isPending: false }),
    // Tenant-scoped variants used when the redirect carries ?tenant=<id>.
    getListTenantsQueryKey: () => ['tenants'],
    useListTenants: () => ({
      data: [{ id: 7, brandName: 'Glow Salon' }],
      isLoading: false,
    }),
    useGetTenant: () => ({ data: { id: 7, brandName: 'Glow Salon' }, isLoading: false }),
    useGetTenantSettings: () => ({
      data: {
        id: 2,
        businessName: 'Glow Salon',
        industryType: 'Salon',
        resourceLabel: 'Chair',
        aiReceptionistEnabled: false,
        serviceNames: 'haircut',
        waitlistAutoFillEnabled: false,
        smsFromNumber: '',
        smsMode: 'simulated',
        smsActiveFromNumber: null,
        smsInboundWebhookUrl: null,
        smsInboundReady: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      isLoading: false,
    }),
    useUpdateTenantSettings: () => ({ mutate: () => {}, isPending: false }),
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
  useSessionRole: () => 'super_admin',
}));

import App from '../App';

async function expectLandsOnAiReceptionistTab() {
  render(<App />);

  // Business Bookings renders with the AI Receptionist tab active — the
  // unified console (config + call logs + simulator + SMS history) shows.
  await screen.findByTestId('page-ai-receptionist');
  expect(screen.getByTestId('tabs-bookings-view')).toBeInTheDocument();
  expect(screen.getByTestId('section-ai-receptionist')).toBeInTheDocument();
  expect(screen.getByTestId('section-call-logs')).toBeInTheDocument();
  expect(screen.getByTestId('section-sms-history')).toBeInTheDocument();

  // URL rewritten (replace, not push) to the Business Bookings tab.
  expect(window.location.pathname).toBe('/sos/bookings');
  expect(window.location.search).toBe('?tab=ai-receptionist');
}

describe('AI Receptionist folded into Business Bookings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects old /sos/ai-receptionist bookmarks to the Business Bookings tab', async () => {
    window.history.replaceState(null, '', '/sos/ai-receptionist');
    await expectLandsOnAiReceptionistTab();
  });

  it('redirects the old /sos/marketing page to the Business Bookings tab', async () => {
    window.history.replaceState(null, '', '/sos/marketing');
    await expectLandsOnAiReceptionistTab();
  });

  it('drops obsolete business-selection state when redirecting old Marketing & Comms links', async () => {
    window.history.replaceState(null, '', '/sos/marketing?tenant=7');
    render(<App />);

    await screen.findByTestId('page-ai-receptionist');
    expect(window.location.pathname).toBe('/sos/bookings');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('ai-receptionist');
    expect(new URLSearchParams(window.location.search).get('tenant')).toBeNull();
    expect(screen.queryByTestId('text-sos-business-scope')).not.toBeInTheDocument();
  });

  it('deep link /sos/bookings?tab=ai-receptionist selects the tab directly', async () => {
    window.history.replaceState(null, '', '/sos/bookings?tab=ai-receptionist');
    render(<App />);
    await screen.findByTestId('page-ai-receptionist');
    expect(screen.getByTestId('tab-ai-receptionist')).toHaveAttribute('data-state', 'active');
  });
});
