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

let modulesState: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  refetch: typeof refetch;
} = { data: undefined, isLoading: false, isError: true, refetch };

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
}));

vi.mock('@/hooks/use-online', () => ({
  useIsOffline: () => false,
  useOnlineStatus: () => ({ isOnline: true, settled: true }),
}));

import OperationsHub from '@/pages/OperationsHub';

function renderPartnersTab() {
  const { hook } = memoryLocation({ path: '/partners' });
  return render(
    <Router hook={hook}>
      <OperationsHub />
    </Router>,
  );
}

beforeEach(() => {
  refetch.mockClear();
  modulesState = { data: undefined, isLoading: false, isError: true, refetch };
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
