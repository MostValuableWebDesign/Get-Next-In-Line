import { useGetAgencyDashboard, useGetAgencySettings, useUpdateAgencySettings, getGetModulesPricingQueryKey, useGetTenantActivity, getGetTenantActivityQueryKey, getTenantActivity, type TenantActivity } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { formatCurrency, formatPercent } from '@/lib/format';
import { Activity, DollarSign, Users, Target, Clock } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/shared/StatCard';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useRef, useState, useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';

export default function Dashboard() {
  const { data: dashboard, isLoading: isLoadingDashboard } = useGetAgencyDashboard();
  const { data: settings, isLoading: isLoadingSettings } = useGetAgencySettings();
  
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

  if (!dashboard || !settings) return <div>Failed to load dashboard</div>;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Command Center</h1>
          <p className="text-muted-foreground mt-1">Agency performance and global settings.</p>
        </div>
        <GlobalMarkupSlider initialMarkup={settings.markupPercent} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Total MRR" value={formatCurrency(dashboard.totalMrr)} icon={DollarSign} trend={dashboard.mrrGrowthPercent > 0 ? `+${dashboard.mrrGrowthPercent}%` : `${dashboard.mrrGrowthPercent}%`} />
        <StatCard title="Active Tenants" value={dashboard.activeTenants.toString()} icon={Users} subtitle={`Out of ${dashboard.totalTenants} total`} />
        <StatCard title="Suspended" value={dashboard.suspendedTenants.toString()} icon={Activity} subtitle="Requires attention" />
        <StatCard title="Modules Provisioned" value={dashboard.totalModulesProvisioned.toString()} icon={Target} subtitle="Across all tenants" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
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

        <GlobalActivityFeed />
      </div>
    </div>
  );
}

const FEED_PAGE_SIZE = 20;

function GlobalActivityFeed() {
  const { data: activityPage, isLoading } = useGetTenantActivity(
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
