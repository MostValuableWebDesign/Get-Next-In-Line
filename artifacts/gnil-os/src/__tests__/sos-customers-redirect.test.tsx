import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the hooks used by the components actually rendered on this route
// (Shell + Business Bookings) need deterministic results; keep the rest real.
vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useHealthCheck: () => ({ data: { status: 'ok' }, isError: false, isFetched: true }),
    useListSosAppointments: () => ({ data: [], isLoading: false }),
    useListSosVisits: () => ({ data: [], isLoading: false }),
    useGetSosDashboard: () => ({ data: undefined, isLoading: false }),
    useListSosCustomers: () => ({
      data: [
        {
          id: 7, name: 'Dana Fox', phone: '+15550001111', email: null,
          smsOptIn: true, visitCount: 3, lastVisitAt: null, marketing: null,
        },
      ],
      isLoading: false,
    }),
    useGetSosCustomer: () => ({
      data: {
        id: 7, name: 'Dana Fox', phone: '+15550001111', email: null,
        smsOptIn: true, visitCount: 3, lastVisitAt: null, marketing: null,
      },
    }),
    useGetSosCustomerTimeline: () => ({ data: [], isLoading: false }),
    useGetSosCustomerPlans: () => ({ data: { plans: [], transactions: [] }, isLoading: false }),
    useListSosPlans: () => ({ data: [], isLoading: false }),
    useCreateSosCustomer: () => ({ mutate: () => {}, isPending: false }),
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
}));

import App from '../App';

describe('legacy Customers/Memberships redirects into Business Bookings', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('redirects /sos/customers to the Customers tab', async () => {
    window.history.replaceState(null, '', '/sos/customers');
    render(<App />);

    expect(await screen.findByTestId('customers-content')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/sos/bookings');
    expect(window.location.search).toBe('?tab=customers');
  });

  it('redirects /sos/customers?tab=plans to the Plans tab', async () => {
    window.history.replaceState(null, '', '/sos/customers?tab=plans');
    render(<App />);

    expect(await screen.findByTestId('membership-plans-content')).toBeInTheDocument();
    expect(window.location.search).toBe('?tab=plans');
  });

  it('redirects /sos/memberships to the Plans tab', async () => {
    window.history.replaceState(null, '', '/sos/memberships');
    render(<App />);

    expect(await screen.findByTestId('membership-plans-content')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/sos/bookings');
    expect(window.location.search).toBe('?tab=plans');
  });

  it('preserves the customer deep link and auto-opens the detail dialog', async () => {
    window.history.replaceState(null, '', '/sos/customers?customer=7');
    render(<App />);

    expect(await screen.findByTestId('customers-content')).toBeInTheDocument();
    expect(window.location.search).toBe('?tab=customers&customer=7');
    // Detail dialog auto-opens with the customer's name as its title
    expect(await screen.findByRole('dialog')).toHaveTextContent('Dana Fox');
  });
});
