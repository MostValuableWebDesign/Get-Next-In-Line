/**
 * Partner Integrations pass-through pricing display:
 *  - partner module cards show the Resale / Wholesale Cost pricing block, the
 *    "0% Markup" badge, and the pass-through wording ("Pass-through · 0%
 *    markup", "Billed directly to tenants by the partner — no agency cost or
 *    resale.");
 *  - the checkout dialog locked to a partner module behaves like any other
 *    module: markup toggle, per-module price, Profit Margin and Total Charge
 *    lines (all $0 for a 0-cost partner module);
 *  - non-partner modules keep their retail price + profit margin display and
 *    never render pass-through wording.
 */
import type { ReactElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const modules = [
  {
    id: 20,
    name: 'Global Team & HR Management',
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

vi.mock('@workspace/api-client-react', () => ({
  useListModules: () => ({ data: modules, isLoading: false }),
  useGetModulesPricing: () => ({ data: pricing, isLoading: false }),
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

function renderWithRouter(ui: ReactElement) {
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

describe('partner module cards — pass-through pricing display', () => {
  it('shows the Resale/Wholesale Cost block, 0% Markup badge, and pass-through wording', () => {
    renderWithRouter(
      <ModuleGrid categorySlug="partners" title="Partner Integrations" description="desc" />,
    );

    const card = screen.getByTestId('link-module-console-20');
    expect(within(card).getByText('0% Markup')).toBeInTheDocument();
    expect(within(card).getByText('Resale')).toBeInTheDocument();
    expect(within(card).getByText('Wholesale Cost')).toBeInTheDocument();
    const passthrough = within(card).getByTestId('passthrough-pricing-20');
    expect(passthrough).toHaveTextContent('Pass-through · 0% markup');
    expect(passthrough).toHaveTextContent(
      'Billed directly to tenants by the partner — no agency cost or resale.',
    );
  });

  it('keeps retail price and profit margin on non-partner cards, without pass-through wording', () => {
    renderWithRouter(
      <ModuleGrid categorySlug="operations" title="Core Operations" description="desc" />,
    );

    const card = screen.getByTestId('link-module-console-1');
    expect(within(card).getByText('Retail Price')).toBeInTheDocument();
    expect(within(card).getByText('Profit Margin')).toBeInTheDocument();
    expect(within(card).getByText('$150')).toBeInTheDocument();
    expect(within(card).getByTestId('margin-1')).toHaveTextContent('+$50/mo (33%)');
    expect(within(card).queryByText('0% Markup')).not.toBeInTheDocument();
    expect(within(card).queryByText(/Pass-through/)).not.toBeInTheDocument();
    expect(within(card).queryByTestId('passthrough-pricing-1')).not.toBeInTheDocument();
  });
});

describe('checkout dialog locked to a partner module — standard pricing flow', () => {
  it('shows the markup toggle, module price, and margin/total lines', () => {
    renderDialog(20, 'Activate Partner Module');

    // Same flow as any other module — markup toggle and summary lines render
    expect(screen.getByLabelText('Apply Retail Pricing')).toBeInTheDocument();
    expect(screen.getByText('Profit Margin')).toBeInTheDocument();
    expect(screen.getByText('Total Charge')).toBeInTheDocument();
    // 0-cost partner module: totals are $0
    expect(screen.getByText('+$0')).toBeInTheDocument();
    // No partner-activation special-casing remains
    expect(screen.queryByTestId('text-partner-activation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('summary-passthrough')).not.toBeInTheDocument();
  });

  it('keeps the retail toggle, margin, and total for a non-partner module', () => {
    renderDialog(1, 'Provision Module');

    expect(screen.getByLabelText('Apply Retail Pricing')).toBeInTheDocument();
    expect(screen.getByText('Profit Margin')).toBeInTheDocument();
    expect(screen.getByText('Total Charge')).toBeInTheDocument();
    expect(screen.queryByTestId('summary-passthrough')).not.toBeInTheDocument();
  });
});
