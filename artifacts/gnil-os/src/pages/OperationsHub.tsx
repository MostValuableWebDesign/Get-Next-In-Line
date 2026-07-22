import { Link, useLocation } from 'wouter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Settings } from 'lucide-react';
import { ModuleGrid } from '@/components/modules/ModuleGrid';
import { OperationsPage as LiveOperations } from '@/pages/sos/operations';
import { StaticPlaceholderPage } from '@/components/static-page';

// Partner placeholder tabs (former SOS static pages) — pure content, rendered
// through the shared StaticPlaceholderPage component.
const PARTNER_PLACEHOLDERS = {
  employees: {
    title: 'Team Management',
    partner: 'Deel',
    description:
      'Manage your entire workforce from a single dashboard. Onboard new staff, track hours, and manage schedules with automated compliance.',
    features: [
      'Automated Onboarding Flows',
      'Time & Attendance Tracking',
      'Shift Scheduling',
      'Performance Reviews',
    ],
  },
  payroll: {
    title: 'Payroll & Compliance',
    partner: 'Gusto',
    description:
      'Run payroll in minutes. We handle tax filings, W-2s, and 1099s automatically so you can focus on running your business.',
    features: [
      'Next-Day Direct Deposit',
      'Automated Tax Filings',
      'Contractor Payments',
      'Time Tracking Sync',
    ],
  },
  protection: {
    title: 'Business Protection',
    partner: 'Next Insurance',
    description:
      'Comprehensive coverage tailored to your industry. Get insured in minutes and manage your certificates of insurance directly from SOS.',
    features: [
      'General Liability',
      'Professional Liability',
      "Workers' Compensation",
      'Instant COI Generation',
    ],
  },
  benefits: {
    title: 'Employee Benefits',
    partner: 'Guideline',
    description:
      'Offer Fortune 500 benefits to your team. 401(k), health, dental, and vision plans fully integrated with your payroll.',
    features: [
      'Zero-Fee 401(k) Administration',
      'National Health Networks',
      'Flexible Spending Accounts',
      'Automated Payroll Deductions',
    ],
  },
};

/**
 * Unified Operations hub.
 *
 * Merges the former "Waitlist & Booking" module marketplace (/operations),
 * the SOS "Operations Center" (/sos/operations), the "Partners (0%)" module
 * marketplace (/partners), and the combined Partner Services tab
 * (/sos/partner-services — the four former SOS partner placeholder pages,
 * whose old URLs redirect there) — plus the former GNIL Bridge marketing
 * marketplace (/marketing) —
 * into one tabbed page. All old URLs still work as deep links, each
 * selecting the matching tab, so refresh/back and bookmarks stay correct.
 * Backends and page content are untouched.
 */

const TAB_ROUTES: Record<string, string> = {
  live: '/sos/operations',
  modules: '/operations',
  marketing: '/marketing',
  media: '/media',
  partners: '/partners',
  'partner-services': '/sos/partner-services',
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
          <TabsTrigger value="live" data-testid="tab-live-operations">Live Operations</TabsTrigger>
          <TabsTrigger value="modules" data-testid="tab-modules">Modules</TabsTrigger>
          <TabsTrigger value="marketing" data-testid="tab-marketing">Marketing</TabsTrigger>
          <TabsTrigger value="media" data-testid="tab-media">Media</TabsTrigger>
          <TabsTrigger value="partners" data-testid="tab-partner-integrations">
            Partner Integrations
          </TabsTrigger>
          <TabsTrigger value="partner-services" data-testid="tab-partner-services">
            Partner Services
          </TabsTrigger>
        </TabsList>
        <TabsContent value="live" className="mt-4">
          <LiveOperations />
        </TabsContent>
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
            description="High-margin white-label media buying, ads, and streaming networks."
          />
        </TabsContent>
        <TabsContent value="partners" className="mt-4">
          <ModuleGrid
            categorySlug="partners"
            title="Partner Integrations"
            description="High-value integrations passed through to tenants at 0% markup."
          />
        </TabsContent>
        <TabsContent value="partner-services" className="mt-4">
          {/* Single combined tab for the four former partner placeholder
              tabs (Employees, Payroll, Business Protection, Employee
              Benefits). The old tab URLs redirect here. */}
          <div className="space-y-2" data-testid="partner-services">
            <div className="text-center pt-4">
              <h2 className="text-2xl font-bold tracking-tight">Partner Services</h2>
              <p className="text-muted-foreground text-sm mt-1">
                HR, payroll, insurance, and benefits offerings from our partners.
              </p>
            </div>
            <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.employees} />
            <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.payroll} />
            <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.protection} />
            <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.benefits} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
