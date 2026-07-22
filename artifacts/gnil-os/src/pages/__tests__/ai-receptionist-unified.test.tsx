import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mutate = vi.fn();

let settings = {
  id: 1,
  businessName: 'Sunrise Clinic',
  industryType: 'Clinic',
  resourceLabel: 'Room',
  aiReceptionistEnabled: false,
  serviceNames: 'haircut, color',
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
  useUpdateSosSettings: () => ({ mutate, isPending: false }),
  useListSosCalls: () => ({ data: [] }),
  getListSosCallsQueryKey: () => ['/api/sos/calls'],
  useListSosMessages: () => ({ data: [] }),
  getListSosMessagesQueryKey: () => ['/api/sos/messages'],
  useSimulateSosCall: () => ({ mutate: vi.fn(), isPending: false }),
  useSendSosMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useListSosCustomers: () => ({ data: [] }),
  getListSosCustomersQueryKey: () => ['/api/sos/customers'],
  // Tenant-scoped variants — unused when rendering the global page
  useGetTenantSettings: () => ({ data: undefined, isLoading: false }),
  getGetTenantSettingsQueryKey: (id: number) => ['/api/tenants', id, 'settings'],
  useUpdateTenantSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useGetTenant: () => ({ data: undefined }),
  getGetTenantQueryKey: (id: number) => ['/api/tenants', id],
}));

import { AiReceptionistPage } from '../sos/ai-receptionist';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiReceptionistPage />
    </QueryClientProvider>,
  );
}

describe('Unified AI Receptionist view', () => {
  beforeEach(() => {
    mutate.mockClear();
    settings = { ...settings, aiReceptionistEnabled: false, smsMode: 'simulated' as const };
  });

  it('shows configuration, simulator, call log, and SMS history together', () => {
    renderPage();
    // Configuration controls
    expect(screen.getByTestId('switch-ai-receptionist')).toBeInTheDocument();
    expect(screen.getByTestId('input-service-names')).toBeInTheDocument();
    expect(screen.getByTestId('button-save-ai-receptionist')).toBeInTheDocument();
    // Simulator + operations sections in the same view
    expect(screen.getByText('Simulate Inbound Call')).toBeInTheDocument();
    expect(screen.getByTestId('section-call-logs')).toBeInTheDocument();
    expect(screen.getByTestId('section-sms-history')).toBeInTheDocument();
    expect(screen.getByText('Send Manual SMS')).toBeInTheDocument();
  });

  it('saves the enable toggle and service names inline', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('switch-ai-receptionist'));
    fireEvent.change(screen.getByTestId('input-service-names'), {
      target: { value: 'massage, facial' },
    });
    fireEvent.click(screen.getByTestId('button-save-ai-receptionist'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].data).toEqual({
      aiReceptionistEnabled: true,
      serviceNames: 'massage, facial',
    });
  });

  it('disabled banner enables inline instead of linking away', () => {
    renderPage();
    const banner = screen.getByTestId('banner-ai-disabled');
    expect(banner).toBeInTheDocument();
    expect(banner.querySelector('a')).toBeNull();
    fireEvent.click(screen.getByTestId('button-enable-ai'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].data).toEqual({ aiReceptionistEnabled: true });
  });

  it('hides the disabled banner when the receptionist is enabled', () => {
    settings = { ...settings, aiReceptionistEnabled: true };
    renderPage();
    expect(screen.queryByTestId('banner-ai-disabled')).not.toBeInTheDocument();
  });

  it('shows the simulated-SMS banner when SMS is not live', () => {
    renderPage();
    expect(screen.getByTestId('banner-sms-simulated')).toBeInTheDocument();
  });
});
