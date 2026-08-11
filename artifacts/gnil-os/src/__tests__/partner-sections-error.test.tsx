/**
 * Partners tab error state — when the modules query fails, the Partners tab
 * shows a visible error message with a retry affordance instead of endless
 * skeletons or an empty page.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

const refetch = vi.fn();
const refetchConnections = vi.fn();

let modulesState: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: typeof refetch;
} = { data: undefined, isLoading: false, isError: true, refetch };

let connectionsState: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: typeof refetchConnections;
} = { data: undefined, isLoading: false, isError: false, refetch: refetchConnections };

vi.mock('@workspace/api-client-react', () => ({
  useListModules: () => modulesState,
  useGetModulesPricing: () => ({ data: undefined, isLoading: false }),
  useListTenants: () => ({ data: [], isLoading: false }),
  useSimulateCheckout: () => ({ mutate: vi.fn(), isPending: false }),
  getListTenantsQueryKey: () => ['tenants'],
  getGetModuleTenantCountsQueryKey: () => ['counts'],
  getGetModuleTenantsQueryKey: (id: number) => ['module-tenants', id],
  getGetBillingSummaryQueryKey: () => ['billing'],
  getGetAgencyDashboardQueryKey: () => ['dashboard'],
  getGetTenantActivityQueryKey: () => ['activity'],
  useListPartnerConnections: () => connectionsState,
  getListPartnerConnectionsQueryKey: () => ['partner-connections'],
}));

vi.mock('@/hooks/use-online', () => ({
  useIsOffline: () => false,
  useOnlineStatus: () => ({ isOnline: true, settled: true }),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OperationsHub from '@/pages/OperationsHub';

function renderPartnersTab() {
  const { hook } = memoryLocation({ path: '/partners' });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <OperationsHub />
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  refetch.mockClear();
  refetchConnections.mockClear();
  modulesState = { data: undefined, isLoading: false, isError: true, refetch };
  connectionsState = {
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: refetchConnections,
  };
});

describe('Partners tab — modules query failure', () => {
  it('shows an error message with a retry button instead of skeletons or empty content', () => {
    renderPartnersTab();

    expect(screen.getByTestId('partner-services-error')).toBeInTheDocument();
    expect(screen.getByText(/couldn't load partner integrations/i)).toBeInTheDocument();
    expect(screen.queryByTestId('partner-services')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('button-retry-partners'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('still renders the loading skeletons (not the error) while loading', () => {
    modulesState = { data: undefined, isLoading: true, isError: false, refetch };
    renderPartnersTab();

    expect(screen.getByTestId('partner-services')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-services-error')).not.toBeInTheDocument();
  });
});

describe('Partners tab — partner-connections query failure', () => {
  const partnerModules = [
    {
      id: 1,
      name: 'Payroll HQ',
      description: 'Payroll tooling',
      categorySlug: 'partners',
      partnerBrand: 'Gusto',
      isActive: true,
    },
  ];

  it('shows a non-blocking error indicator while the partner cards still render', () => {
    modulesState = { data: partnerModules, isLoading: false, isError: false, refetch };
    connectionsState = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetchConnections,
    };
    renderPartnersTab();

    // Cards render (non-blocking) …
    expect(screen.getByTestId('partner-services')).toBeInTheDocument();
    // … with a visible indicator that connection status failed to load.
    expect(screen.getByTestId('partner-connections-error')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('button-retry-partner-connections'));
    expect(refetchConnections).toHaveBeenCalledTimes(1);
  });

  it('shows no indicator when connections load fine or are still loading', () => {
    modulesState = { data: partnerModules, isLoading: false, isError: false, refetch };
    renderPartnersTab();
    expect(screen.queryByTestId('partner-connections-error')).not.toBeInTheDocument();

    connectionsState = {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: refetchConnections,
    };
    renderPartnersTab();
    expect(screen.queryByTestId('partner-connections-error')).not.toBeInTheDocument();
  });
});
