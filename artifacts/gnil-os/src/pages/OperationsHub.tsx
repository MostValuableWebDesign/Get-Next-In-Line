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
 * marketplace (/partners), and the SOS partner placeholder pages —
 * Employees (/sos/employees), Payroll (/sos/payroll), Business Protection
 * (/sos/business-protection), and Employee Benefits (/sos/employee-benefits)
 * — plus the former GNIL Bridge marketing marketplace (/marketing) —
 * into one tabbed page. All old URLs still work as deep links, each
 * selecting the matching tab, so refresh/back and bookmarks stay correct.
 * Backends and page content are untouched.
 */

const TAB_ROUTES: Record<string, string> = {
  live: '/sos/operations',
  modules: '/operations',
  marketing: '/marketing',
  partners: '/partners',
  employees: '/sos/employees',
  payroll: '/sos/payroll',
  protection: '/sos/business-protection',
  benefits: '/sos/employee-benefits',
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
          <TabsTrigger value="partners" data-testid="tab-partner-integrations">
            Partner Integrations
          </TabsTrigger>
          <TabsTrigger value="employees" data-testid="tab-employees">Employees</TabsTrigger>
          <TabsTrigger value="payroll" data-testid="tab-payroll">Payroll (Gusto)</TabsTrigger>
          <TabsTrigger value="protection" data-testid="tab-business-protection">
            Business Protection
          </TabsTrigger>
          <TabsTrigger value="benefits" data-testid="tab-employee-benefits">
            Employee Benefits
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
        <TabsContent value="partners" className="mt-4">
          <ModuleGrid
            categorySlug="partners"
            title="Partner Integrations"
            description="High-value integrations passed through to tenants at 0% markup."
          />
        </TabsContent>
        <TabsContent value="employees" className="mt-4">
          <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.employees} />
        </TabsContent>
        <TabsContent value="payroll" className="mt-4">
          <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.payroll} />
        </TabsContent>
        <TabsContent value="protection" className="mt-4">
          <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.protection} />
        </TabsContent>
        <TabsContent value="benefits" className="mt-4">
          <StaticPlaceholderPage {...PARTNER_PLACEHOLDERS.benefits} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
