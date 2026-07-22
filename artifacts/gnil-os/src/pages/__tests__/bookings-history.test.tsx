import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The Business Bookings page uses one appointments query for the upcoming
// list ({} params) and a second, date-range-scoped one for the History card
// ({ from?, to }). Return different data per call so the test proves History
// renders genuinely historical appointments, not the upcoming list.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const upcomingApt = {
  id: 1, customerId: 1, customerName: 'Future Fran', serviceType: 'Cut',
  startsAt: new Date(NOW + 2 * DAY).toISOString(), endsAt: new Date(NOW + 2 * DAY + 3600e3).toISOString(),
  status: 'booked', source: 'staff', resourceId: null, notes: null, deposit: null,
  createdAt: new Date(NOW - DAY).toISOString(),
};
const pastApt = {
  id: 2, customerId: 2, customerName: 'Historic Hank', serviceType: 'Color',
  startsAt: new Date(NOW - 20 * DAY).toISOString(), endsAt: new Date(NOW - 20 * DAY + 3600e3).toISOString(),
  status: 'completed', source: 'staff', resourceId: null, notes: null, deposit: null,
  createdAt: new Date(NOW - 21 * DAY).toISOString(),
};
const checkedOutVisit = {
  id: 11, customerId: 3, customerName: 'Paid Pam', serviceType: 'Blowout',
  status: 'checked_out', partySize: 1, resourceId: null, resourceName: null,
  estimatedWaitMinutes: null, paymentAmount: 42.5,
  checkedInAt: new Date(NOW - 5 * DAY).toISOString(),
  serviceStartedAt: null, checkedOutAt: new Date(NOW - 5 * DAY + 3600e3).toISOString(),
};
const activeVisit = {
  id: 12, customerId: 4, customerName: 'Active Al', serviceType: 'Trim',
  status: 'in_service', partySize: 1, resourceId: null, resourceName: null,
  estimatedWaitMinutes: null, paymentAmount: null,
  checkedInAt: new Date(NOW - 3600e3).toISOString(),
  serviceStartedAt: new Date(NOW - 1800e3).toISOString(), checkedOutAt: null,
};

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useListSosAppointments: (params: { from?: string; to?: string } = {}) => ({
      // History query passes `to` (and usually `from`); upcoming passes {}.
      data: params.to ? [pastApt] : [upcomingApt],
      isLoading: false,
    }),
    useListSosVisits: (params: { active?: boolean } = {}) => ({
      data: params.active ? [activeVisit] : [activeVisit, checkedOutVisit],
      isLoading: false,
    }),
    useGetSosDashboard: () => ({ data: undefined, isLoading: false }),
  };
});

import { BookingsPage } from '@/pages/sos/bookings';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BookingsPage />
    </QueryClientProvider>,
  );
}

describe('Business Bookings history section', () => {
  it('shows historical appointments and completed visits with payment', () => {
    window.history.replaceState(null, '', '/sos/bookings');
    renderPage();

    const history = screen.getByTestId('card-booking-history');
    expect(history).toHaveTextContent('Historic Hank');
    expect(history).toHaveTextContent('Paid Pam');
    expect(history).toHaveTextContent('42.50 paid');
    expect(history).toHaveTextContent('completed visit');
    // Upcoming appointment stays out of history; active visit isn't history.
    expect(history).not.toHaveTextContent('Future Fran');
    expect(history).not.toHaveTextContent('Active Al');
  });

  it('filters history by search text', () => {
    window.history.replaceState(null, '', '/sos/bookings');
    renderPage();

    fireEvent.change(screen.getByTestId('input-history-search'), { target: { value: 'pam' } });
    const history = screen.getByTestId('card-booking-history');
    expect(history).toHaveTextContent('Paid Pam');
    expect(history).not.toHaveTextContent('Historic Hank');

    fireEvent.change(screen.getByTestId('input-history-search'), { target: { value: 'zzz-no-match' } });
    expect(screen.getByTestId('text-history-empty')).toHaveTextContent('No history matches your search.');
  });
});
