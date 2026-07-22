import { useLocation } from 'wouter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ModuleGrid } from '@/components/modules/ModuleGrid';
import { OperationsPage as LiveOperations } from '@/pages/sos/operations';

/**
 * Unified Operations hub.
 *
 * Merges the former "Waitlist & Booking" module marketplace (/operations) and
 * the SOS "Operations Center" (/sos/operations) into one tabbed page.
 * Both old URLs still work — each route renders this page with the matching
 * tab selected, so deep links from the Module Console and Settings anchors
 * keep landing in the right place. Backends are untouched: the Modules tab
 * uses the module provisioning APIs, the Live tab uses the SOS visit/waitlist
 * APIs, exactly as before.
 */
export default function OperationsHub() {
  const [location, setLocation] = useLocation();
  const activeTab = location.startsWith('/sos/operations') ? 'live' : 'modules';

  return (
    <div className="space-y-4" data-testid="operations-hub">
      <Tabs
        value={activeTab}
        onValueChange={(tab) => {
          // Keep the URL in sync so refresh/back and deep links stay correct
          setLocation(tab === 'live' ? '/sos/operations' : '/operations', { replace: true });
        }}
      >
        <TabsList data-testid="operations-tabs">
          <TabsTrigger value="live" data-testid="tab-live-operations">Live Operations</TabsTrigger>
          <TabsTrigger value="modules" data-testid="tab-modules">Modules</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
