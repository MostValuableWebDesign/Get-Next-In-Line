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

// Controllable service catalog + capture of the options the card fetches with
// (query key + explicit x-tenant-id header).
let servicesState: { data: unknown; isLoading: boolean } = { data: [], isLoading: false };
const listSosServicesOptions = vi.fn();

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
  useListSosServices: (options?: unknown) => {
    listSosServicesOptions(options);
    return servicesState;
  },
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
    listSosServicesOptions.mockClear();
    servicesState = { data: [], isLoading: false };
    routeParams = { id: '1' };
  });

  it('hydrates the form from the tenant settings record', () => {
    renderPage();
    // Route-scoped tenant embed: the service vocabulary card renders with a
    // manage link and fetches the tenant's own catalog.
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

  it('lists the tenant catalog services when the tenant id comes from the route (embed)', () => {
    servicesState = {
      data: [
        { name: 'Balayage', isActive: true },
        { name: 'Old Perm', isActive: false },
      ],
      isLoading: false,
    };
    renderPage();

    const list = screen.getByTestId('list-recognized-services');
    expect(list.textContent).toContain('Balayage');
    expect(list.textContent).not.toContain('Old Perm');
    // The generic "no services" message must not show when the catalog has rows.
    expect(screen.queryByTestId('text-no-services')).not.toBeInTheDocument();

    // The catalog fetch is scoped explicitly to the tenant: x-tenant-id
    // header plus a tenant-qualified query key so caches never mix scopes.
    expect(listSosServicesOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { headers: { 'x-tenant-id': '1' } },
        query: expect.objectContaining({
          queryKey: ['/api/sos/services', { tenantId: 1 }],
        }),
      }),
    );
  });

  it('shows a loading skeleton while the catalog is fetching', () => {
    servicesState = { data: undefined, isLoading: true };
    renderPage();

    expect(screen.getByTestId('skeleton-service-vocabulary')).toBeInTheDocument();
    expect(screen.queryByTestId('text-no-services')).not.toBeInTheDocument();
    expect(screen.queryByTestId('list-recognized-services')).not.toBeInTheDocument();
  });

  it('falls back to the tenant legacy serviceNames when the catalog is empty', () => {
    renderPage();
    const list = screen.getByTestId('list-recognized-services');
    expect(list.textContent).toContain('haircut');
    expect(list.textContent).toContain('color');
  });
});
