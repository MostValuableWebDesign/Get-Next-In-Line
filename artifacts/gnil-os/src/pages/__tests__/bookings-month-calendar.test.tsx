/**
 * Bookings Calendar tab — real month grid:
 *  - appointments render as chips on their day cells;
 *  - clicking a day opens the shared BookAppointmentDialog pre-filled with
 *    that date;
 *  - clicking an appointment chip opens its detail dialog, from which
 *    cancellation still works.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

const cancelMutate = vi.fn();
const createMutate = vi.fn();

// Build appointments in the currently displayed month (the grid opens on
// today's month).
const now = new Date();
const day15 = new Date(now.getFullYear(), now.getMonth(), 15, 10, 0, 0);
const day15End = new Date(now.getFullYear(), now.getMonth(), 15, 11, 0, 0);
const pad = (n: number) => String(n).padStart(2, '0');
const day15Key = `${day15.getFullYear()}-${pad(day15.getMonth() + 1)}-${pad(day15.getDate())}`;
const day20Key = `${day15.getFullYear()}-${pad(day15.getMonth() + 1)}-20`;

const appointments = [
  {
    id: 42,
    customerId: 1,
    customerName: 'Amy Client',
    serviceType: 'Haircut',
    startsAt: day15.toISOString(),
    endsAt: day15End.toISOString(),
    status: 'booked',
    source: 'staff',
  },
];

vi.mock('@workspace/api-client-react', () => ({
  useListSosAppointments: () => ({ data: appointments, isLoading: false }),
  getListSosAppointmentsQueryKey: () => ['/api/sos/appointments'],
  useListSosVisits: () => ({ data: [], isLoading: false }),
  useGetSosDashboard: () => ({ data: undefined, isLoading: false }),
  useMarkSosAppointmentNoShow: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelSosAppointment: () => ({ mutate: cancelMutate, isPending: false }),
  useCreateSosAppointment: () => ({ mutate: createMutate, isPending: false }),
}));

// The other tabs pull in their own hooks — stub them out; this test only
// exercises the Calendar tab.
vi.mock('@/pages/sos/reports', () => ({ ReportsContent: () => null }));
vi.mock('@/components/sos/customers-content', () => ({ CustomersContent: () => null }));
vi.mock('@/pages/sos/memberships', () => ({ MembershipPlansContent: () => null }));
vi.mock('@/pages/sos/ai-receptionist', () => ({ AiReceptionistPage: () => null }));
vi.mock('@/components/sos/open-tickets-panel', () => ({ OpenTicketsPanel: () => null }));
vi.mock('@/components/sos/plan-benefits', () => ({ CustomerPlanBadges: () => null }));
vi.mock('@/components/sos/customer-picker', () => ({ CustomerPicker: () => null }));

import { BookingsPage } from '@/pages/sos/bookings';

function renderCalendar() {
  const location = memoryLocation({ path: '/sos/bookings?tab=calendar' });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Route path="/sos/bookings" component={BookingsPage} />
      </Router>
    </QueryClientProvider>,
  );
}

describe('Bookings Calendar tab month grid', () => {
  it('renders a month grid with the appointment chip on its day', () => {
    renderCalendar();

    expect(screen.getByTestId('grid-month-calendar')).toBeInTheDocument();
    expect(screen.getByTestId('text-calendar-month').textContent).toMatch(
      new RegExp(String(now.getFullYear())),
    );

    const dayCell = screen.getByTestId(`cell-day-${day15Key}`);
    const chip = within(dayCell).getByTestId('chip-appointment-42');
    expect(chip.textContent).toContain('Amy Client');
  });

  it('opens the shared booking dialog pre-filled when a day is clicked', () => {
    renderCalendar();

    fireEvent.click(screen.getByTestId(`cell-day-${day20Key}`));

    const dateInput = screen.getByTestId('input-date') as HTMLInputElement;
    expect(dateInput.value).toBe(day20Key);
  });

  it('cancels an appointment from its detail dialog', () => {
    renderCalendar();

    fireEvent.click(screen.getByTestId('chip-appointment-42'));
    const detail = screen.getByTestId('dialog-appointment-detail');
    expect(within(detail).getByText('Amy Client')).toBeInTheDocument();

    fireEvent.click(within(detail).getByTestId('button-cancel-appointment'));
    fireEvent.click(within(detail).getByTestId('button-confirm-cancel-appointment'));

    expect(cancelMutate).toHaveBeenCalledWith({ id: 42 }, expect.anything());
  });
});
