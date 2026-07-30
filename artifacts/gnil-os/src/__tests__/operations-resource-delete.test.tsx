/**
 * Resource Board delete flow:
 *  - trash button on an available resource opens a confirm dialog; confirming
 *    calls the delete mutation and shows a success toast;
 *  - cancel closes the dialog without deleting;
 *  - an occupied resource is blocked with a destructive toast and no dialog.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

const deleteMutate = vi.fn();
const toastFn = vi.fn();

const resources = [
  { id: 1, name: 'Station 1', resourceType: 'Station', status: 'available', currentCustomerName: null },
  { id: 2, name: 'Room A', resourceType: 'Room', status: 'occupied', currentCustomerName: 'Jane Doe' },
];

vi.mock('@workspace/api-client-react', () => ({
  useListSosVisits: () => ({ data: [] }),
  useListSosResources: () => ({ data: resources }),
  useListSosWaitlist: () => ({ data: [] }),
  useGetSosSettings: () => ({ data: { waitlistAutoFillEnabled: false } }),
  useGetSosDashboard: () => ({ data: undefined }),
  getGetSosDashboardQueryKey: () => ['sos-dashboard'],
  useAdvanceSosVisit: () => ({ mutate: vi.fn() }),
  useCheckInSosVisit: () => ({ mutate: vi.fn(), isPending: false }),
  useClaimSosWaitlistSlot: () => ({ mutate: vi.fn() }),
  useUpdateSosResource: () => ({ mutate: vi.fn() }),
  useCreateSosResource: () => ({ mutate: vi.fn() }),
  useDeleteSosResource: () => ({ mutate: deleteMutate, isPending: false }),
  useListTenants: () => ({ data: [] }),
  getListTenantsQueryKey: () => ['tenants'],
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

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastFn }),
}));

import { OperationsPage } from '@/pages/sos/operations';

function renderPage() {
  const { hook } = memoryLocation({ path: '/operations' });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Router hook={hook}>
        <OperationsPage />
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  deleteMutate.mockReset();
  toastFn.mockReset();
});

describe('Resource Board — delete button', () => {
  it('deletes an available resource after confirmation and toasts', async () => {
    renderPage();

    fireEvent.click(screen.getByTestId('btn-delete-resource-1'));
    // Confirm dialog appears, no mutation yet
    expect(await screen.findByTestId('btn-confirm-delete-resource')).toBeInTheDocument();
    expect(deleteMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('btn-confirm-delete-resource'));
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0][0]).toEqual({ id: 1 });

    // Simulate success callback → toast fired
    deleteMutate.mock.calls[0][1].onSuccess();
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Resource removed' }),
    );
  });

  it('cancel closes the dialog without deleting', async () => {
    renderPage();

    fireEvent.click(screen.getByTestId('btn-delete-resource-1'));
    fireEvent.click(await screen.findByTestId('btn-cancel-delete-resource'));

    await waitFor(() =>
      expect(screen.queryByTestId('btn-confirm-delete-resource')).not.toBeInTheDocument(),
    );
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('blocks deleting an occupied resource with a warning toast', () => {
    renderPage();

    fireEvent.click(screen.getByTestId('btn-delete-resource-2'));

    expect(screen.queryByTestId('btn-confirm-delete-resource')).not.toBeInTheDocument();
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Resource is in use', variant: 'destructive' }),
    );
  });
});
