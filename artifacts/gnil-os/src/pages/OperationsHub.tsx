import { Link, useLocation } from 'wouter';
import { useListModules } from '@workspace/api-client-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Settings } from 'lucide-react';
import { ModuleGrid } from '@/components/modules/ModuleGrid';
import { StaticPlaceholderPage } from '@/components/static-page';

/**
 * Curated offerings content per partner brand — title + feature list in the
 * style of the original four Partner Services cards. Keyed by the
 * customer-facing `partnerBrand` that /api/modules exposes for the partners
 * category (a deliberate, narrow exception to the white-label contract; no
 * slugs or connector internals appear here).
 */
export const PARTNER_OFFERINGS: Record<
  string,
  { title: string; description: string; features: string[] }
> = {
  Deel: {
    title: 'Team Management',
    description:
      'Manage your entire workforce from a single dashboard. Onboard new staff, track hours, and manage schedules with automated compliance.',
    features: [
      'Automated Onboarding Flows',
      'Time & Attendance Tracking',
      'Shift Scheduling',
      'Performance Reviews',
    ],
  },
  Gusto: {
    title: 'Payroll & Compliance',
    description:
      'Run payroll in minutes. We handle tax filings, W-2s, and 1099s automatically so you can focus on running your business.',
    features: [
      'Next-Day Direct Deposit',
      'Automated Tax Filings',
      'Contractor Payments',
      'Time Tracking Sync',
    ],
  },
  'Next Insurance': {
    title: 'Business Protection',
    description:
      'Comprehensive coverage tailored to your industry. Get insured in minutes and manage your certificates of insurance directly from SOS.',
    features: [
      'General Liability',
      'Professional Liability',
      "Workers' Compensation",
      'Instant COI Generation',
    ],
  },
  Guideline: {
    title: 'Employee Benefits',
    description:
      'Offer Fortune 500 benefits to your team. 401(k), health, dental, and vision plans fully integrated with your payroll.',
    features: [
      'Zero-Fee 401(k) Administration',
      'National Health Networks',
      'Flexible Spending Accounts',
      'Automated Payroll Deductions',
    ],
  },
  'The Hartford': {
    title: 'Commercial Coverage',
    description:
      'Protect your business with commercial liability and workers compensation coverage from one of the most trusted names in business insurance.',
    features: [
      'Commercial General Liability',
      "Workers' Compensation",
      'Certificate Management',
      'Dedicated Claims Support',
    ],
  },
  Vestwell: {
    title: 'Retirement Plans',
    description:
      'Give your team a modern retirement plan. Automated 401(k) administration that syncs directly with payroll and keeps you compliant with state mandates.',
    features: [
      'Automated 401(k) Administration',
      'Payroll Deduction Sync',
      'State Mandate Compliance',
      'Employee Enrollment Portal',
    ],
  },
  SimplyInsured: {
    title: 'Group Health Insurance',
    description:
      'Compare and manage group health plans in minutes. Instant quotes across major carriers with benefits administration built in.',
    features: [
      'Instant Group Health Quotes',
      'Medical, Dental & Vision Plans',
      'Benefits Administration',
      'Employee Enrollment Support',
    ],
  },
  QuickBooks: {
    title: 'Accounting Sync',
    description:
      'Keep your books accurate automatically. Two-way sync pushes bookings, payments, and payouts straight into your general ledger.',
    features: [
      'Two-Way General Ledger Sync',
      'Automated Invoice & Payment Sync',
      'Expense Categorization',
      'Financial Reporting',
    ],
  },
};

/** Display order for the branded partner sections. Unknown brands sort last. */
const PARTNER_ORDER = [
  'Deel',
  'Gusto',
  'Next Insurance',
  'Guideline',
  'The Hartford',
  'Vestwell',
  'SimplyInsured',
  'QuickBooks',
];

/**
 * Unified branded presentation of every partner-category module: each partner
 * renders as a full section with brand name, description, and offerings list.
 * Availability (Available / Coming Soon) stays driven by the module's active
 * state. Replaces the old anonymous partner card grid + four hardcoded
 * sections.
 */
