/**
 * Billing page multi-module checkout (CheckoutSimulationModal →
 * CheckoutSimulationDialog with no locked module):
 *  - tenant and multi-module selection;
 *  - order-summary totals with and without agency markup;
 *  - successful checkout calls the mutation with all picked modules and
 *    shows a success toast;
 *  - error path shows a destructive toast and keeps selections.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Billing from '@/pages/Billing';
import { Toaster } from '@/components/ui/toaster';

const pricing = [
  { id: 1, name: 'Smart Booking System', category: 'Operations', wholesalePrice: 149, resalePrice: 223.5, markupPercent: 50, margin: 74.5 },
  { id: 2, name: 'AI Receptionist', category: 'Communications', wholesalePrice: 99, resalePrice: 148.5, markupPercent: 50, margin: 49.5 },
  { id: 3, name: 'Group Health Insurance Hub', category: 'Partners', wholesalePrice: 0, resalePrice: 0, markupPercent: 50, margin: 0 },
];

const tenants = [
  { id: 10, brandName: 'Apex Salon', subdomain: 'apex', status: 'active', mrr: 1450, modulesEnabled: 3, plan: 'Enterprise', createdAt: '2026-01-01T00:00:00Z' },
  { id: 11, brandName: 'Metro Clinics', subdomain: 'metro', status: 'suspended', mrr: 850, modulesEnabled: 2, plan: 'Standard', createdAt: '2026-01-01T00:00:00Z' },
];

const summary = {
  totalMrr: 2300,
  byCategory: [
    { category: 'Operations', mrr: 1450 },
    { category: 'Communications', mrr: 850 },
  ],
  topTenants: [
    { tenantId: 10, brandName: 'Apex Salon', mrr: 1450 },
    { tenantId: 11, brandName: 'Metro Clinics', mrr: 850 },
  ],
};

const mutateMock = vi.fn();

// Module list backing partner classification. Mutable so tests can simulate
// "pricing loaded, modules still loading" — Billing must not render pricing
// figures until partner status is known.
const moduleList = [
  { id: 1, name: 'Smart Booking System', category: 'Operations', categorySlug: 'operations', description: '', isActive: true, wholesalePrice: 149 },
  { id: 2, name: 'AI Receptionist', category: 'Communications', categorySlug: 'communications', description: '', isActive: true, wholesalePrice: 99 },
  { id: 3, name: 'Group Health Insurance Hub', category: 'Partners', categorySlug: 'partners', description: '', isActive: true, wholesalePrice: 0 },
];
let modulesState: { data: typeof moduleList | undefined; isLoading: boolean } = {
  data: moduleList,
  isLoading: false,
};

vi.mock('@workspace/api-client-react', () => ({
  useGetBillingSummary: () => ({ data: summary, isLoading: false }),
  useGetModulesPricing: () => ({ data: pricing, isLoading: false }),
  useListTenants: () => ({ data: tenants, isLoading: false }),
  useListModules: () => modulesState,
  useSimulateCheckout: () => ({ mutate: mutateMock, isPending: false }),
  getListTenantsQueryKey: () => ['tenants'],
  getGetModuleTenantCountsQueryKey: () => ['tenant-counts'],
  getGetModuleTenantsQueryKey: (id: number) => ['module-tenants', id],
  getGetBillingSummaryQueryKey: () => ['billing'],
  getGetAgencyDashboardQueryKey: () => ['dashboard'],
  getGetTenantActivityQueryKey: () => ['activity'],
  getGetModulesPricingQueryKey: () => ['pricing'],
  useHealthCheck: () => ({ data: { status: 'ok' }, isError: false, isFetched: true }),
  getHealthCheckQueryKey: () => ['health'],
}));

function renderBilling() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Billing />
      <Toaster />
    </QueryClientProvider>,
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: /simulate checkout/i }));
  return screen.getByRole('dialog');
}

function moduleRow(dialog: HTMLElement, name: string) {
  // A selected module's name also appears in the order summary, so pick the
  // occurrence inside the selectable list (its rows have a .p-2 wrapper).
  const label = within(dialog)
    .getAllByText(name)
    .find(el => el.closest('.p-2'));
  if (!label) throw new Error(`Module row not found: ${name}`);
  return label.closest('.p-2') as HTMLElement;
}

function pickModule(dialog: HTMLElement, name: string) {
  // Click the module name (row click handler); clicking the checkbox itself
  // would fire onCheckedChange AND bubble to the row onClick — a double toggle.
  fireEvent.click(within(moduleRow(dialog, name)).getByText(name));
}

async function pickTenant(name: string) {
  fireEvent.click(screen.getByTestId('select-checkout-tenant'));
  fireEvent.click(await screen.findByRole('option', { name }));
}

describe('Billing checkout simulation', () => {
  beforeEach(() => {
    mutateMock.mockReset();
    modulesState = { data: moduleList, isLoading: false };
  });

  it('shows pass-through instead of cost figures for partner modules in the pricing matrix', () => {
    renderBilling();

    expect(screen.getByTestId('pricing-passthrough-3')).toHaveTextContent('Pass-through · 0% markup');
    // Non-partner rows keep their figures (formatCurrency rounds to 0 digits)
    expect(screen.getByText('$224')).toBeInTheDocument();
    expect(screen.getAllByText('$149').length).toBeGreaterThan(0);
  });

  it('keeps the loading skeleton until the module list resolves so partner rows never flash costs', () => {
    modulesState = { data: undefined, isLoading: true };
    renderBilling();

    expect(screen.queryByText('Module Pricing Matrix')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('renders the pricing matrix and MRR summary', () => {
    renderBilling();

    expect(screen.getByText('Module Pricing Matrix')).toBeInTheDocument();
    expect(screen.getByText('Smart Booking System')).toBeInTheDocument();
    expect(screen.getByText('Total MRR')).toBeInTheDocument();
    expect(screen.getByText('$2,300')).toBeInTheDocument();
  });

  it('opens the checkout dialog with all modules selectable and none preselected', () => {
    renderBilling();
    const dialog = openDialog();

    expect(within(dialog).getByText('Stripe Checkout Simulation')).toBeInTheDocument();
    expect(within(dialog).getByText('2. Select Modules')).toBeInTheDocument();
    expect(within(dialog).getByText('No modules selected')).toBeInTheDocument();
    // All three modules listed, checkboxes enabled (multi-select, not locked)
    for (const p of pricing) {
      const row = moduleRow(dialog, p.name);
      expect(within(row).getByRole('checkbox')).not.toBeDisabled();
    }
    expect(screen.getByTestId('button-run-transaction')).toBeDisabled();
  });

  it('sums order-summary totals across multiple selected modules with markup', () => {
    renderBilling();
    const dialog = openDialog();

    pickModule(dialog, 'Smart Booking System');
    pickModule(dialog, 'AI Receptionist');

    // Resale total: 223.50 + 148.50 = 372, margin 74.50 + 49.50 = 124, wholesale 248
    expect(within(dialog).getByText('$372')).toBeInTheDocument();
    expect(within(dialog).getByText('+$124')).toBeInTheDocument();
    expect(within(dialog).getByText('$248')).toBeInTheDocument();
  });

  it('charges wholesale prices and zero margin when markup is unchecked', () => {
    renderBilling();
    const dialog = openDialog();

    pickModule(dialog, 'Smart Booking System');
    pickModule(dialog, 'AI Receptionist');

    fireEvent.click(within(dialog).getByLabelText('Apply Agency Markup'));

    // Total charge = wholesale 149 + 99 = 248, margin 0
    const totalRow = within(dialog).getByText('Total Charge').parentElement as HTMLElement;
    expect(within(totalRow).getByText('$248')).toBeInTheDocument();
    expect(within(dialog).getByText('+$0')).toBeInTheDocument();
  });

  it('deselecting a module removes it from the order summary total', () => {
    renderBilling();
    const dialog = openDialog();

    pickModule(dialog, 'Smart Booking System');
    pickModule(dialog, 'AI Receptionist');
    pickModule(dialog, 'AI Receptionist'); // toggle off

    const totalRow = within(dialog).getByText('Total Charge').parentElement as HTMLElement;
    expect(within(totalRow).getByText('$224')).toBeInTheDocument();
  });

  it('runs a multi-module checkout and shows a success toast', async () => {
    mutateMock.mockImplementation((_vars, opts) => {
      opts?.onSuccess?.({ success: true, transactionId: 'txn_multi42', totalWholesale: 248, totalResale: 372, margin: 124, modulesProvisioned: 2, message: 'ok' });
    });

    renderBilling();
    const dialog = openDialog();

    pickModule(dialog, 'Smart Booking System');
    pickModule(dialog, 'AI Receptionist');
    await pickTenant('Apex Salon');

    const runButton = screen.getByTestId('button-run-transaction');
    expect(runButton).not.toBeDisabled();
    fireEvent.click(runButton);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0][0]).toEqual({
      data: { tenantId: 10, moduleIds: [1, 2], applyMarkup: true },
    });

    await waitFor(() => {
      expect(screen.getByText('Checkout Simulation Successful')).toBeInTheDocument();
    });
    expect(screen.getByText(/txn_multi42/)).toBeInTheDocument();
    expect(screen.getByText(/\$372/)).toBeInTheDocument();
  });

  it('sends applyMarkup: false when markup is unchecked', async () => {
    mutateMock.mockImplementation((_vars, opts) => {
      opts?.onSuccess?.({ success: true, transactionId: 'txn_nomarkup', totalWholesale: 149, totalResale: 149, margin: 0, modulesProvisioned: 1, message: 'ok' });
    });

    renderBilling();
    const dialog = openDialog();

    pickModule(dialog, 'Smart Booking System');
    fireEvent.click(within(dialog).getByLabelText('Apply Agency Markup'));
    await pickTenant('Metro Clinics');

    fireEvent.click(screen.getByTestId('button-run-transaction'));

    expect(mutateMock.mock.calls[0][0]).toEqual({
      data: { tenantId: 11, moduleIds: [1], applyMarkup: false },
    });
  });

  it('keeps run disabled until both a tenant and at least one module are chosen', async () => {
    renderBilling();
    const dialog = openDialog();

    // Tenant only, no modules
    await pickTenant('Apex Salon');
    expect(screen.getByTestId('button-run-transaction')).toBeDisabled();

    pickModule(dialog, 'Smart Booking System');
    expect(screen.getByTestId('button-run-transaction')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('button-run-transaction'));
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it('shows an error toast and keeps selections when checkout fails', async () => {
    mutateMock.mockImplementation((_vars, opts) => {
      opts?.onError?.(new Error('boom'));
    });

    renderBilling();
    const dialog = openDialog();

    pickModule(dialog, 'Smart Booking System');
    await pickTenant('Apex Salon');
    fireEvent.click(screen.getByTestId('button-run-transaction'));

    await waitFor(() => {
      expect(screen.getByText('Checkout simulation failed')).toBeInTheDocument();
    });
    expect(screen.getByText(/selections are still here/i)).toBeInTheDocument();
    // Dialog stays open with the module still selected
    const totalRow = within(dialog).getByText('Total Charge').parentElement as HTMLElement;
    expect(within(totalRow).getByText('$224')).toBeInTheDocument();
    expect(screen.getByTestId('button-run-transaction')).not.toBeDisabled();
  });
});
