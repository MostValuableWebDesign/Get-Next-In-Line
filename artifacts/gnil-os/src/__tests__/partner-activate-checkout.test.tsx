/**
 * Partner tabs' "Activate Module" guard:
 *  - each of the four partner placeholder cards (Deel, Gusto, Next Insurance,
 *    Guideline) resolves its backing marketplace module by name and opens the
 *    shared CheckoutSimulationDialog locked to that module — no dead-end
 *    "Coming soon" toast;
 *  - when the backing module is missing or inactive the button is disabled
 *    ("Module Unavailable") instead of opening a broken checkout.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { StaticPlaceholderPage } from '@/components/static-page';

const PARTNER_MODULES = [
  'Global Team & HR Management',
  'Integrated W-2 & Contractor Payroll',
  'Small Business Insurance & COI',
  '401(k) & Employee Benefits',
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
modules.push({
  id: 90,
  name: 'Retired Partner Module',
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
  { title: 'Team Management', moduleName: PARTNER_MODULES[0], moduleId: 20 },
  { title: 'Payroll & Compliance', moduleName: PARTNER_MODULES[1], moduleId: 21 },
  { title: 'Business Protection', moduleName: PARTNER_MODULES[2], moduleId: 22 },
  { title: 'Employee Benefits', moduleName: PARTNER_MODULES[3], moduleId: 23 },
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

  it('disables the button when the matching module is inactive', () => {
    render(
      <StaticPlaceholderPage
        title="Retired Service"
        description="desc"
        partner="Old Partner"
        features={['A']}
        moduleName="Retired Partner Module"
      />,
    );
    const btn = screen.getByTestId('btn-activate-retired-service');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Module Unavailable');
  });
});
