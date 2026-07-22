/**
 * Module console page:
 *  - renders name, description, category badge, and markup-based resale price
 *    for regular modules;
 *  - shows the "Partner Direct (0% Markup)" badge (no price / no provision
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
  useGetAdminModuleDetail: () => ({ data: undefined, isLoading: false, isError: true }),
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
  });

  it('renders module details with markup-based resale price for a regular module', () => {
    renderConsole('/modules/1');

    expect(screen.getByTestId('text-module-name')).toHaveTextContent('Smart Booking System');
    expect(screen.getByTestId('text-module-description')).toHaveTextContent('Intelligent customer scheduling engine.');
    expect(screen.getByText('Operations')).toBeInTheDocument();
    // resale = 149 * 1.5 = 223.50, driven by live markup
    expect(screen.getByTestId('text-resale-price')).toHaveTextContent('$224');
    expect(screen.getByText(/Resale Price w\/ 50% Markup/)).toBeInTheDocument();
    // status panel
    expect(screen.getByTestId('text-active-tenants')).toHaveTextContent('1 Active Subdomains');
    expect(screen.getByTestId('text-markup-percent')).toHaveTextContent('+50% Agency Markup');
    expect(screen.getByTestId('button-provision-module')).toBeInTheDocument();
    expect(screen.queryByTestId('badge-partner-direct')).not.toBeInTheDocument();
  });

  it('shows Partner Direct badge instead of a price for partner modules', () => {
    renderConsole('/modules/2');

    expect(screen.getByTestId('text-module-name')).toHaveTextContent('Group Health Insurance Hub');
    expect(screen.getByTestId('badge-partner-direct')).toHaveTextContent('Partner Direct (0% Markup)');
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
