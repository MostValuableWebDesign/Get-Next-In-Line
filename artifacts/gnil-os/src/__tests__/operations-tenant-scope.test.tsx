/**
 * Live Operations tenant context:
 *  - with ?tenant=<id> in the URL, the header shows the selected business
 *    name so staff always know which business's queue is live;
 *  - without it, the header states the combined (legacy) scope;
 *  - the business selector is rendered with the tenant options.
 */
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
  useAdvanceSosVisit: () => ({ mutate: vi.fn() }),
  useCheckInSosVisit: () => ({ mutate: vi.fn(), isPending: false }),
  useClaimSosWaitlistSlot: () => ({ mutate: vi.fn() }),
  useUpdateSosResource: () => ({ mutate: vi.fn() }),
  useCreateSosResource: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSosResource: () => ({ mutate: vi.fn(), isPending: false }),
  useListTenants: () => ({
    data: [
      { id: 7, brandName: 'Glow Salon' },
      { id: 9, brandName: 'Fade Factory' },
    ],
  }),
  setTenantHeaderGetter: () => {},
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
  it('shows the selected business name from ?tenant=', () => {
    renderPage('/?tenant=7');
    expect(screen.getByTestId('text-operations-business-scope')).toHaveTextContent('Glow Salon');
    expect(screen.getByTestId('select-operations-business')).toBeInTheDocument();
  });

  it('states the combined legacy scope when no business is selected', () => {
    renderPage('/');
    expect(screen.queryByTestId('text-operations-business-scope')).toBeNull();
    expect(screen.getAllByText(/all businesses \(legacy\)/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId('select-operations-business')).toBeInTheDocument();
  });
});