function PartnerSections() {
  const { data: modules, isLoading, isError, refetch } = useListModules();

  if (isError) {
    return (
      <div
        className="max-w-4xl mx-auto text-center py-16 space-y-4"
        data-testid="partner-services-error"
      >
        <h2 className="text-xl font-semibold">Couldn&apos;t load partner integrations</h2>
        <p className="text-muted-foreground text-sm">
          Something went wrong while loading the partner list. Please try again.
        </p>
        <Button variant="outline" onClick={() => refetch()} data-testid="button-retry-partners">
          Retry
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6" data-testid="partner-services">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-64 rounded-xl max-w-4xl mx-auto" />
        ))}
      </div>
    );
  }

  const partners = (modules ?? [])
    .filter((m) => m.categorySlug === 'partners')
    .sort((a, b) => {
      const ai = PARTNER_ORDER.indexOf(a.partnerBrand ?? '');
      const bi = PARTNER_ORDER.indexOf(b.partnerBrand ?? '');
      return (ai === -1 ? PARTNER_ORDER.length : ai) - (bi === -1 ? PARTNER_ORDER.length : bi);
    });

  return (
    <div className="space-y-2" data-testid="partner-services">
      <div className="text-center pt-4">
        <h1 className="text-3xl font-bold tracking-tight">Partner Integrations</h1>
        <p className="text-muted-foreground text-sm mt-1">
          HR, payroll, insurance, benefits, and accounting offerings from our partners.
        </p>
      </div>
      {partners.map((module) => {
        const brand = module.partnerBrand ?? 'Partner';
        const content = PARTNER_OFFERINGS[brand];
        return (
          <StaticPlaceholderPage
            key={module.id}
            title={content?.title ?? module.name}
            partner={brand}
            moduleName={module.name}
            description={content?.description ?? module.description}
            features={content?.features ?? []}
            available={module.isActive}
          />
        );
      })}
    </div>
  );
}

/**
 * Unified Operations hub.
 *
 * Merges the former "Waitlist & Booking" module marketplace (/operations),
 * the "Partners (0%)" module marketplace (/partners) — now a single merged
 * Partners tab that also carries the former Partner Services details
 * (/sos/partner-services and the four SOS partner placeholder pages, whose
 * old URLs redirect to /partners) — plus the former GNIL Bridge marketing
 * marketplace (/marketing) —
 * into one tabbed page. All old URLs still work as deep links, each
 * selecting the matching tab, so refresh/back and bookmarks stay correct.
 * Backends and page content are untouched. The former Live Operations tab
 * (/sos/operations) now lives on the Command Center landing page.
 */

const TAB_ROUTES: Record<string, string> = {
  modules: '/operations',
  marketing: '/marketing',
  media: '/media',
  partners: '/partners',
};

function tabForLocation(location: string): string {
  const match = Object.entries(TAB_ROUTES).find(
    ([tab, path]) => tab !== 'modules' && location.startsWith(path),
  );
  return match ? match[0] : 'modules';
}

export default function OperationsHub() {
  const [location, setLocation] = useLocation();
  const activeTab = tabForLocation(location);

  return (
    <div className="space-y-4" data-testid="operations-hub">
      <Tabs
        value={activeTab}
        onValueChange={(tab) => {
          // Keep the URL in sync so refresh/back and deep links stay correct
          setLocation(TAB_ROUTES[tab] ?? '/operations', { replace: true });
        }}
      >
        <TabsList data-testid="operations-tabs" className="flex-wrap h-auto">
          <TabsTrigger value="modules" data-testid="tab-modules">Modules</TabsTrigger>
          <TabsTrigger value="marketing" data-testid="tab-marketing">Marketing</TabsTrigger>
          <TabsTrigger value="media" data-testid="tab-media">Media</TabsTrigger>
          <TabsTrigger value="partners" data-testid="tab-partners">
            Partners
          </TabsTrigger>
        </TabsList>
        <TabsContent value="modules" className="mt-4">
          <ModuleGrid
            categorySlug="operations"
            title="Core Operations"
            description="Service modules for payroll, booking, tracking, and backend operations."
          />
        </TabsContent>
        <TabsContent value="marketing" className="mt-4 space-y-4">
          <div className="flex justify-end">
            <Button
              asChild
              variant="outline"
              size="sm"
              className="gap-2"
              data-testid="link-module-configuration"
            >
              <Link href="/settings">
                <Settings className="w-4 h-4" /> Module setup in Configuration
              </Link>
            </Button>
          </div>
          <ModuleGrid
            categorySlug="marketing"
            title="Marketing OS & Bridge"
            description="GNIL integration modules and core marketing pipelines."
          />
        </TabsContent>
        <TabsContent value="media" className="mt-4">
          {/* Former standalone Media & Assets page — same module marketplace,
              now a tab. /media deep links select this tab. */}
          <ModuleGrid
            categorySlug="media"
            title="Media & Assets"
            description="Media buying, ads, and streaming networks."
          />
        </TabsContent>
        <TabsContent value="partners" className="mt-4 space-y-8">
          {/* Single merged Partners tab: every partner-category module renders
              as a branded section (brand name, description, offerings). Old
              URLs (/sos/partner-services and the per-partner pages) redirect
              to /partners. */}
          <PartnerSections />
        </TabsContent>
      </Tabs>
    </div>
  );
}
