import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const settings = {
  id: 1,
  businessName: 'Sunrise Clinic',
  industryType: 'Clinic',
  resourceLabel: 'Room',
  aiReceptionistEnabled: false,
  waitlistAutoFillEnabled: false,
  smsFromNumber: '+15551234567',
  smsMode: 'simulated' as const,
  smsActiveFromNumber: null,
  smsInboundWebhookUrl: null,
  smsInboundReady: false,
  updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
};

vi.mock('@workspace/api-client-react', () => ({
  useGetSosSettings: () => ({ data: settings, isLoading: false }),
  getGetSosSettingsQueryKey: () => ['/api/sos/settings'],
  useUpdateSosSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useListSosCalls: () => ({ data: [] }),
  getListSosCallsQueryKey: () => ['/api/sos/calls'],
  useListSosMessages: () => ({ data: [] }),
  getListSosMessagesQueryKey: () => ['/api/sos/messages'],
  useSimulateSosCall: () => ({ mutate: vi.fn(), isPending: false }),
  useSendSosMessage: () => ({ mutate: vi.fn(), isPending: false }),
  // Tenant-scoped hooks used by Settings (disabled on the global route).
  useGetTenant: () => ({ data: undefined, isLoading: false }),
  getGetTenantQueryKey: (id: number) => ['/api/tenants', id],
  useGetTenantSettings: () => ({ data: settings, isLoading: false }),
  getGetTenantSettingsQueryKey: (id: number) => ['/api/tenants', id, 'settings'],
  useUpdateTenantSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MarketingPage as SosMarketing } from '../sos/marketing';
import Settings from '../Settings';

function renderAt(path: string, ui: React.ReactElement) {
  // Drive wouter's default browser hooks via jsdom history so useSearch works.
  window.history.replaceState(null, '', path);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('SOS Marketing deep links and cross-links', () => {
  it('defaults to the AI Receptionist tab', () => {
    renderAt('/sos/marketing', <SosMarketing />);
    expect(screen.getByTestId('tab-receptionist')).toHaveAttribute('data-state', 'active');
  });

  it('?tab=sms selects the SMS tab', () => {
    renderAt('/sos/marketing?tab=sms', <SosMarketing />);
    expect(screen.getByTestId('tab-sms')).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('tab-receptionist')).toHaveAttribute('data-state', 'inactive');
  });

  it('an invalid ?tab value falls back to the default tab', () => {
    renderAt('/sos/marketing?tab=bogus', <SosMarketing />);
    expect(screen.getByTestId('tab-receptionist')).toHaveAttribute('data-state', 'active');
  });

  it('links each tab back to the matching Configuration section', () => {
    // Inactive Radix tab content is unmounted, so assert per active tab.
    renderAt('/sos/marketing?tab=sms', <SosMarketing />);
    expect(screen.getByTestId('link-sms-settings')).toHaveAttribute('href', '/settings#sms');
    cleanup();
    renderAt('/sos/marketing', <SosMarketing />);
    expect(screen.getByTestId('link-ai-settings')).toHaveAttribute(
      'href',
      '/settings#ai-receptionist',
    );
  });

  it('honors a tenant-scoped settings= param for the back links', () => {
    renderAt(
      `/sos/marketing?tab=sms&settings=${encodeURIComponent('/tenants/7/settings')}`,
      <SosMarketing />,
    );
    expect(screen.getByTestId('link-sms-settings')).toHaveAttribute(
      'href',
      '/tenants/7/settings#sms',
    );
  });

  it('ignores an unsafe settings= param (external URL)', () => {
    renderAt('/sos/marketing?settings=https://evil.example', <SosMarketing />);
    expect(screen.getByTestId('link-ai-settings')).toHaveAttribute(
      'href',
      '/settings#ai-receptionist',
    );
  });

  it('shows contextual prompts when AI is disabled and SMS is simulated', () => {
    renderAt('/sos/marketing', <SosMarketing />);
    expect(screen.getByTestId('banner-ai-disabled')).toBeInTheDocument();
    cleanup();
    renderAt('/sos/marketing?tab=sms', <SosMarketing />);
    expect(screen.getByTestId('banner-sms-simulated')).toBeInTheDocument();
  });
});

describe('Configuration cross-links to Marketing & Comms', () => {
  it('links AI and SMS sections to the matching Marketing tab', () => {
    renderAt('/settings', <Settings />);
    expect(screen.getByTestId('link-ai-call-logs')).toHaveAttribute(
      'href',
      '/sos/marketing?tab=receptionist',
    );
    expect(screen.getByTestId('link-sms-history')).toHaveAttribute(
      'href',
      '/sos/marketing?tab=sms',
    );
  });
});
