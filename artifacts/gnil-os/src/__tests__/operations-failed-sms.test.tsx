/**
 * Failed-SMS visibility on Live Operations: when the dashboard reports
 * failed outbound texts today, a destructive banner shows the count and a
 * link to the message log; when there are none, the banner is absent.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

let failedToday = 0;

vi.mock('@workspace/api-client-react', () => ({
  useListSosVisits: () => ({ data: [] }),
  useListSosResources: () => ({ data: [] }),
  useListSosWaitlist: () => ({ data: [] }),
  useGetSosSettings: () => ({ data: undefined }),
  useGetSosDashboard: () => ({ data: { messagesFailedToday: failedToday } }),
  getGetSosDashboardQueryKey: () => ['sos-dashboard'],
  useAdvanceSosVisit: () => ({ mutate: vi.fn() }),
  useCheckInSosVisit: () => ({ mutate: vi.fn(), isPending: false }),
  useClaimSosWaitlistSlot: () => ({ mutate: vi.fn() }),
  useUpdateSosResource: () => ({ mutate: vi.fn() }),
  useCreateSosResource: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSosResource: () => ({ mutate: vi.fn(), isPending: false }),
  getListTenantsQueryKey: () => ['tenants'],
  useListTenants: () => ({ data: [{ id: 7, brandName: 'Glow Salon' }] }),
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

describe('Live Operations failed-SMS banner', () => {
  it('shows the failed count and message-log link when texts failed today', () => {
    failedToday = 3;
    renderPage('/?tenant=7');
    expect(screen.getByTestId('banner-failed-sms')).toBeInTheDocument();
    expect(screen.getByTestId('text-failed-sms-count')).toHaveTextContent('3');
    expect(screen.getByTestId('link-failed-sms-log').closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('tab=ai-receptionist'),
    );
    expect(screen.getByTestId('link-failed-sms-log').closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('tenant=7'),
    );
  });

  it('renders no banner when nothing failed today', () => {
    failedToday = 0;
    renderPage('/');
    expect(screen.queryByTestId('banner-failed-sms')).toBeNull();
  });
});
