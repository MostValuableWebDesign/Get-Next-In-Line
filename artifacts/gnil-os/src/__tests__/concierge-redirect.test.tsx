import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Only the hooks used by the components actually rendered on this route
// (Shell + TenantDetail + concierge tabs) need deterministic results.
vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/api-client-react')>();
  return {
    ...actual,
    useHealthCheck: () => ({
      data: { status: 'ok' },
      isError: false,
      isFetched: true,
    }),
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
    useGetTenantActivity: () => ({
      data: { items: [], hasMore: false },
      isLoading: false,
    }),
    useListEngagementRules: () => ({
      data: [
        {
          id: 11,
          ruleType: 'reminder',
          isActive: true,
          config: { leadHours: 24 },
        },
      ],
      isLoading: false,
    }),
    useCreateEngagementRule: () => ({ mutate: () => {}, isPending: false }),
    useUpdateEngagementRule: () => ({ mutate: () => {}, isPending: false }),
    useDeleteEngagementRule: () => ({ mutate: () => {}, isPending: false }),
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ authState: 'authenticated' }),
}));

import App from '../App';

describe('legacy /tenants/:id/concierge redirect', () => {
  it('redirects old concierge bookmarks to the Tenant Detail Engagement Rules tab', async () => {
    window.history.replaceState(null, '', '/tenants/5/concierge');
    render(<App />);

    // Tenant Detail must render...
    expect(await screen.findByTestId('text-tenant-brand')).toHaveTextContent('Luxe Salon');

    // ...with the Engagement Rules tab active and its content visible.
    expect(screen.getByTestId('tab-rules')).toHaveAttribute('data-state', 'active');
    expect(await screen.findByTestId('row-rule-11')).toBeInTheDocument();

    // The URL must be rewritten (replace, not push) to the tab deep link.
    expect(window.location.pathname).toBe('/tenants/5');
    expect(window.location.search).toBe('?tab=rules');
  });
});

describe('tenant detail tab selection persists in URL', () => {
  it('writes ?tab= to the URL (replace) when a tab is clicked', async () => {
    window.history.replaceState(null, '', '/tenants/5');
    render(<App />);

    expect(await screen.findByTestId('text-tenant-brand')).toHaveTextContent('Luxe Salon');
    const historyLength = window.history.length;

    await userEvent.click(screen.getByTestId('tab-rules'));

    expect(screen.getByTestId('tab-rules')).toHaveAttribute('data-state', 'active');
    expect(window.location.pathname).toBe('/tenants/5');
    expect(window.location.search).toBe('?tab=rules');
    // Replace, not push: no new history entry.
    expect(window.history.length).toBe(historyLength);
  });
});
