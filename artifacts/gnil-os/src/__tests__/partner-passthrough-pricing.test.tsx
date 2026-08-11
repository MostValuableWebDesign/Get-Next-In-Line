/**
 * Partner Integrations show no pricing wording at all — no cost figures or
 * backend pricing mechanics may appear anywhere they're priced:
 *  - partner module cards show no pricing block, no pass-through text, and no
 *    0% Markup badge;
 *  - the checkout dialog locked to a partner module shows no markup toggle,
 *    no margin/total lines, and no dollar amounts — it reads as a partner
 *    activation;
 *  - non-partner modules keep their retail price + profit margin display, and
 *    never render wholesale costs or pass-through wording.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const modules = [
  {
    id: 20,
    name: 'Payroll, 401(k) & Employee Benefits',
    category: 'Partner Integrations',
    categorySlug: 'partners',
    description: 'partner module',
    isActive: true,
    wholesalePrice: 0,
  },
  {
    id: 1,
    name: 'Smart Booking System',
    category: 'Core Service Modules',
    categorySlug: 'operations',
    description: 'ops module',
    isActive: true,
    wholesalePrice: 100,
  },
];

const pricing = [
  { id: 20, name: modules[0].name, category: modules[0].category, wholesalePrice: 0, resalePrice: 0, markupPercent: 0, margin: 0 },
  { id: 1, name: modules[1].name, category: modules[1].category, wholesalePrice: 100, resalePrice: 150, markupPercent: 50, margin: 50 },
];

// Mutable so tests can simulate one query resolved while the other loads.
let modulesState: { data: typeof modules | undefined; isLoading: boolean } = {
  data: modules,
  isLoading: false,
};
let pricingState: { data: typeof pricing | undefined; isLoading: boolean } = {
  data: pricing,
  isLoading: false,
};

vi.mock('@workspace/api-client-react', () => ({
  useListModules: () => modulesState,
  useGetModulesPricing: () => pricingState,
  useListTenants: () => ({ data: [{ id: 1, brandName: 'Tenant One' }], isLoading: false }),
  useSimulateCheckout: () => ({ mutate: vi.fn(), isPending: false }),
  getListTenantsQueryKey: () => ['tenants'],
  getGetModuleTenantCountsQueryKey: () => ['counts'],
  getGetModuleTenantsQueryKey: (id: number) => ['module-tenants', id],
  getGetBillingSummaryQueryKey: () => ['billing'],
  getGetAgencyDashboardQueryKey: () => ['dashboard'],
  getGetTenantActivityQueryKey: () => ['activity'],
}));

vi.mock('@/hooks/use-online', () => ({
  useIsOffline: () => false,
  useOnlineStatus: () => ({ isOnline: true, settled: true }),
}));

import { ModuleGrid } from '@/components/modules/ModuleGrid';
import { CheckoutSimulationDialog } from '@/components/checkout/CheckoutSimulationDialog';

function renderWithRouter(ui: React.ReactElement) {
  const { hook } = memoryLocation({ path: '/partners' });
  return render(<Router hook={hook}>{ui}</Router>);
}

function renderDialog(lockedModuleId: number, title: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CheckoutSimulationDialog
        open
        onOpenChange={() => {}}
        title={title}
        description="desc"
        lockedModuleId={lockedModuleId}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  modulesState = { data: modules, isLoading: false };
  pricingState = { data: pricing, isLoading: false };
});

describe('partner module cards — no pricing wording', () => {
  it('shows no pricing block, no pass-through text, and no cost figures', () => {
    renderWithRouter(
      <ModuleGrid categorySlug="partners" title="Partner Integrations" description="desc" />,
    );

    const card = screen.getByTestId('link-module-console-20');
    expect(within(card).queryByText('0% Markup')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('passthrough-pricing-20')).not.toBeInTheDocument();
    expect(within(card).queryByText(/Pass-through/)).not.toBeInTheDocument();
    expect(within(card).queryByText('Pricing')).not.toBeInTheDocument();
    expect(within(card).queryByText('Resale')).not.toBeInTheDocument();
    expect(within(card).queryByText('Wholesale Cost')).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/\$\d/);
  });

  it('keeps retail price and profit margin on non-partner cards, without wholesale figures', () => {
    renderWithRouter(
      <ModuleGrid categorySlug="operations" title="Core Operations" description="desc" />,
    );

    const card = screen.getByTestId('link-module-console-1');
    expect(within(card).getByText('Retail Price')).toBeInTheDocument();
    expect(within(card).getByText('Profit Margin')).toBeInTheDocument();
    expect(within(card).getByText('$150')).toBeInTheDocument();
    expect(within(card).getByTestId('margin-1')).toHaveTextContent('+$50/mo (33%)');
    expect(within(card).queryByText('Wholesale Cost')).not.toBeInTheDocument();
    expect(within(card).queryByText('$100/mo')).not.toBeInTheDocument();
    expect(within(card).queryByText(/Pass-through/)).not.toBeInTheDocument();
  });
});

describe('checkout dialog locked to a partner module — partner activation', () => {
  it('hides the markup toggle and all cost figures, with no pass-through wording', () => {
    renderDialog(20, 'Activate Partner Module');

    // No markup toggle — a partner-activation label instead
    expect(screen.queryByLabelText('Apply Retail Pricing')).not.toBeInTheDocument();
    expect(screen.getByTestId('text-partner-activation')).toHaveTextContent('Partner activation');

    // No margin/total lines, no dollar amounts, no backend wording anywhere
    expect(screen.queryByText('Profit Margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Charge')).not.toBeInTheDocument();
    expect(screen.getByTestId('summary-passthrough')).toHaveTextContent(
      'Partner activation — no charge',
    );
    expect(document.body.textContent).not.toMatch(/\$\d/);
    expect(document.body.textContent).not.toMatch(/Pass-through|0% markup|[Ww]holesale/);
  });

  it('keeps the retail toggle, margin, and total for a non-partner module — without wholesale lines', () => {
    renderDialog(1, 'Provision Module');

    expect(screen.getByLabelText('Apply Retail Pricing')).toBeInTheDocument();
    expect(screen.getByText('Profit Margin')).toBeInTheDocument();
    expect(screen.getByText('Total Charge')).toBeInTheDocument();
    expect(screen.queryByText(/[Ww]holesale/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-passthrough')).not.toBeInTheDocument();
  });

  it('shows no cost figures or markup toggle while the module list is still loading', () => {
    // Pricing resolved, modules not yet — partner status is unknown, so no
    // dollar amounts and no markup toggle may render.
    modulesState = { data: undefined, isLoading: true };
    renderDialog(20, 'Activate Partner Module');

    expect(screen.queryByLabelText('Apply Retail Pricing')).not.toBeInTheDocument();
    expect(screen.queryByText('Profit Margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Charge')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('stays in partner-activation mode with no dollar amounts while pricing is still loading', () => {
    // Modules resolved, pricing not yet — the locked partner module must be
    // classified from module metadata, so the dialog never flashes the retail
    // path (markup toggle, $0 margin/total lines) before pricing arrives.
    pricingState = { data: undefined, isLoading: true };
    renderDialog(20, 'Activate Partner Module');

    expect(screen.queryByLabelText('Apply Retail Pricing')).not.toBeInTheDocument();
    expect(screen.getByTestId('text-partner-activation')).toHaveTextContent('Partner activation');
    expect(screen.queryByText('Profit Margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Charge')).not.toBeInTheDocument();
    expect(screen.getByTestId('summary-passthrough')).toHaveTextContent(
      'Partner activation — no charge',
    );
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('shows no dollar amounts or toggle for a locked non-partner module while pricing is loading', () => {
    pricingState = { data: undefined, isLoading: true };
    renderDialog(1, 'Provision Module');

    expect(screen.queryByLabelText('Apply Retail Pricing')).not.toBeInTheDocument();
    expect(screen.queryByText('Profit Margin')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Charge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-passthrough')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });
});
