/**
 * Partner tabs' "Activate Module" guard:
 *  - each partner placeholder card (Gusto — which now carries the
 *    consolidated payroll + 401(k)/benefits offering — and Next Insurance)
 *    resolves its backing marketplace module by name and opens the shared
 *    CheckoutSimulationDialog locked to that module — no dead-end
 *    "Coming soon" toast;
 *  - when the backing module is missing or inactive (e.g. a soft-retired
 *    partner module) the button is disabled ("Module Unavailable") instead
 *    of opening a broken checkout.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { StaticPlaceholderPage } from '@/components/static-page';

const PARTNER_MODULES = [
  'Payroll, 401(k) & Employee Benefits',
  'Small Business Insurance & COI',
];

// Tenant-safe /api/modules shape: no machine slug is exposed.
const modules = PARTNER_MODULES.map((name, i) => ({
  id: 20 + i,
  name,
  category: 'Partner Integrations',
  categorySlug: 'partners',
  description: `${name} description`,
  isActive: true,
  wholesalePrice: 0,
}));
// Soft-retired partner module: the row survives inactive so history stays
// intact, but it must never activate.
modules.push({
  id: 90,
  name: 'Legacy Retired Offering',
  category: 'Partner Integrations',
  categorySlug: 'partners',
  description: 'inactive',
  isActive: false,
  wholesalePrice: 0,
});

vi.mock('@workspace/api-client-react', () => ({
  useListModules: () => ({ data: modules, isLoading: false }),
}));

// The dialog itself has its own heavy data deps; assert the props it gets.
vi.mock('@/components/checkout/CheckoutSimulationDialog', () => ({
  CheckoutSimulationDialog: ({ open, lockedModuleId, title }: {
    open: boolean; lockedModuleId?: number; title: string;
  }) =>
    open ? (
      <div data-testid="checkout-dialog" data-locked-module={lockedModuleId}>
        {title}
      </div>
    ) : null,
}));

const CARDS: Array<{ title: string; moduleName: string; moduleId: number }> = [
  { title: 'Payroll, Benefits & 401(k)', moduleName: PARTNER_MODULES[0], moduleId: 20 },
  { title: 'Business Protection', moduleName: PARTNER_MODULES[1], moduleId: 21 },
];

describe('partner placeholder Activate Module', () => {
  it.each(CARDS)('$title opens checkout locked to its module', async ({ title, moduleName, moduleId }) => {
    render(
      <StaticPlaceholderPage
        title={title}
        description="desc"
        partner="Partner"
        features={['A', 'B']}
        moduleName={moduleName}
      />,
    );
    const btn = screen.getByTestId(`btn-activate-${title.toLowerCase().replace(/\s+/g, '-')}`);
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('Activate Module');
    expect(screen.queryByTestId('checkout-dialog')).toBeNull();

    await userEvent.click(btn);

    const dialog = screen.getByTestId('checkout-dialog');
    expect(dialog).toHaveAttribute('data-locked-module', String(moduleId));
    expect(dialog).toHaveTextContent(`Activate ${title}`);
  });

  it('disables the button when no matching module exists', () => {
    render(
      <StaticPlaceholderPage
        title="Ghost Service"
        description="desc"
        partner="Nobody"
        features={['A']}
        moduleName="Module That Does Not Exist"
      />,
    );
    const btn = screen.getByTestId('btn-activate-ghost-service');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Module Unavailable');
  });

  it('disables the button when the matching module is inactive (retired partner)', () => {
    render(
      <StaticPlaceholderPage
        title="Retired Service"
        description="desc"
        partner="Old Partner"
        features={['A']}
        moduleName="401(k) & Employee Benefits"
      />,
    );
    const btn = screen.getByTestId('btn-activate-retired-service');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Module Unavailable');
  });
});
