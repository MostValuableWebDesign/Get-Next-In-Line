/**
 * Dashboard global activity feed pagination:
 *  - shows only the first bounded page (20 items) of the global feed;
 *  - "Load more" appends the next page via keyset (cursor) pagination —
 *    before_timestamp/before_id of the last loaded item — with a fixed limit;
 *  - the button disappears when hasMore is false;
 *  - a failed "Load more" shows an error and allows retry.
 * Mirrors the mocking approach in tenant-detail-activity-pagination.test.tsx.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from '@/pages/Dashboard';

// The Command Center embeds Live Operations (its own hooks/polling) — out of
// scope for these feed-pagination tests.
vi.mock('@/pages/sos/operations', () => ({ OperationsPage: () => <div /> }));

const PAGE_SIZE = 20;
const TOTAL = 90;

const allActivities = Array.from({ length: TOTAL }, (_, i) => ({
  id: i + 1,
  tenantId: (i % 3) + 1,
  tenantName: `Tenant ${(i % 3) + 1}`,
  action: `Event ${i + 1}`,
  details: null,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, TOTAL - i)).toISOString(),
}));

type ActivityParams = {
  tenantId?: number;
  limit?: number;
  before_timestamp?: string;
  before_id?: number;
};

// Server ordering contract: timestamp desc, id desc tiebreak.
function sortedDesc(rows: typeof allActivities) {
  return [...rows].sort((a, b) =>
    a.timestamp === b.timestamp ? b.id - a.id : a.timestamp < b.timestamp ? 1 : -1,
  );
}

// Mirrors the server's keyset pagination: (timestamp, id) < (before_timestamp, before_id).
function pageFor(params: ActivityParams) {
  const limit = params.limit ?? 20;
  let rows = sortedDesc(allActivities);
  if (params.before_timestamp !== undefined && params.before_id !== undefined) {
    rows = rows.filter(
      (a) =>
        a.timestamp < params.before_timestamp! ||
        (a.timestamp === params.before_timestamp && a.id < params.before_id!),
    );
  }
  return {
    items: rows.slice(0, limit),
    hasMore: rows.length > limit,
  };
}

const getTenantActivityMock = vi.fn(async (params: ActivityParams) => {
  if ((params.limit ?? 20) > 100) throw new Error('limit too big');
  return pageFor(params);
});

vi.mock('@workspace/api-client-react', () => ({
  useGetAgencyDashboard: () => ({
    data: {
      totalMrr: 1000,
      mrrGrowthPercent: 5,
      activeTenants: 3,
      totalTenants: 3,
      suspendedTenants: 0,
      totalModulesProvisioned: 6,
      revenueByCategory: [],
    },
    isLoading: false,
  }),
  useGetAgencySettings: () => ({
    data: {
      markupPercent: 50,
      platformName: 'GNIL OS',
      deploymentMode: 'saas',
      updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    },
    isLoading: false,
  }),
  useUpdateAgencySettings: () => ({ mutate: vi.fn() }),
  useGetTenantActivity: (params: ActivityParams) => ({
    data: pageFor(params),
    isLoading: false,
  }),
  getTenantActivity: (params: ActivityParams) => getTenantActivityMock(params),
  getGetTenantActivityQueryKey: (params: unknown) => ['activity', params],
  getGetModulesPricingQueryKey: () => ['modules-pricing'],
}));

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

function renderedFeedCount() {
  return screen.getAllByText(/^Event \d+$/).length;
}

describe('Dashboard activity feed pagination', () => {
  beforeEach(() => {
    getTenantActivityMock.mockClear();
  });

  it('renders only the first page of the global feed', () => {
    renderDashboard();
    expect(renderedFeedCount()).toBe(PAGE_SIZE);
    expect(screen.getByTestId('button-feed-load-more')).toBeInTheDocument();
  });

  it('appends pages with fixed limit and an advancing keyset cursor until exhausted', async () => {
    renderDashboard();

    // 20 shown; click Load more 4 times to reach 90 (last page is partial).
    for (let click = 1; click <= 4; click++) {
      fireEvent.click(screen.getByTestId('button-feed-load-more'));
      await waitFor(() =>
        expect(renderedFeedCount()).toBe(Math.min(PAGE_SIZE * (click + 1), TOTAL)),
      );
    }

    // Every request used a bounded limit and the (timestamp, id) cursor of the
    // last item on the previous page — never an offset, never a tenant filter.
    expect(getTenantActivityMock).toHaveBeenCalledTimes(4);
    const sorted = sortedDesc(allActivities);
    getTenantActivityMock.mock.calls.forEach(([params], i) => {
      expect(params.limit).toBe(PAGE_SIZE);
      const lastLoaded = sorted[PAGE_SIZE * (i + 1) - 1];
      expect(params.before_timestamp).toBe(lastLoaded.timestamp);
      expect(params.before_id).toBe(lastLoaded.id);
      expect(params).not.toHaveProperty('offset');
      expect(params).not.toHaveProperty('tenantId');
    });

    // All 90 loaded — button disappears.
    expect(renderedFeedCount()).toBe(TOTAL);
    expect(screen.queryByTestId('button-feed-load-more')).not.toBeInTheDocument();
  });

  it('appends the second page in order, with no duplicates or omissions', async () => {
    renderDashboard();

    fireEvent.click(screen.getByTestId('button-feed-load-more'));
    await waitFor(() => expect(renderedFeedCount()).toBe(PAGE_SIZE * 2));

    // Rendered list must be exactly Events 1..40 in server (desc) order —
    // proof the new page was appended after the first with no dupes or gaps.
    const rendered = screen
      .getAllByText(/^Event \d+$/)
      .map((el) => el.textContent);
    expect(rendered).toEqual(
      Array.from({ length: PAGE_SIZE * 2 }, (_, i) => `Event ${i + 1}`),
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('keeps deterministic continuity across a page boundary with tied timestamps', async () => {
    // Make events 15..25 share one timestamp so the page-1/page-2 boundary
    // falls inside a tie; the keyset cursor must keep the pages contiguous.
    const tiedTs = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
    const patched = allActivities.map((a) =>
      a.id >= 15 && a.id <= 25 ? { ...a, timestamp: tiedTs } : a,
    );
    const originals = allActivities.splice(0, allActivities.length, ...patched);

    try {
      renderDashboard();
      fireEvent.click(screen.getByTestId('button-feed-load-more'));
      await waitFor(() => expect(renderedFeedCount()).toBe(PAGE_SIZE * 2));

      const rendered = screen
        .getAllByText(/^Event \d+$/)
        .map((el) => el.textContent);
      const expected = sortedDesc(allActivities)
        .slice(0, PAGE_SIZE * 2)
        .map((a) => a.action);
      expect(rendered).toEqual(expected);
      expect(new Set(rendered).size).toBe(rendered.length);
    } finally {
      allActivities.splice(0, allActivities.length, ...originals);
    }
  });

  it('shows an error and allows retry when Load more fails', async () => {
    renderDashboard();

    getTenantActivityMock.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByTestId('button-feed-load-more'));
    await waitFor(() =>
      expect(screen.getByTestId('text-feed-load-more-error')).toBeInTheDocument(),
    );
    expect(renderedFeedCount()).toBe(PAGE_SIZE);
    expect(screen.getByTestId('button-feed-load-more')).toHaveTextContent('Retry');

    // Retry succeeds and appends the next page; the error clears.
    fireEvent.click(screen.getByTestId('button-feed-load-more'));
    await waitFor(() => expect(renderedFeedCount()).toBe(PAGE_SIZE * 2));
    expect(screen.queryByTestId('text-feed-load-more-error')).not.toBeInTheDocument();
  });
});
