/**
 * Tenant detail activity pagination:
 *  - shows only the first bounded page (20 items) even when the tenant has a
 *    large history (150 events);
 *  - "Load more" appends the next page via keyset (cursor) pagination —
 *    before_timestamp/before_id of the last loaded item — with a fixed
 *    page size (limit never grows past the API's max);
 *  - repeated clicks keep working beyond 100 total rows;
 *  - the button disappears when hasMore is false;
 *  - a failed "Load more" shows an error and allows retry.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import TenantDetail from '@/pages/TenantDetail';

const PAGE_SIZE = 20;
const TOTAL = 150;

const allActivities = [
  ...Array.from({ length: TOTAL }, (_, i) => ({
    id: i + 1,
    tenantId: 1,
    tenantName: 'Apex Digital Media',
    action: `Event ${i + 1}`,
    details: null,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, TOTAL - i)).toISOString(),
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: 1000 + i,
    tenantId: 2,
    tenantName: 'Summit Agency Group',
    action: `T2 Event ${i + 1}`,
    details: null,
    timestamp: new Date(Date.UTC(2026, 1, 1, 0, 0, 5 - i)).toISOString(),
  })),
];

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
  let rows = sortedDesc(
    allActivities.filter((a) => params.tenantId === undefined || a.tenantId === params.tenantId),
  );
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
  useGetTenant: () => ({
    data: {
      id: 1,
      brandName: 'Apex Digital Media',
      subdomain: 'apex-digital',
      status: 'active',
      contactEmail: 'a@b.co',
      contactName: 'Alex',
      mrr: 100,
      modulesEnabled: 1,
      createdAt: new Date().toISOString(),
    },
    isLoading: false,
  }),
  useGetTenantModules: () => ({ data: [], isLoading: false }),
  useGetTenantActivity: (params: ActivityParams) => ({
    data: pageFor(params),
    isLoading: false,
  }),
  getTenantActivity: (params: ActivityParams) => getTenantActivityMock(params),
  getGetTenantQueryKey: (id: number) => ['tenant', id],
  getGetTenantModulesQueryKey: (id: number) => ['tenant-modules', id],
  getGetTenantActivityQueryKey: (params: unknown) => ['activity', params],
}));

function renderDetail() {
  const location = memoryLocation({ path: '/tenants/1' });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <Router hook={location.hook}>
        <Route path="/tenants/:id" component={TenantDetail} />
      </Router>
    </QueryClientProvider>,
  );
  return { ...utils, navigate: location.navigate };
}

function renderedActivityCount(pattern: RegExp = /^Event \d+$/) {
  return within(screen.getByTestId('list-tenant-activity')).getAllByText(pattern).length;
}

describe('TenantDetail activity pagination', () => {
  beforeEach(() => {
    getTenantActivityMock.mockClear();
  });

  it('renders only the first page for a tenant with 150 events', () => {
    renderDetail();
    expect(renderedActivityCount()).toBe(PAGE_SIZE);
    expect(screen.getByTestId('button-load-more-activity')).toBeInTheDocument();
  });

  it('appends pages with fixed limit and an advancing keyset cursor, past 100 rows, until exhausted', async () => {
    renderDetail();

    // 20 shown; click Load more 7 times to reach 160-capped-at-150.
    for (let click = 1; click <= 7; click++) {
      fireEvent.click(screen.getByTestId('button-load-more-activity'));
      await waitFor(() =>
        expect(renderedActivityCount()).toBe(Math.min(PAGE_SIZE * (click + 1), TOTAL)),
      );
    }

    // Every request used a bounded limit and the (timestamp, id) cursor of the
    // last item on the previous page — never an offset.
    expect(getTenantActivityMock).toHaveBeenCalledTimes(7);
    const sorted = sortedDesc(allActivities.filter((a) => a.tenantId === 1));
    getTenantActivityMock.mock.calls.forEach(([params], i) => {
      expect(params.limit).toBe(PAGE_SIZE);
      const lastLoaded = sorted[PAGE_SIZE * (i + 1) - 1];
      expect(params.before_timestamp).toBe(lastLoaded.timestamp);
      expect(params.before_id).toBe(lastLoaded.id);
      expect(params).not.toHaveProperty('offset');
    });

    // All 150 loaded — button disappears.
    expect(renderedActivityCount()).toBe(TOTAL);
    expect(screen.queryByTestId('button-load-more-activity')).not.toBeInTheDocument();
  });

  it('appends the second page in order, with no duplicates or omissions', async () => {
    renderDetail();

    fireEvent.click(screen.getByTestId('button-load-more-activity'));
    await waitFor(() => expect(renderedActivityCount()).toBe(PAGE_SIZE * 2));

    // The rendered list must be exactly Events 1..40 in server (desc) order —
    // proof the new page was appended after the first with no dupes or gaps.
    const list = screen.getByTestId('list-tenant-activity');
    const rendered = within(list)
      .getAllByText(/^Event \d+$/)
      .map((el) => el.textContent);
    expect(rendered).toEqual(
      Array.from({ length: PAGE_SIZE * 2 }, (_, i) => `Event ${i + 1}`),
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('keeps deterministic continuity across a page boundary with tied timestamps', async () => {
    // Make events 15..25 share one timestamp so the page-1/page-2 boundary
    // falls inside a tie. The server contract (timestamp desc, id desc
    // tiebreak) defines the authoritative order; the keyset cursor
    // (before_timestamp, before_id) must keep the pages contiguous with no
    // repeat or skip even inside the tied group.
    const tiedTs = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
    const patched = allActivities.map((a) =>
      a.tenantId === 1 && a.id >= 15 && a.id <= 25 ? { ...a, timestamp: tiedTs } : a,
    );
    const originals = allActivities.splice(0, allActivities.length, ...patched);

    try {
      renderDetail();
      fireEvent.click(screen.getByTestId('button-load-more-activity'));
      await waitFor(() => expect(renderedActivityCount()).toBe(PAGE_SIZE * 2));

      const rendered = within(screen.getByTestId('list-tenant-activity'))
        .getAllByText(/^Event \d+$/)
        .map((el) => el.textContent);
      const expected = sortedDesc(allActivities.filter((a) => a.tenantId === 1))
        .slice(0, PAGE_SIZE * 2)
        .map((a) => a.action);
      expect(rendered).toEqual(expected);
      expect(new Set(rendered).size).toBe(rendered.length);
    } finally {
      allActivities.splice(0, allActivities.length, ...originals);
    }
  });

  it('resets loaded pages when navigating to a different tenant (no cross-tenant leakage)', async () => {
    const { navigate } = renderDetail();

    // Load a second page for tenant 1.
    fireEvent.click(screen.getByTestId('button-load-more-activity'));
    await waitFor(() => expect(renderedActivityCount()).toBe(PAGE_SIZE * 2));

    // Navigate to tenant 2 — only its 5 events must be shown, none of tenant 1's.
    navigate('/tenants/2');
    await waitFor(() => expect(renderedActivityCount(/^T2 Event \d+$/)).toBe(5));
    const list = screen.getByTestId('list-tenant-activity');
    expect(within(list).queryByText(/^Event \d+$/)).not.toBeInTheDocument();
    // Tenant 2 has a single page — no Load more button.
    expect(screen.queryByTestId('button-load-more-activity')).not.toBeInTheDocument();
  });

  it('discards a load-more response that resolves after navigating to another tenant', async () => {
    const { navigate } = renderDetail();

    // Make the next load-more hang until we resolve it manually.
    let resolvePending!: (page: ReturnType<typeof pageFor>) => void;
    getTenantActivityMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePending = resolve; }),
    );

    fireEvent.click(screen.getByTestId('button-load-more-activity'));

    // Navigate to tenant 2 while the tenant-1 request is still in flight.
    navigate('/tenants/2');
    await waitFor(() => expect(renderedActivityCount(/^T2 Event \d+$/)).toBe(5));

    // Late tenant-1 response arrives — it must be ignored.
    const lastOfPage1 = sortedDesc(allActivities.filter((a) => a.tenantId === 1))[PAGE_SIZE - 1];
    resolvePending(
      pageFor({
        tenantId: 1,
        limit: PAGE_SIZE,
        before_timestamp: lastOfPage1.timestamp,
        before_id: lastOfPage1.id,
      }),
    );
    await waitFor(() => expect(renderedActivityCount(/^T2 Event \d+$/)).toBe(5));
    const list = screen.getByTestId('list-tenant-activity');
    expect(within(list).queryByText(/^Event \d+$/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('button-load-more-activity')).not.toBeInTheDocument();
  });

  it('shows an error and allows retry when Load more fails', async () => {
    renderDetail();

    getTenantActivityMock.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByTestId('button-load-more-activity'));
    await waitFor(() => expect(screen.getByTestId('text-load-more-error')).toBeInTheDocument());
    expect(renderedActivityCount()).toBe(PAGE_SIZE);

    // Retry succeeds and appends the next page.
    fireEvent.click(screen.getByTestId('button-load-more-activity'));
    await waitFor(() => expect(renderedActivityCount()).toBe(PAGE_SIZE * 2));
    expect(screen.queryByTestId('text-load-more-error')).not.toBeInTheDocument();
  });
});
