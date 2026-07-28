import { useGetAgencyDashboard, useGetAgencySettings, useUpdateAgencySettings, getGetModulesPricingQueryKey, useGetTenantActivity, getGetTenantActivityQueryKey, getTenantActivity, type TenantActivity } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { formatCurrency, formatPercent } from '@/lib/format';
import { Activity, DollarSign, Users, Target, Clock, TrendingUp } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/shared/StatCard';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useRef, useState, Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useLocation } from 'wouter';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { OperationsPage as LiveOperations } from '@/pages/sos/operations';
import Tenants from '@/pages/Tenants';
import Billing from '@/pages/Billing';
import Settings from '@/pages/Settings';
import CoopPartnerships from '@/pages/CoopPartnerships';
import FranchiseController from '@/pages/FranchiseController';
import Compliance from '@/pages/Compliance';
import Governance from '@/pages/Governance';
import MasterOverview from '@/pages/MasterOverview';
import { useSessionRole, type NetworkRole } from '@/hooks/useAuth';

/**
 * Command Center hub.
 *
 * Tabbed agency-management hub: the Dashboard overview (plus Live
 * Operations), the Tenants grid (/tenants), Billing (/billing), and Agency
 * Settings — the Configuration page including the connector registry
 * (/settings, /settings#connectors). Each tab keeps its own URL, so the old
 * top-level URLs act as deep links to the matching tab and the active tab
 * survives refresh/link-sharing. Only the active tab's content is mounted,
 * so each tab's data fetching stays scoped to that tab.
 */
const TAB_ROUTES: Record<string, string> = {
  dashboard: '/',
  master: '/master',
  tenants: '/tenants',
  billing: '/billing',
  compliance: '/compliance',
  partnerships: '/partnerships',
  franchise: '/franchise',
  governance: '/governance',
  settings: '/settings',
};

// Which Command Center tabs each governance role can use. Anything not
// listed is hidden — the role's API access wouldn't allow it anyway.
const TABS_FOR_ROLE: Record<NetworkRole, string[]> = {
  super_admin: ['dashboard', 'master', 'tenants', 'billing', 'compliance', 'partnerships', 'franchise', 'governance', 'settings'],
  district_manager: ['tenants', 'governance'],
  merchant: ['tenants'],
  staff: ['tenants'],
};

function tabForLocation(location: string): string {
  const match = Object.entries(TAB_ROUTES).find(
    ([tab, path]) => tab !== 'dashboard' && location === path,
  );
  return match ? match[0] : 'dashboard';
}

