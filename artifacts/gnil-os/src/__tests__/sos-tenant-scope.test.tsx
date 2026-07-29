/**
 * SOS business scoping:
 *  - SosTenantSync derives the active business from ?tenant= on /sos pages
 *    and resets to the legacy (combined) scope everywhere else;
 *  - with a business selected, /api/sos/* requests carry its id as the
 *    x-tenant-id header while non-SOS requests stay unscoped;
 *  - with no business selected, no header is sent (legacy view);
 *  - the Business Bookings selector writes the choice into the URL so
 *    refreshes and cross-links keep the scope.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { SosTenantSync, getCurrentSosTenantId, parseTenantParam } from '@/lib/sos-tenant';
import { listSosCalls, listTenants } from '@workspace/api-client-react';

function renderSync(path: string) {
  const { hook } = memoryLocation({ path, static: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Router hook={hook}>
        <SosTenantSync />
      </Router>
    </QueryClientProvider>,
  );
}

function mockFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      headers: new Headers(init?.headers),
    });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseTenantParam', () => {
  it('accepts positive integers and rejects garbage', () => {
    expect(parseTenantParam('?tenant=5')).toBe(5);
    expect(parseTenantParam('?tab=reports&tenant=12')).toBe(12);
    expect(parseTenantParam('')).toBeNull();
    expect(parseTenantParam('?tenant=abc')).toBeNull();
    expect(parseTenantParam('?tenant=-3')).toBeNull();
    expect(parseTenantParam('?tenant=0')).toBeNull();
  });
});

describe('SosTenantSync scope tracking', () => {
  it('applies ?tenant= on /sos pages and attaches x-tenant-id to SOS requests only', async () => {
    renderSync('/sos/bookings?tab=ai-receptionist&tenant=7');
    expect(getCurrentSosTenantId()).toBe(7);

    const calls = mockFetch();
    await listSosCalls();
    await listTenants();

    const sosCall = calls.find(c => c.url.includes('/api/sos/calls'))!;
    expect(sosCall.headers.get('x-tenant-id')).toBe('7');
    const tenantsCall = calls.find(c => c.url.includes('/api/tenants'))!;
    expect(tenantsCall.headers.get('x-tenant-id')).toBeNull();
  });

  it('sends the explicit "legacy" scope on /sos pages without a selection', async () => {
    renderSync('/sos/bookings');
    expect(getCurrentSosTenantId()).toBeNull();

    const calls = mockFetch();
    await listSosCalls();
    expect(calls[0].headers.get('x-tenant-id')).toBe('legacy');
  });

  it('resets scope outside /sos pages even when ?tenant= is present', () => {
    renderSync('/tenants/7?tenant=7');
    expect(getCurrentSosTenantId()).toBeNull();
  });
});

describe('Business Bookings selector', () => {
  it('shows the selected business scope from the URL', async () => {
    vi.resetModules();
    vi.doMock('@workspace/api-client-react', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
      return {
        ...actual,
        useListSosAppointments: () => ({ data: [], isLoading: false }),
        useListSosVisits: () => ({ data: [], isLoading: false }),
        useGetSosDashboard: () => ({ data: undefined, isLoading: false }),
        getListTenantsQueryKey: () => ['tenants'],
        useListTenants: () => ({
          data: [
            { id: 7, brandName: 'Glow Salon' },
            { id: 9, brandName: 'Fade Factory' },
          ],
          isLoading: false,
        }),
        useGetSosSettings: () => ({ data: undefined, isLoading: false }),
        useGetTenantSettings: () => ({ data: undefined, isLoading: false }),
        useGetTenant: () => ({ data: undefined, isLoading: false }),
        useUpdateSosSettings: () => ({ mutate: vi.fn(), isPending: false }),
        useUpdateTenantSettings: () => ({ mutate: vi.fn(), isPending: false }),
        useListSosCalls: () => ({ data: [], isLoading: false }),
        useListSosMessages: () => ({ data: [], isLoading: false }),
        useSimulateSosCall: () => ({ mutate: vi.fn(), isPending: false }),
        useSendSosMessage: () => ({ mutate: vi.fn(), isPending: false }),
        useListSosCustomers: () => ({ data: [], isLoading: false }),
      };
    });
    const { BookingsPage } = await import('@/pages/sos/bookings');

    window.history.replaceState(null, '', '/sos/bookings?tenant=7');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BookingsPage />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('text-sos-business-scope')).toHaveTextContent('Glow Salon');
    expect(screen.getByTestId('select-sos-business')).toHaveTextContent('Glow Salon');

    // Intra-page jump links must carry the business scope — dropping
    // ?tenant= would silently reset to the legacy combined view.
    expect(screen.getByTestId('link-jump-customers')).toHaveAttribute(
      'href', '/sos/bookings?tab=customers&tenant=7',
    );
    expect(screen.getByTestId('link-jump-membership-plans')).toHaveAttribute(
      'href', '/sos/bookings?tab=plans&tenant=7',
    );
    vi.doUnmock('@workspace/api-client-react');
  });
});
