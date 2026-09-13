/** Live Operations is a direct single-business surface with no selector. */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

vi.mock('@workspace/api-client-react', () => ({
  useListSosVisits: () => ({ data: [] }),
  useListSosResources: () => ({ data: [] }),
  useListSosWaitlist: () => ({ data: [] }),
  useGetSosSettings: () => ({ data: undefined }),
  useGetSosDashboard: () => ({ data: undefined }),
  useRetryFailedSosMessages: () => ({ mutate: vi.fn(), isPending: false }),
  getGetSosDashboardQueryKey: () => ['sos-dashboard'],
  useAdvanceSosVisit: () => ({ mutate: vi.fn() }),
  useCheckInSosVisit: () => ({ mutate: vi.fn(), isPending: false }),
  useClaimSosWaitlistSlot: () => ({ mutate: vi.fn() }),
  useUpdateSosResource: () => ({ mutate: vi.fn() }),
  useCreateSosResource: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSosResource: () => ({ mutate: vi.fn(), isPending: false }),
  getListTenantsQueryKey: () => ['tenants'],
  useListTenants: () => ({
    data: [
      { id: 7, brandName: 'Glow Salon' },
      { id: 9, brandName: 'Fade Factory' },
    ],
  }),
  getListSosVisitsQueryKey: (p?: unknown) => ['visits', p],
  getListSosResourcesQueryKey: () => ['resources'],
  getListSosWaitlistQueryKey: () => ['waitlist'],
  getGetSosSettingsQueryKey: () => ['settings'],
  SosVisitStatus: {},
}));

vi.mock('@/components/sos/customer-picker', () => ({
  CustomerPicker: () => <div />,
}));

import { OperationsPage } from '@/pages/sos/operations';

function renderPage(path: string) {
  const { hook } = memoryLocation({ path });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Router hook={hook}>
        <OperationsPage embedded />
      </Router>
    </QueryClientProvider>,
  );
}

describe('Live Operations business scope', () => {
  it('ignores obsolete tenant query parameters and shows no selector', () => {
    renderPage('/?tenant=7');
    expect(screen.getByText('Active visits, resources, and the smart waitlist.')).toBeInTheDocument();
    expect(screen.queryByTestId('select-operations-business')).not.toBeInTheDocument();
    expect(screen.queryByText(/Glow Salon/i)).not.toBeInTheDocument();
  });

  it('loads directly without selected-business or legacy copy', () => {
    renderPage('/');
    expect(screen.getByRole('heading', { name: 'Live Operations' })).toBeInTheDocument();
    expect(screen.queryByText(/select a business|all businesses|legacy/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('select-operations-business')).not.toBeInTheDocument();
  });
});
