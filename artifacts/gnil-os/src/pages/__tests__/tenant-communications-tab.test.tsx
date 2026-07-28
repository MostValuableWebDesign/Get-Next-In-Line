/**
 * Unified Communications tab on Tenant Detail:
 *  - merges concierge message logs, AI receptionist call logs, and AI SMS
 *    logs into one chronologically ordered stream;
 *  - type filters narrow the stream to AI calls / AI SMS / concierge /
 *    manual sends;
 *  - the old ?tab=log deep link lands on the Communications tab;
 *  - SOS calls/messages are requested with the tenant's x-tenant-id header
 *    so the stream never shows another tenant's traffic.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

const listSosCallsOptions = vi.fn();
const listSosMessagesOptions = vi.fn();
const listSosCustomersOptions = vi.fn();
const sendSosMessageOptions = vi.fn();

const conciergeLogs = [
  {
    id: 1,
    createdAt: '2026-07-01T10:00:00.000Z',
    clientName: 'Amy Client',
    body: 'Reminder: appointment tomorrow',
    jobType: 'reminder',
    status: 'sent',
    errorMessage: null,
    errorCode: null,
  },
  {
    id: 2,
    createdAt: '2026-07-03T10:00:00.000Z',
    clientName: 'Bob Client',
    body: 'We miss you!',
    jobType: 'rebooking_nudge',
    status: 'failed',
    errorMessage: 'Carrier rejected',
    errorCode: '30007',
  },
];

const sosCalls = [
  {
    id: 7,
    callerName: 'Carla Caller',
    fromNumber: '+15550001111',
    intent: 'booking',
    outcome: 'booked',
    transcriptSummary: 'Wants a haircut Friday',
    createdAt: '2026-07-02T10:00:00.000Z',
    customerId: null,
  },
];

const sosMessages = [
  {
    id: 21,
    createdAt: '2026-07-04T10:00:00.000Z',
    customerName: 'Dan Customer',
    toNumber: '+15550002222',
    body: 'Your slot opened up',
    kind: 'waitlist_offer',
    deliveryStatus: 'delivered',
    direction: 'outbound',
    errorMessage: null,
    errorCode: null,
  },
  {
    id: 22,
    createdAt: '2026-07-05T10:00:00.000Z',
    customerName: 'Dan Customer',
    toNumber: '+15550002222',
    body: 'Manual follow-up',
    kind: 'manual',
    deliveryStatus: 'sent',
    direction: 'outbound',
    errorMessage: null,
    errorCode: null,
  },
];

vi.mock('@workspace/api-client-react', () => ({
  useGetTenant: () => ({
    data: {
      id: 5,
      brandName: 'Luxe Salon',
      subdomain: 'luxe',
      status: 'active',
      contactName: 'Ava',
      contactEmail: 'ava@example.com',
      mrr: 450,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    isLoading: false,
    error: null,
  }),
  useGetTenantModules: () => ({ data: [], isLoading: false }),
  useGetTenantActivity: () => ({ data: { items: [], hasMore: false }, isLoading: false }),
  getGetTenantQueryKey: (id: number) => ['tenant', id],
  getGetTenantModulesQueryKey: (id: number) => ['tenant-modules', id],
  getGetTenantActivityQueryKey: (params: unknown) => ['activity', params],
  getTenantActivity: async () => ({ items: [], hasMore: false }),
  // Communications sources
  useListConciergeMessageLogs: () => ({ data: conciergeLogs, isLoading: false }),
  getListConciergeMessageLogsQueryKey: (id: number) => ['concierge-logs', id],
  useListSosCalls: (options: unknown) => {
    listSosCallsOptions(options);
    return { data: sosCalls, isLoading: false };
  },
  getListSosCallsQueryKey: () => ['/api/sos/calls'],
  useListSosMessages: (params: unknown, options: unknown) => {
    listSosMessagesOptions(options);
    return { data: sosMessages, isLoading: false };
  },
  getListSosMessagesQueryKey: (params: unknown) => ['/api/sos/messages', params],
  // Embedded SmsConversations (two-way threads) dependencies
  useListSosCustomers: (_params: unknown, options: unknown) => {
    listSosCustomersOptions(options);
    return { data: [] };
  },
  getListSosCustomersQueryKey: () => ['/api/sos/customers'],
  useCreateSosCustomer: () => ({ mutate: vi.fn(), isPending: false }),
  useSendSosMessage: (options: unknown) => {
    sendSosMessageOptions(options);
    return { mutate: vi.fn(), isPending: false };
  },
}));

import TenantDetail from '@/pages/TenantDetail';

function renderDetail(path = '/tenants/5?tab=communications') {
  const location = memoryLocation({ path });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <Route path="/tenants/:id" component={TenantDetail} />
      </Router>
    </QueryClientProvider>,
  );
}

describe('Tenant Detail unified Communications tab', () => {
  it('shows all message types merged in reverse-chronological order', () => {
    renderDetail();

    const table = screen.getByTestId('table-communications');
    const rows = within(table).getAllByTestId(/^row-comm-/);
    // 2 concierge + 1 call + 2 sos messages, newest first.
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'row-comm-sms-22',
      'row-comm-sms-21',
      'row-comm-concierge-2',
      'row-comm-call-7',
      'row-comm-concierge-1',
    ]);

    // Per-message detail survives the merge (status + failure reason).
    expect(within(table).getByText(/Carrier rejected/)).toBeInTheDocument();
    expect(within(table).getByText('Wants a haircut Friday')).toBeInTheDocument();
  });

  it('filters the stream by type', () => {
    renderDetail();

    fireEvent.click(screen.getByTestId('filter-comm-ai_call'));
    let rows = screen.getAllByTestId(/^row-comm-/);
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-testid')).toBe('row-comm-call-7');

    fireEvent.click(screen.getByTestId('filter-comm-ai_sms'));
    rows = screen.getAllByTestId(/^row-comm-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['row-comm-sms-21']);

    fireEvent.click(screen.getByTestId('filter-comm-concierge'));
    rows = screen.getAllByTestId(/^row-comm-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'row-comm-concierge-2',
      'row-comm-concierge-1',
    ]);

    fireEvent.click(screen.getByTestId('filter-comm-manual'));
    rows = screen.getAllByTestId(/^row-comm-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['row-comm-sms-22']);

    fireEvent.click(screen.getByTestId('filter-comm-all'));
    expect(screen.getAllByTestId(/^row-comm-/)).toHaveLength(5);
  });

  it('requests SOS calls and messages with the tenant x-tenant-id header', () => {
    renderDetail();
    expect(listSosCallsOptions).toHaveBeenCalledWith(
      expect.objectContaining({ request: { headers: { 'x-tenant-id': '5' } } }),
    );
    expect(listSosMessagesOptions).toHaveBeenCalledWith(
      expect.objectContaining({ request: { headers: { 'x-tenant-id': '5' } } }),
    );
  });

  it('embeds tenant-scoped two-way conversations with a reply box', () => {
    renderDetail();
    expect(screen.getByTestId('section-conversations')).toBeInTheDocument();
    expect(screen.getByTestId('sms-conversations')).toBeInTheDocument();
    // Customer reads and replies carry the tenant header too.
    expect(listSosCustomersOptions).toHaveBeenCalledWith(
      expect.objectContaining({ request: { headers: { 'x-tenant-id': '5' } } }),
    );
    expect(sendSosMessageOptions).toHaveBeenCalledWith(
      expect.objectContaining({ request: { headers: { 'x-tenant-id': '5' } } }),
    );
  });

  it('lands old ?tab=log deep links on the Communications tab', () => {
    renderDetail('/tenants/5?tab=log');
    expect(screen.getByTestId('tab-communications')).toHaveAttribute('data-state', 'active');
    expect(screen.getByTestId('table-communications')).toBeInTheDocument();
    // The old Message Log tab is gone.
    expect(screen.queryByTestId('tab-log')).not.toBeInTheDocument();
  });

  it('has no separate Message Log tab in the tab list', () => {
    renderDetail('/tenants/5');
    const tabs = screen.getByTestId('tabs-tenant-detail');
    expect(within(tabs).queryByText('Message Log')).not.toBeInTheDocument();
    expect(within(tabs).getByTestId('tab-communications')).toHaveTextContent('Communications');
  });
});