export default function CommandCenter() {
  const [location, setLocation] = useLocation();
  const role = useSessionRole();
  const visibleTabs = TABS_FOR_ROLE[role ?? 'super_admin'];
  let activeTab = tabForLocation(location);
  if (!visibleTabs.includes(activeTab)) activeTab = visibleTabs[0];

  return (
    <div className="space-y-4" data-testid="command-center-hub">
      <Tabs
        value={activeTab}
        onValueChange={(tab) => {
          // Keep the URL in sync so refresh/back and deep links stay correct
          setLocation(TAB_ROUTES[tab] ?? '/', { replace: true });
        }}
      >
        <TabsList data-testid="command-center-tabs" className="flex-wrap h-auto">
          {visibleTabs.includes('dashboard') && <TabsTrigger value="dashboard" data-testid="tab-dashboard">Dashboard</TabsTrigger>}
          {visibleTabs.includes('master') && <TabsTrigger value="master" data-testid="tab-master-overview">Master Overview</TabsTrigger>}
          {visibleTabs.includes('tenants') && <TabsTrigger value="tenants" data-testid="tab-tenants">Tenants</TabsTrigger>}
          {visibleTabs.includes('billing') && <TabsTrigger value="billing" data-testid="tab-billing">Billing</TabsTrigger>}
          {visibleTabs.includes('compliance') && <TabsTrigger value="compliance" data-testid="tab-compliance">Compliance</TabsTrigger>}
          {visibleTabs.includes('partnerships') && <TabsTrigger value="partnerships" data-testid="tab-partnerships">Partnerships</TabsTrigger>}
          {visibleTabs.includes('franchise') && <TabsTrigger value="franchise" data-testid="tab-franchise">Franchise</TabsTrigger>}
          {visibleTabs.includes('governance') && <TabsTrigger value="governance" data-testid="tab-governance">Governance</TabsTrigger>}
          {visibleTabs.includes('settings') && <TabsTrigger value="settings" data-testid="tab-agency-settings">Agency Settings</TabsTrigger>}
        </TabsList>
        <TabsContent value="dashboard" className="mt-4">
          <DashboardErrorBoundary>
            <DashboardTab />
          </DashboardErrorBoundary>
        </TabsContent>
        <TabsContent value="master" className="mt-4">
          <MasterOverview />
        </TabsContent>
        <TabsContent value="tenants" className="mt-4">
          <DashboardErrorBoundary>
            <Tenants />
          </DashboardErrorBoundary>
        </TabsContent>
        <TabsContent value="billing" className="mt-4">
          <DashboardErrorBoundary>
            <Billing />
          </DashboardErrorBoundary>
        </TabsContent>
        <TabsContent value="compliance" className="mt-4">
          <DashboardErrorBoundary>
            <Compliance />
          </DashboardErrorBoundary>
        </TabsContent>
        <TabsContent value="partnerships" className="mt-4">
          <DashboardErrorBoundary>
            <CoopPartnerships />
          </DashboardErrorBoundary>
        </TabsContent>
        <TabsContent value="franchise" className="mt-4">
          <DashboardErrorBoundary>
            <FranchiseController />
          </DashboardErrorBoundary>
        </TabsContent>
        <TabsContent value="governance" className="mt-4">
          <Governance />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <DashboardErrorBoundary>
            <Settings />
          </DashboardErrorBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Inline per-section error card: shown in place of a section whose query
 * failed, while the rest of the dashboard keeps rendering.
 */
function SectionErrorCard({
  title,
  onRetry,
  testId,
  className,
}: {
  title: string;
  onRetry: () => void;
  testId: string;
  className?: string;
}) {
  return (
    <Card className={`border-dashed border-destructive/40 shadow-none ${className ?? ''}`} data-testid={testId}>
      <CardContent className="p-6 flex flex-col items-center justify-center text-center gap-3">
        <AlertTriangle className="w-6 h-6 text-destructive" />
        <div>
          <div className="font-medium">{title}</div>
          <p className="text-sm text-muted-foreground mt-1">This section couldn't load. The rest of the dashboard is unaffected.</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRetry} data-testid={`${testId}-retry`}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Catches render-time crashes anywhere inside the dashboard tab (e.g. an
 * unexpected data shape) and shows a recoverable fallback instead of a
 * white screen. "Try again" re-mounts the children.
 */
class DashboardErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card className="border-dashed border-destructive/40 shadow-none" data-testid="dashboard-error-boundary">
          <CardContent className="p-10 flex flex-col items-center justify-center text-center gap-4">
            <AlertTriangle className="w-8 h-8 text-destructive" />
            <div>
              <div className="text-lg font-semibold">Something went wrong</div>
              <p className="text-sm text-muted-foreground mt-1">
                The dashboard hit an unexpected error while rendering.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => this.setState({ hasError: false })}
              data-testid="dashboard-error-boundary-retry"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Try again
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}

function DashboardTab() {
  const {
    data: dashboard,
    isLoading: isLoadingDashboard,
    refetch: refetchDashboard,
  } = useGetAgencyDashboard();
  const {
    data: settings,
    isLoading: isLoadingSettings,
    refetch: refetchSettings,
  } = useGetAgencySettings();

  if (isLoadingDashboard || isLoadingSettings) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}
        </div>
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    );
  }

  // Both page-load queries failed: friendly full-page fallback with a Retry
  // that refetches both.
  if (!dashboard && !settings) {
    return (
      <Card className="border-dashed border-destructive/40 shadow-none" data-testid="dashboard-full-error">
        <CardContent className="p-12 flex flex-col items-center justify-center text-center gap-4">
          <AlertTriangle className="w-10 h-10 text-destructive" />
          <div>
            <div className="text-xl font-semibold">Couldn't load the dashboard</div>
            <p className="text-sm text-muted-foreground mt-1">
              We couldn't reach the server. Check your connection and try again.
            </p>
          </div>
          <Button
            onClick={() => {
              refetchDashboard();
              refetchSettings();
            }}
            data-testid="dashboard-full-error-retry"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Command Center</h1>
          <p className="text-muted-foreground mt-1">Agency performance and global settings.</p>
        </div>
        {settings ? (
          <GlobalMarkupSlider initialMarkup={settings.markupPercent} />
        ) : (
          <SectionErrorCard
            title="Global settings unavailable"
            onRetry={() => refetchSettings()}
            testId="error-agency-settings"
            className="w-full md:w-[400px]"
          />
        )}
      </div>

      {dashboard ? (
        <>
          {/* Revenue summary — monthly profit and retail markup earnings */}
          <Card className="border-none shadow-md bg-emerald-600 text-white" data-testid="card-revenue-summary">
            <CardContent className="p-6 flex flex-col md:flex-row md:items-center gap-6">
              <div className="p-3 bg-white/15 rounded-xl self-start">
                <TrendingUp className="w-8 h-8" />
              </div>
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <div className="text-sm uppercase tracking-wider text-white/80 font-medium">Monthly Profit</div>
                  <div className="text-4xl font-bold font-mono tracking-tight" data-testid="text-monthly-profit">
                    {formatCurrency(dashboard.monthlyProfit)}
                  </div>
                </div>
                <div>
                  <div className="text-sm uppercase tracking-wider text-white/80 font-medium">Earnings from Retail Markups</div>
                  <div className="text-4xl font-bold font-mono tracking-tight" data-testid="text-markup-earnings">
                    {formatCurrency(dashboard.markupEarnings)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard title="Total MRR" value={formatCurrency(dashboard.totalMrr)} icon={DollarSign} trend={dashboard.mrrGrowthPercent > 0 ? `+${dashboard.mrrGrowthPercent}%` : `${dashboard.mrrGrowthPercent}%`} />
            <StatCard title="Active Tenants" value={dashboard.activeTenants.toString()} icon={Users} subtitle={`Out of ${dashboard.totalTenants} total`} />
            <StatCard title="Suspended" value={dashboard.suspendedTenants.toString()} icon={Activity} subtitle="Requires attention" />
            <StatCard title="Modules Provisioned" value={dashboard.totalModulesProvisioned.toString()} icon={Target} subtitle="Across all tenants" />
          </div>
        </>
      ) : (
        <SectionErrorCard
          title="Agency performance unavailable"
          onRetry={() => refetchDashboard()}
          testId="error-agency-dashboard"
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {dashboard && (
          <Card className="lg:col-span-2 border-none shadow-md">
            <CardHeader>
              <CardTitle>Revenue by Category</CardTitle>
              <CardDescription>MRR breakdown across service modules</CardDescription>
            </CardHeader>
            <CardContent className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dashboard.revenueByCategory}>
                  <XAxis dataKey="category" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(val) => `$${val}`}
                  />
                  <Tooltip 
                    formatter={(value: number) => [formatCurrency(value), 'MRR']}
                    contentStyle={{ fontFamily: 'var(--font-sans)', borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    itemStyle={{ fontFamily: 'var(--font-mono)' }}
                  />
                  <Bar dataKey="mrr" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {settings && (
          <Card className="border-none shadow-md">
            <CardHeader>
              <CardTitle>System Information</CardTitle>
              <CardDescription>Global deployment configuration</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Platform Name</span>
                <div className="font-mono font-medium">{settings.platformName}</div>
              </div>
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Deployment Mode</span>
                <div className="font-mono font-medium uppercase text-emerald-600">{settings.deploymentMode}</div>
              </div>
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Last Updated</span>
                <div className="font-mono font-medium text-sm">{new Date(settings.updatedAt).toLocaleString()}</div>
              </div>
            </CardContent>
          </Card>
        )}

        <GlobalActivityFeed />
      </div>

      {/* Live Operations — the former Operations Hub "Live Operations" tab,
          merged into the Command Center landing page. /sos/operations
          redirects here. */}
      <div data-testid="section-live-operations">
        <LiveOperations embedded />
      </div>
    </div>
  );
}

const FEED_PAGE_SIZE = 20;

function GlobalActivityFeed() {
  const { data: activityPage, isLoading, refetch } = useGetTenantActivity(
    { limit: FEED_PAGE_SIZE },
    { query: { queryKey: getGetTenantActivityQueryKey({ limit: FEED_PAGE_SIZE }) } }
  );
  const [extraActivity, setExtraActivity] = useState<TenantActivity[]>([]);
  const [extraHasMore, setExtraHasMore] = useState<boolean | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);

  const firstPageItems = activityPage?.items ?? [];
  const activities = [...firstPageItems, ...extraActivity];
  const hasMore = extraHasMore ?? activityPage?.hasMore ?? false;

  const loadMore = async () => {
    // Keyset cursor: the (timestamp, id) of the last loaded item.
    const lastItem =
      extraActivity.length > 0
        ? extraActivity[extraActivity.length - 1]
        : firstPageItems[firstPageItems.length - 1];
    if (!lastItem) return;
    setIsLoadingMore(true);
    setLoadMoreError(false);
    try {
      const page = await getTenantActivity({
        limit: FEED_PAGE_SIZE,
        before_timestamp: lastItem.timestamp,
        before_id: lastItem.id,
      });
      setExtraActivity((prev) => [...prev, ...page.items]);
      setExtraHasMore(page.hasMore);
      setIsLoadingMore(false);
    } catch {
      setLoadMoreError(true);
      setIsLoadingMore(false);
    }
  };

  return (
    <Card className="border-none shadow-md col-span-1 lg:col-span-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-muted-foreground" />
          Recent Activity Feed
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !activityPage ? (
          <div className="flex flex-col items-center justify-center text-center gap-3 py-8" data-testid="error-activity-feed">
            <AlertTriangle className="w-6 h-6 text-destructive" />
            <p className="text-sm text-muted-foreground">Couldn't load recent activity.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="error-activity-feed-retry">
              <RefreshCw className="w-4 h-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : (
          <ActivityFeed
            variant="dots"
            items={activities}
            empty={<div className="text-center text-muted-foreground py-8">No recent activity.</div>}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            loadMoreError={loadMoreError}
            onLoadMore={loadMore}
            loadMoreTestId="button-feed-load-more"
            loadMoreErrorTestId="text-feed-load-more-error"
          />
        )}
      </CardContent>
    </Card>
  );
}

function GlobalMarkupSlider({ initialMarkup }: { initialMarkup: number }) {
  const [markup, setMarkup] = useState(initialMarkup);
  const updateSettings = useUpdateAgencySettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  // Debounce the slider change to avoid spamming the API
  const timerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const handleSliderChange = (val: number[]) => {
    const newVal = val[0];
    setMarkup(newVal);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      updateSettings.mutate(
        { data: { markupPercent: newVal } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetModulesPricingQueryKey() });
            toast({
              title: "Markup Updated",
              description: `Global profit margin set to ${newVal}%`,
            });
          }
        }
      );
    }, 500);
  };

  return (
    <Card className="w-full md:w-[400px] border-none shadow-md bg-primary/5 border-primary/20 border">
      <CardContent className="p-4">
        <div className="flex justify-between items-center mb-4">
          <Label className="font-bold text-primary">Global Resale Markup</Label>
          <div className="font-mono font-bold text-lg text-primary">{markup}%</div>
        </div>
        <Slider 
          value={[markup]} 
          min={0} 
          max={300} 
          step={5} 
          onValueChange={handleSliderChange} 
          className="cursor-grab"
        />
        <p className="text-xs text-muted-foreground mt-3">
          Adjusts the resale price of all non-partner modules across all tenants instantly.
        </p>
      </CardContent>
    </Card>
  );
}
