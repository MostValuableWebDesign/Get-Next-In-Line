/**
 * Module console page:
 *  - renders name, description, category badge, retail price, and profit
 *    margin for regular modules (wholesale figures never rendered);
 *  - shows the "Partner Direct" badge (no price / no provision
 *    button) for partner modules;
 *  - single-module provisioning flow (shared CheckoutSimulationDialog): pick a
 *    tenant, run, checkout is called with just this module, and a success
 *    toast fires.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router, Route } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import ModuleConsole from '@/pages/ModuleConsole';
import { Toaster } from '@/components/ui/toaster';
import { downloadModuleLedgerCsv } from '@/lib/moduleLedgerExport';

vi.mock('@/lib/moduleLedgerExport', () => ({
  downloadModuleLedgerCsv: vi.fn(() => 'smart-booking-system-ledger-2026-07-22.csv'),
}));

const modules = [
  {
    id: 1,
    name: 'Smart Booking System',
    category: 'Operations',
    categorySlug: 'operations',
    description: 'Intelligent customer scheduling engine.',
    isActive: true,
    wholesalePrice: 149,
  },
  {
    id: 2,
    name: 'Group Health Insurance Hub',
    category: 'Partners',
    categorySlug: 'partners',
    description: 'Group benefits administration console.',
    isActive: true,
    wholesalePrice: 0,
  },
];

const pricing = [
  { id: 1, name: 'Smart Booking System', category: 'Operations', wholesalePrice: 149, resalePrice: 223.5, markupPercent: 50, margin: 74.5 },
  { id: 2, name: 'Group Health Insurance Hub', category: 'Partners', wholesalePrice: 0, resalePrice: 0, markupPercent: 50, margin: 0 },
];

const tenants = [
  { id: 10, brandName: 'Apex Salon', subdomain: 'apex', status: 'active', mrr: 1450, modulesEnabled: 3, plan: 'Enterprise', createdAt: '2026-01-01T00:00:00Z' },
  { id: 11, brandName: 'Metro Clinics', subdomain: 'metro', status: 'suspended', mrr: 850, modulesEnabled: 2, plan: 'Standard', createdAt: '2026-01-01T00:00:00Z' },
];

const settings = { markupPercent: 50, platformName: 'GNIL', deploymentMode: 'live', updatedAt: '2026-01-01T00:00:00Z' };

const tenantCounts = [
  { moduleId: 1, activeTenantCount: 1 },
  { moduleId: 2, activeTenantCount: 0 },
];

const moduleTenants: Record<number, Array<{ tenantId: number; brandName: string; subdomain: string; status: string; provisionedAt: string }>> = {
  1: [
    { tenantId: 10, brandName: 'Apex Salon', subdomain: 'apex', status: 'active', provisionedAt: '2026-03-15T00:00:00Z' },
    { tenantId: 11, brandName: 'Metro Clinics', subdomain: 'metro', status: 'suspended', provisionedAt: '2026-04-02T00:00:00Z' },
  ],
  2: [],
};

const mutateMock = vi.fn();

// Mutable admin module-detail response: undefined simulates a non-admin
// session (query errors); set to a detail object to simulate an admin.
let adminDetailData: Record<string, unknown> | undefined;

vi.mock('@workspace/api-client-react', () => ({
  useListModules: () => ({ data: modules, isLoading: false }),
  useGetModulesPricing: () => ({ data: pricing, isLoading: false }),
  useGetAgencySettings: () => ({ data: settings, isLoading: false }),
  useListTenants: () => ({ data: tenants, isLoading: false }),
  useGetModuleTenantCounts: () => ({ data: tenantCounts, isLoading: false }),
  getGetModuleTenantCountsQueryKey: () => ['tenant-counts'],
  useGetModuleTenants: (id: number) => ({ data: moduleTenants[id] ?? [], isLoading: false }),
  getGetModuleTenantsQueryKey: (id: number) => ['module-tenants', id],
  // Non-admin case: the admin module-detail query errors, so the merged page
  // hides the connector-mapping section.
  useGetAdminModuleDetail: () => ({ data: adminDetailData, isLoading: false, isError: adminDetailData === undefined }),
  getGetAdminModuleDetailQueryKey: (id: number) => ['admin-module-detail', id],
  useSimulateCheckout: () => ({ mutate: mutateMock, isPending: false }),
  getListTenantsQueryKey: () => ['tenants'],
  getGetBillingSummaryQueryKey: () => ['billing'],
  getGetAgencyDashboardQueryKey: () => ['dashboard'],
  getGetTenantActivityQueryKey: () => ['activity'],
  getGetModulesPricingQueryKey: () => ['pricing'],
  useHealthCheck: () => ({ data: { status: 'ok' }, isError: false, isFetched: true }),
  getHealthCheckQueryKey: () => ['health'],
}));

function renderConsole(path: string) {
  const { hook } = memoryLocation({ path });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <Route path="/modules/:id" component={ModuleConsole} />
      </Router>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe('ModuleConsole', () => {
  beforeEach(() => {
    mutateMock.mockReset();
    vi.mocked(downloadModuleLedgerCsv).mockClear();
    adminDetailData = undefined;
  });

  it('hides the admin connector jump and section for non-admin sessions', () => {
    renderConsole('/modules/1');

    expect(screen.queryByTestId('link-admin-connector-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('section-admin-connector')).not.toBeInTheDocument();
  });

  it('shows a one-click jump to the connector section for admin sessions', () => {
    adminDetailData = {
      wholesalePrice: 149,
      resalePrice: 223.5,
      resalePriceBiweekly: null,
      markupPercent: 50,
      mapping: {
        id: 1,
        slug: 'smart-booking',
        upstreamVendor: 'Acme',
        hiddenConnector: 'acme-booking',
        proxyNotes: null,
        isActive: true,
      },
      activity: [],
    };

    renderConsole('/modules/1');

    const section = screen.getByTestId('section-admin-connector');
    expect(section).toHaveAttribute('id', 'admin-connector-section');

    const scrollSpy = vi.fn();
    section.scrollIntoView = scrollSpy;

    fireEvent.click(screen.getByTestId('link-admin-connector-view'));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('renders module details with markup-based resale price for a regular module', () => {
    renderConsole('/modules/1');

    expect(screen.getByTestId('text-module-name')).toHaveTextContent('Smart Booking System');
    expect(screen.getByTestId('text-module-description')).toHaveTextContent('Intelligent customer scheduling engine.');
    expect(screen.getByText('Operations')).toBeInTheDocument();
    // retail = 149 * 1.5 = 223.50, driven by live markup
    expect(screen.getByTestId('text-resale-price')).toHaveTextContent('$224');
    expect(screen.getByText('Retail Price')).toBeInTheDocument();
    // profit margin shown; wholesale figures never rendered
    expect(screen.getByTestId('text-profit-margin')).toHaveTextContent('+$75/mo profit (33%)');
    expect(screen.queryByText(/[Ww]holesale/)).not.toBeInTheDocument();
    // status panel
    expect(screen.getByTestId('text-active-tenants')).toHaveTextContent('1 Active Subdomains');
    expect(screen.getByTestId('text-markup-percent')).toHaveTextContent('+50% Profit Margin');
    expect(screen.getByTestId('button-provision-module')).toBeInTheDocument();
    expect(screen.queryByTestId('badge-partner-direct')).not.toBeInTheDocument();
  });

  it('shows the Partner Direct (0% Markup) badge and pass-through margin for partner modules', () => {
    renderConsole('/modules/2');

    expect(screen.getByTestId('text-module-name')).toHaveTextContent('Group Health Insurance Hub');
    expect(screen.getByTestId('badge-partner-direct')).toHaveTextContent('Partner Direct (0% Markup)');
    expect(screen.getByTestId('text-markup-percent')).toHaveTextContent('Pass-through · 0% markup');
    expect(screen.queryByTestId('text-resale-price')).not.toBeInTheDocument();
    expect(screen.queryByTestId('button-provision-module')).not.toBeInTheDocument();
  });

  it('lists subscribed tenants with status and links to the tenant roster', () => {
    renderConsole('/modules/1');

    const list = screen.getByTestId('list-module-subscribers');
    expect(list).toBeInTheDocument();

    const apex = screen.getByTestId('link-subscriber-10');
    expect(apex).toHaveTextContent('Apex Salon');
    expect(apex).toHaveTextContent('apex');
    expect(apex).toHaveTextContent('active');
    expect(apex).toHaveAttribute('href', '/tenants/10');

    const metro = screen.getByTestId('link-subscriber-11');
    expect(metro).toHaveTextContent('Metro Clinics');
    expect(metro).toHaveTextContent('suspended');

    expect(screen.queryByTestId('text-no-subscribers')).not.toBeInTheDocument();
  });

  it('shows an empty state when no tenants subscribe to the module', () => {
    renderConsole('/modules/2');

    expect(screen.getByTestId('text-no-subscribers')).toHaveTextContent('No tenants are subscribed to this module yet.');
    expect(screen.queryByTestId('list-module-subscribers')).not.toBeInTheDocument();
  });

  it('renders a not-found state for an unknown module id', () => {
    renderConsole('/modules/999');
    expect(screen.getByText(/module not found/i)).toBeInTheDocument();
  });

  it('provisions a single module for the selected tenant and shows a success toast', async () => {
    mutateMock.mockImplementation((_vars, opts) => {
      opts?.onSuccess?.({ success: true, transactionId: 'txn_abc123', totalWholesale: 149, totalResale: 223.5, margin: 74.5, modulesProvisioned: 1, message: 'ok' });
    });

    renderConsole('/modules/1');

    fireEvent.click(screen.getByTestId('button-provision-module'));

    // Confirm disabled until a tenant is chosen
    expect(screen.getByTestId('button-run-transaction')).toBeDisabled();

    fireEvent.click(screen.getByTestId('select-checkout-tenant'));
    fireEvent.click(await screen.findByRole('option', { name: 'Apex Salon' }));

    // Order summary shows the module's resale price as the total charge
    expect(screen.getByText('Total Charge')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('button-run-transaction'));

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0][0]).toEqual({
      data: { tenantId: 10, moduleIds: [1], applyMarkup: true },
    });

    await waitFor(() => {
      expect(screen.getByText('Checkout Simulation Successful')).toBeInTheDocument();
    });
    expect(screen.getByText(/txn_abc123/)).toBeInTheDocument();
  });

  it('force sync refetches data and shows a completion toast', async () => {
    renderConsole('/modules/1');

    fireEvent.click(screen.getByTestId('button-force-sync'));

    await waitFor(() => {
      expect(screen.getByText('Sync Complete')).toBeInTheDocument();
    });
    expect(screen.getByText(/Refreshed module and tenant data for Smart Booking System/)).toBeInTheDocument();
  });

  it('exports a CSV ledger of subscribed tenants', async () => {
    renderConsole('/modules/1');

    fireEvent.click(screen.getByTestId('button-export-ledger'));

    expect(downloadModuleLedgerCsv).toHaveBeenCalledTimes(1);
    const [name, rows] = vi.mocked(downloadModuleLedgerCsv).mock.calls[0];
    expect(name).toBe('Smart Booking System');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenantId: 10, brandName: 'Apex Salon', cadence: 'monthly' });

    await waitFor(() => {
      expect(screen.getByText('Export Downloaded')).toBeInTheDocument();
    });
  });

  it('shows a nothing-to-export toast when the module has no subscribers', async () => {
    renderConsole('/modules/2');

    fireEvent.click(screen.getByTestId('button-export-ledger'));

    expect(downloadModuleLedgerCsv).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('Nothing to Export')).toBeInTheDocument();
    });
  });

  it('shows an error toast when provisioning fails', async () => {
    mutateMock.mockImplementation((_vars, opts) => {
      opts?.onError?.(new Error('boom'));
    });

    renderConsole('/modules/1');
    fireEvent.click(screen.getByTestId('button-provision-module'));
    fireEvent.click(screen.getByTestId('select-checkout-tenant'));
    fireEvent.click(await screen.findByRole('option', { name: 'Apex Salon' }));
    fireEvent.click(screen.getByTestId('button-run-transaction'));

    await waitFor(() => {
      expect(screen.getByText('Checkout simulation failed')).toBeInTheDocument();
    });
  });
});
