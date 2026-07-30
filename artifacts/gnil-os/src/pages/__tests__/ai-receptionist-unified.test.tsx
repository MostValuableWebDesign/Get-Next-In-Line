import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mutate = vi.fn();
const sendMutate = vi.fn();

let customers: Array<{ id: number; name: string; phone: string | null }> = [];

// Structured service catalog rows (the receptionist's vocabulary source).
let catalog: Array<{ name: string; isActive: boolean }> = [];

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
  useSendSosMessage: () => ({ mutate: sendMutate, isPending: false }),
  useRetrySosMessage: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useListSosCustomers: () => ({ data: customers, isLoading: false }),
  getListSosCustomersQueryKey: () => ['/api/sos/customers'],
  useCreateSosCustomer: () => ({ mutate: vi.fn(), isPending: false }),
  // Tenant-scoped variants — unused when rendering the global page
  useGetTenantSettings: () => ({ data: undefined, isLoading: false }),
  getGetTenantSettingsQueryKey: (id: number) => ['/api/tenants', id, 'settings'],
  useUpdateTenantSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useGetTenant: () => ({ data: undefined }),
  getGetTenantQueryKey: (id: number) => ['/api/tenants', id],
  useListSosServices: () => ({ data: catalog, isLoading: false }),
  getListSosServicesQueryKey: () => ['/api/sos/services'],
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
    expect(screen.getByTestId('card-service-vocabulary')).toBeInTheDocument();
    expect(screen.getByTestId('button-save-ai-receptionist')).toBeInTheDocument();
    // Simulator + operations sections in the same view
    expect(screen.getByText('Simulate Inbound Call')).toBeInTheDocument();
    expect(screen.getByTestId('section-call-logs')).toBeInTheDocument();
    expect(screen.getByTestId('section-sms-history')).toBeInTheDocument();
    expect(screen.getByText('Send Manual SMS')).toBeInTheDocument();
  });

  it('saves the enable toggle inline (service vocabulary is managed in the Service Menu)', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('switch-ai-receptionist'));
    fireEvent.click(screen.getByTestId('button-save-ai-receptionist'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].data).toEqual({ aiReceptionistEnabled: true });
  });

  it('shows the structured catalog services as the recognized vocabulary, with a manage link', () => {
    catalog = [
      { name: 'Balayage', isActive: true },
      { name: 'Old Perm', isActive: false },
    ];
    renderPage();
    const list = screen.getByTestId('list-recognized-services');
    expect(list.textContent).toContain('Balayage');
    expect(list.textContent).not.toContain('Old Perm');
    // Catalog wins over the legacy comma-separated setting
    expect(list.textContent).not.toContain('haircut');
    expect(screen.getByTestId('link-manage-service-menu')).toBeInTheDocument();
    catalog = [];
  });

  it('falls back to the legacy serviceNames setting when the catalog is empty', () => {
    renderPage();
    const list = screen.getByTestId('list-recognized-services');
    expect(list.textContent).toContain('haircut');
    expect(list.textContent).toContain('color');
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

  describe('Send Manual SMS dialog', () => {
    beforeEach(() => {
      sendMutate.mockClear();
      customers = [
        { id: 7, name: 'Ada Lovelace', phone: '+15550001111' },
        { id: 9, name: 'Grace Hopper', phone: null },
      ];
    });

    function openDialog() {
      renderPage();
      fireEvent.click(screen.getByText('Send Manual SMS'));
    }

    it('offers a customer picker with no default selection and disables Send until one is chosen', () => {
      openDialog();
      // No raw ID input; a searchable picker instead, with no preselected customer.
      expect(screen.queryByText('Customer ID')).not.toBeInTheDocument();
      const picker = screen.getByTestId('button-customer-picker');
      expect(picker.textContent).toContain('Select customer');

      fireEvent.change(screen.getByPlaceholderText('Type message...'), {
        target: { value: 'Hello there' },
      });
      const sendButton = screen.getByText('Send Message').closest('button')!;
      expect(sendButton).toBeDisabled();
      fireEvent.click(sendButton);
      expect(sendMutate).not.toHaveBeenCalled();
    });

    it('sends to the selected customer with the manual kind', () => {
      openDialog();
      fireEvent.click(screen.getByTestId('button-customer-picker'));
      fireEvent.click(screen.getByTestId('option-customer-7'));
      fireEvent.change(screen.getByPlaceholderText('Type message...'), {
        target: { value: 'Hello Ada' },
      });
      const sendButton = screen.getByText('Send Message').closest('button')!;
      expect(sendButton).not.toBeDisabled();
      fireEvent.click(sendButton);
      expect(sendMutate).toHaveBeenCalledTimes(1);
      expect(sendMutate.mock.calls[0][0]).toEqual({
        data: { customerId: 7, body: 'Hello Ada', kind: 'manual' },
      });
    });
  });
});
