/**
 * Core Operations marketplace lock (frontend):
 *  - the five advanced service modules render in the "Core Operations" grid
 *    on the Operations hub, with wholesale cost and computed resale price;
 *  - they never appear as sidebar tabs — the sidebar is exactly the known
 *    admin + daily-workflow entries;
 *  - daily-workflow pages (Business Bookings, Calendar, POS, Marketing &
 *    Comms) never reference the modules or their pricing/setup controls
 *    (source-scan guard).
 */
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const OPERATIONS_MODULES = [
  'Commission & Split Tracker',
  'Complete Payroll & Tax Suite',
  'No-Show Shield & Deposits',
  'Service Payroll Hub',
  'Smart Booking System',
];

const modules = OPERATIONS_MODULES.map((name, i) => ({
  id: i + 1,
  name,
  category: 'Public Core Service Modules',
  categorySlug: 'operations',
  description: `${name} description`,
  isActive: true,
  // Even values so resale (×1.5) stays a whole number — formatCurrency
  // renders with zero fraction digits.
  wholesalePrice: 100 + i * 2,
}));
// A non-operations module that must NOT show in the Core Operations grid
modules.push({
  id: 99,
  name: 'Lead Pipelines & CRM Core',
  category: 'Marketing OS',
  categorySlug: 'marketing',
  description: 'marketing module',
  isActive: true,
  wholesalePrice: 197,
});

const pricing = modules.map((m) => ({
  id: m.id,
  name: m.name,
  category: m.category,
  wholesalePrice: m.wholesalePrice,
  resalePrice: Math.round(m.wholesalePrice * 1.5 * 100) / 100,
  markupPercent: 50,
  margin: Math.round(m.wholesalePrice * 0.5 * 100) / 100,
}));

vi.mock('@workspace/api-client-react', () => ({
  useListModules: () => ({ data: modules, isLoading: false }),
  useGetModulesPricing: () => ({ data: pricing, isLoading: false }),
}));

// The Operations hub pulls in the full SOS operations + partner pages; they
// are irrelevant to marketplace placement, so stub them out.
vi.mock('@/pages/sos/operations', () => ({ OperationsPage: () => <div /> }));
vi.mock('@/components/static-page', () => ({
  StaticPlaceholderPage: () => <div />,
}));

vi.mock('@/hooks/use-online', () => ({
  useOnlineStatus: () => ({ isOnline: true, settled: true }),
}));

import OperationsHub from '@/pages/OperationsHub';
import { Shell } from '@/components/layout/Shell';

describe('Operations hub — Core Operations grid placement', () => {
  it('shows all five service modules under "Core Operations" with retail price and profit margin (no wholesale)', () => {
    const { hook } = memoryLocation({ path: '/operations' });
    render(
      <Router hook={hook}>
        <OperationsHub />
      </Router>,
    );

    expect(screen.getByRole('heading', { name: 'Public Core Service Modules' })).toBeInTheDocument();

    for (const mod of modules.filter((m) => m.categorySlug === 'operations')) {
      const card = screen.getByTestId(`link-module-console-${mod.id}`);
      expect(within(card).getByText(mod.name)).toBeInTheDocument();
      // Retail price and profit margin visible; wholesale cost never rendered
      const price = pricing.find((p) => p.id === mod.id)!;
      expect(within(card).getByText(`$${price.resalePrice}`)).toBeInTheDocument();
      expect(within(card).getByTestId(`margin-${mod.id}`)).toHaveTextContent(`+$${price.margin}/mo`);
      expect(within(card).queryByText('Wholesale Cost')).not.toBeInTheDocument();
      expect(within(card).queryByText(`$${mod.wholesalePrice}/mo`)).not.toBeInTheDocument();
    }

    // Non-operations modules stay out of the Core Operations grid
    expect(screen.queryByText('Lead Pipelines & CRM Core')).not.toBeInTheDocument();
  });
});

describe('Sidebar — service modules never become navigation tabs', () => {
  it('renders exactly the known nav entries and none of the five modules', () => {
    const { hook } = memoryLocation({ path: '/' });
    render(
      <Router hook={hook}>
        <Shell>
          <div />
        </Shell>
      </Router>,
    );

    for (const name of OPERATIONS_MODULES) {
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }

    // Daily-workflow section stays limited to the known entries — the AI
    // Receptionist is now a tab inside Business Bookings, not a sidebar item
    expect(screen.getByText('Business Bookings')).toBeInTheDocument();
    expect(screen.queryByText('AI Receptionist')).not.toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });
});

describe('Daily-workflow pages — no module marketplace leakage (source scan)', () => {
  const PAGES_DIR = path.resolve(__dirname, '../pages/sos');
  const DAILY_WORKFLOW_PAGES = ['bookings.tsx', 'ai-receptionist.tsx'];
  const FORBIDDEN_TOKENS = [
    ...OPERATIONS_MODULES,
    'ModuleGrid',
    'useGetModulesPricing',
    'useSimulateCheckout',
    'wholesalePrice',
    'markupPercent',
  ];

  it.each(DAILY_WORKFLOW_PAGES)('%s contains no module names or pricing/setup controls', (file) => {
    const src = readFileSync(path.join(PAGES_DIR, file), 'utf8');
    const offenders = FORBIDDEN_TOKENS.filter((token) => src.includes(token));
    expect(
      offenders,
      `Daily-workflow page ${file} references module marketplace tokens: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
