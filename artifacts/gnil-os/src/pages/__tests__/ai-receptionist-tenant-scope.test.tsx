import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Controllable route params so we can simulate navigating between tenants
// without a full remount (wouter keeps the same component mounted when only
// the :id param changes).
let routeParams: { id?: string } = {};

vi.mock('wouter', async () => {
  const actual = await vi.importActual<typeof import('wouter')>('wouter');
  return { ...actual, useParams: () => routeParams };
});

const tenantSettings: Record<number, any> = {
  1: {
    id: 11,
    businessName: 'Tenant One',
    aiReceptionistEnabled: true,
    serviceNames: 'haircut, color',
    smsMode: 'simulated',
  },
  2: {
    id: 12,
    businessName: 'Tenant Two',
    aiReceptionistEnabled: false,
    serviceNames: 'oil change, tires',
    smsMode: 'simulated',
  },
};

const updateTenantMutate = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useGetSosSettings: () => ({ data: undefined, isLoading: false }),
  getGetSosSettingsQueryKey: () => ['/api/sos/settings'],
  useUpdateSosSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useListSosCalls: () => ({ data: [] }),
  getListSosCallsQueryKey: () => ['/api/sos/calls'],
  useListSosMessages: () => ({ data: [] }),
  getListSosMessagesQueryKey: () => ['/api/sos/messages'],
  useSimulateSosCall: () => ({ mutate: vi.fn(), isPending: false }),
  useSendSosMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useListSosCustomers: () => ({ data: [] }),
  getListSosCustomersQueryKey: () => ['/api/sos/customers'],
  useGetTenantSettings: (id: number) => ({
    data: tenantSettings[id],
    isLoading: false,
  }),
  getGetTenantSettingsQueryKey: (id: number) => ['/api/tenants', id, 'settings'],
  useUpdateTenantSettings: () => ({ mutate: updateTenantMutate, isPending: false }),
  useGetTenant: (id: number) => ({
    data: id ? { id, brandName: `Brand ${id}` } : undefined,
  }),
  getGetTenantQueryKey: (id: number) => ['/api/tenants', id],
  useListSosServices: () => ({ data: [], isLoading: false }),
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

describe('Tenant-scoped AI Receptionist view', () => {
  beforeEach(() => {
    updateTenantMutate.mockClear();
    routeParams = { id: '1' };
  });

  it('hydrates the form from the tenant settings record', () => {
    renderPage();
    // Route-scoped tenant embed: the service vocabulary links to the Service
    // Menu editor rather than fetching an unreliable scope.
    expect(screen.getByTestId('card-service-vocabulary')).toBeInTheDocument();
    expect(screen.getByTestId('link-manage-service-menu')).toBeInTheDocument();
    expect(screen.getByTestId('switch-ai-receptionist')).toBeChecked();
    // Business-wide sections are hidden per-tenant
    expect(screen.queryByTestId('section-call-logs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-sms-history')).not.toBeInTheDocument();
  });

  it('rehydrates the form and saves to the new tenant when the :id param changes without a remount', () => {
    const view = renderPage();

    expect(screen.getByTestId('switch-ai-receptionist')).toBeChecked();

    // Simulate wouter navigating /tenants/1/... -> /tenants/2/... (same
    // mounted component, new params).
    routeParams = { id: '2' };
    view.rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AiReceptionistPage />
      </QueryClientProvider>,
    );

    // Form must reflect tenant 2's record, not stale tenant 1 values
    expect(screen.getByTestId('switch-ai-receptionist')).not.toBeChecked();

    // Saving targets tenant 2 with tenant 2's values
    fireEvent.click(screen.getByTestId('button-save-ai-receptionist'));
    expect(updateTenantMutate).toHaveBeenCalledTimes(1);
    expect(updateTenantMutate.mock.calls[0][0]).toMatchObject({
      id: 2,
      data: { aiReceptionistEnabled: false },
    });
  });
});
