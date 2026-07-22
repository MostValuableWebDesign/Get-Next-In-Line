import { Link, useLocation } from 'wouter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Settings } from 'lucide-react';
import { ModuleGrid } from '@/components/modules/ModuleGrid';
import { OperationsPage as LiveOperations } from '@/pages/sos/operations';
import {
  EmployeesPage,
  PayrollPage,
  BusinessProtectionPage,
  EmployeeBenefitsPage,
} from '@/pages/sos/static-pages';

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
          <EmployeesPage />
        </TabsContent>
        <TabsContent value="payroll" className="mt-4">
          <PayrollPage />
        </TabsContent>
        <TabsContent value="protection" className="mt-4">
          <BusinessProtectionPage />
        </TabsContent>
        <TabsContent value="benefits" className="mt-4">
          <EmployeeBenefitsPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}
