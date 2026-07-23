/**
 * Dashboard resilient loading and fallbacks:
 *  - one page-load query failing renders the other's sections plus an
 *    inline error card with Retry (partial render, no dead page);
 *  - both queries failing shows a friendly full-page error whose Retry
 *    refetches both;
 *  - the activity feed handles its own failure locally with a retry;
 *  - a render-time crash inside the dashboard tab is caught by the error
 *    boundary and shows a recoverable fallback.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Dashboard from '@/pages/Dashboard';

// The Command Center embeds Live Operations (its own hooks/polling) — out of
// scope for these resilience tests.
vi.mock('@/pages/sos/operations', () => ({ OperationsPage: () => <div /> }));

const goodDashboard = {
  totalMrr: 1000,
  mrrGrowthPercent: 5,
  activeTenants: 3,
  totalTenants: 3,
  suspendedTenants: 0,
  totalModulesProvisioned: 6,
  revenueByCategory: [],
  monthlyProfit: 350,
  markupEarnings: 350,
};

const goodSettings = {
  markupPercent: 50,
  platformName: 'GNIL OS',
  deploymentMode: 'saas',
  updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
};

const goodActivity = {
  items: [
    {
      id: 1,
      tenantId: 1,
      tenantName: 'Tenant 1',
      action: 'Event 1',
      details: null,
      timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    },
  ],
  hasMore: false,
};

// Mutable per-test state driving the mocked hooks.
const state = {
  dashboard: goodDashboard as typeof goodDashboard | undefined,
  settings: goodSettings as typeof goodSettings | undefined,
  activity: goodActivity as typeof goodActivity | undefined,
};

const refetchDashboard = vi.fn();
const refetchSettings = vi.fn();
const refetchActivity = vi.fn();

vi.mock('@workspace/api-client-react', () => ({
  useGetAgencyDashboard: () => ({
    data: state.dashboard,
    isLoading: false,
    refetch: refetchDashboard,
  }),
  useGetAgencySettings: () => ({
    data: state.settings,
    isLoading: false,
    refetch: refetchSettings,
  }),
  useUpdateAgencySettings: () => ({ mutate: vi.fn() }),
  useGetTenantActivity: () => ({
    data: state.activity,
    isLoading: false,
    refetch: refetchActivity,
  }),
  getTenantActivity: vi.fn(),
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

beforeEach(() => {
  state.dashboard = goodDashboard;
  state.settings = goodSettings;
  state.activity = goodActivity;
  refetchDashboard.mockClear();
  refetchSettings.mockClear();
  refetchActivity.mockClear();
});

describe('Dashboard partial failures', () => {
  it('renders settings-driven sections and an inline error card when only the dashboard query fails', () => {
    state.dashboard = undefined;
    renderDashboard();

    // Failed section: inline error card with a working Retry.
    const errorCard = screen.getByTestId('error-agency-dashboard');
    expect(errorCard).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('error-agency-dashboard-retry'));
    expect(refetchDashboard).toHaveBeenCalledTimes(1);

    // Loaded sections still render.
    expect(screen.getByText('Global Resale Markup')).toBeInTheDocument();
    expect(screen.getByText('System Information')).toBeInTheDocument();
    expect(screen.getByText('Event 1')).toBeInTheDocument();

    // Dashboard-driven sections are absent, not crashed.
    expect(screen.queryByTestId('card-revenue-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-full-error')).not.toBeInTheDocument();
  });

  it('renders dashboard sections and an inline error card when only the settings query fails', () => {
    state.settings = undefined;
    renderDashboard();

    const errorCard = screen.getByTestId('error-agency-settings');
    expect(errorCard).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('error-agency-settings-retry'));
    expect(refetchSettings).toHaveBeenCalledTimes(1);

    // Dashboard-driven sections still render.
    expect(screen.getByTestId('card-revenue-summary')).toBeInTheDocument();
    expect(screen.getByTestId('text-monthly-profit')).toHaveTextContent('$350');
    expect(screen.getByText('Event 1')).toBeInTheDocument();

    // Settings-driven sections are absent, not crashed.
    expect(screen.queryByText('Global Resale Markup')).not.toBeInTheDocument();
    expect(screen.queryByText('System Information')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-full-error')).not.toBeInTheDocument();
  });
});

describe('Dashboard full failure', () => {
  it('shows a full-page error whose Retry refetches both queries when both fail', () => {
    state.dashboard = undefined;
    state.settings = undefined;
    renderDashboard();

    expect(screen.getByTestId('dashboard-full-error')).toBeInTheDocument();
    expect(screen.queryByText(/^Failed to load dashboard$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dashboard-full-error-retry'));
    expect(refetchDashboard).toHaveBeenCalledTimes(1);
    expect(refetchSettings).toHaveBeenCalledTimes(1);
  });
});

describe('Activity feed isolation', () => {
  it('shows a local error with retry when the feed fails, without affecting other sections', () => {
    state.activity = undefined;
    renderDashboard();

    expect(screen.getByTestId('error-activity-feed')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('error-activity-feed-retry'));
    expect(refetchActivity).toHaveBeenCalledTimes(1);

    // The rest of the dashboard is unaffected.
    expect(screen.getByTestId('card-revenue-summary')).toBeInTheDocument();
    expect(screen.getByText('Global Resale Markup')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-full-error')).not.toBeInTheDocument();
  });
});

describe('Dashboard error boundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // React logs caught render errors; keep test output clean.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('catches a render-time crash and shows a recoverable fallback instead of a white screen', () => {
    // An unexpected data shape: revenueByCategory access throws at render.
    state.dashboard = { ...goodDashboard, revenueByCategory: null as unknown as [] };
    // StatCard values call .toString() on these — force a render crash.
    state.dashboard.activeTenants = null as unknown as number;
    renderDashboard();

    expect(screen.getByTestId('dashboard-error-boundary')).toBeInTheDocument();

    // "Try again" re-mounts; with data fixed, the dashboard renders again.
    state.dashboard = goodDashboard;
    fireEvent.click(screen.getByTestId('dashboard-error-boundary-retry'));
    expect(screen.queryByTestId('dashboard-error-boundary')).not.toBeInTheDocument();
    expect(screen.getByTestId('card-revenue-summary')).toBeInTheDocument();
  });
});
