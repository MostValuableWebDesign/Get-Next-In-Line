import { useEffect, useRef, useState } from 'react';
import { getTenantActivity, type TenantActivity } from '@workspace/api-client-react';
import { Link, useLocation, useParams, useSearch } from 'wouter';
import {
  useGetTenant,
  useGetTenantModules,
  useGetTenantActivity,
  getGetTenantQueryKey,
  getGetTenantModulesQueryKey,
  getGetTenantActivityQueryKey,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RulesTab, ClientsTab } from '@/components/concierge-tabs';
import { CommunicationsTab } from '@/components/communications-tab';
import { AiReceptionistPage } from '@/pages/sos/ai-receptionist';
import SettingsPage from '@/pages/Settings';
import { formatCurrency } from '@/lib/format';
import {
  Activity, ArrowLeft, Bot, Building2, CalendarClock, DollarSign, LayoutDashboard, Mail, Package,
  Phone, ScrollText, Settings, User, Users,
} from 'lucide-react';

const ACTIVITY_PAGE_SIZE = 20;

const TAB_VALUES = ['overview', 'rules', 'clients', 'communications', 'ai-receptionist', 'settings'] as const;
type TabValue = (typeof TAB_VALUES)[number];

/** Legacy tab deep links remapped to their new home. */
const LEGACY_TAB_ALIASES: Record<string, TabValue> = {
  // The old "Message Log" tab was folded into Communications.
  log: 'communications',
};

export default function TenantDetail() {
  const params = useParams<{ id: string }>();
  const tenantId = Number(params.id);
  const validId = Number.isInteger(tenantId);

  // The active tab is driven by the ?tab= query param so deep links (e.g.
  // the old /tenants/:id/concierge redirect) land on the right tab.
  const search = useSearch();
  const requestedRaw = new URLSearchParams(search).get('tab');
  const requestedTab = requestedRaw != null ? (LEGACY_TAB_ALIASES[requestedRaw] ?? requestedRaw) : null;
  const initialTab: TabValue = TAB_VALUES.includes(requestedTab as TabValue)
    ? (requestedTab as TabValue)
    : 'overview';
  const [tab, setTab] = useState<TabValue>(initialTab);
  const [, navigate] = useLocation();

  // Keep the URL in sync when the user switches tabs so a refresh or a
  // shared link restores the same tab. Replace (not push) so tab flips
  // don't pollute browser history.
  const selectTab = (v: TabValue) => {
    setTab(v);
    navigate(`/tenants/${tenantId}?tab=${v}`, { replace: true });
  };
  useEffect(() => {
    setTab(initialTab);
    // Re-sync only when the URL-requested tab or tenant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, tenantId]);

  const { data: tenant, isLoading: isLoadingTenant, error } = useGetTenant(tenantId, {
    query: { queryKey: getGetTenantQueryKey(tenantId), enabled: validId },
  });
  const { data: modules, isLoading: isLoadingModules } = useGetTenantModules(tenantId, {
    query: { queryKey: getGetTenantModulesQueryKey(tenantId), enabled: validId },
  });
  const { data: activityPage, isLoading: isLoadingActivity } = useGetTenantActivity(
    { tenantId, limit: ACTIVITY_PAGE_SIZE },
    {
      query: {
        queryKey: getGetTenantActivityQueryKey({ tenantId, limit: ACTIVITY_PAGE_SIZE }),
        enabled: validId,
      },
    }
  );
  const [extraActivity, setExtraActivity] = useState<TenantActivity[]>([]);
  const [extraHasMore, setExtraHasMore] = useState<boolean | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);

  // Tracks the tenant the pagination state belongs to, so late "Load more"
  // responses from a previous tenant are discarded instead of appended.
  const activityTenantRef = useRef(tenantId);

  // Reset pagination state when switching tenants so pages never mix.
  useEffect(() => {
    activityTenantRef.current = tenantId;
    setExtraActivity([]);
    setExtraHasMore(null);
    setLoadMoreError(false);
    setIsLoadingMore(false);
  }, [tenantId]);

  const firstPageItems = activityPage?.items ?? [];
  const tenantActivity = [...firstPageItems, ...extraActivity];
  const hasMoreActivity = extraHasMore ?? activityPage?.hasMore ?? false;

  const loadMoreActivity = async () => {
    const requestTenantId = tenantId;
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
        tenantId: requestTenantId,
        limit: ACTIVITY_PAGE_SIZE,
        before_timestamp: lastItem.timestamp,
        before_id: lastItem.id,
      });
      // Ignore stale responses that resolve after switching tenants.
      if (activityTenantRef.current !== requestTenantId) return;
      setExtraActivity((prev) => [...prev, ...page.items]);
      setExtraHasMore(page.hasMore);
      setIsLoadingMore(false);
    } catch {
      if (activityTenantRef.current !== requestTenantId) return;
      setLoadMoreError(true);
      setIsLoadingMore(false);
    }
  };

  if (isLoadingTenant) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-[280px] rounded-xl" />
          <Skeleton className="h-[280px] rounded-xl" />
        </div>
      </div>
    );
  }

  if (!validId || error || !tenant) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Tenant not found</h1>
        <p className="text-muted-foreground">This tenant does not exist or is no longer available.</p>
        <Button asChild variant="outline">
          <Link href="/tenants">Back to Tenant Operations</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Button asChild variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground" data-testid="link-back-tenants">
        <Link href="/tenants">
          <ArrowLeft className="w-4 h-4" /> Back to Tenant Operations
        </Link>
      </Button>

      {/* Tenant Header */}
      <Card className="border-none shadow-md">
        <CardContent className="p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-xl text-primary">
              <Building2 className="w-8 h-8" />
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight" data-testid="text-tenant-brand">{tenant.brandName}</h1>
                <StatusBadge status={tenant.status} data-testid="badge-tenant-status" />
              </div>
              <p className="text-muted-foreground text-sm font-mono mt-1" data-testid="text-tenant-subdomain">
                {tenant.subdomain}.gnil.os
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 self-stretch md:self-auto justify-end">
          <Button asChild variant="outline" className="gap-2" data-testid="link-tenant-settings">
            <Link href={`/tenants/${tenantId}?tab=settings`}>
              <Settings className="w-4 h-4" /> Configuration
            </Link>
          </Button>
          <div className="text-right mr-2">
            <div className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
              <DollarSign className="w-3 h-3" /> Monthly Recurring Revenue
            </div>
            <div className="text-xl font-extrabold font-mono text-emerald-600" data-testid="text-tenant-mrr">
              {formatCurrency(tenant.mrr)}
              <span className="text-xs text-muted-foreground font-normal font-sans">/mo</span>
            </div>
          </div>
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => selectTab(v as TabValue)}>
        <TabsList data-testid="tabs-tenant-detail">
          <TabsTrigger value="overview" data-testid="tab-overview">
            <LayoutDashboard className="w-4 h-4 mr-1.5" /> Overview
          </TabsTrigger>
          <TabsTrigger value="rules" data-testid="tab-rules">
            <Bot className="w-4 h-4 mr-1.5" /> Engagement Rules
          </TabsTrigger>
          <TabsTrigger value="clients" data-testid="tab-clients">
            <Users className="w-4 h-4 mr-1.5" /> Client Profiles
          </TabsTrigger>
          <TabsTrigger value="communications" data-testid="tab-communications">
            <ScrollText className="w-4 h-4 mr-1.5" /> Communications
          </TabsTrigger>
          <TabsTrigger value="ai-receptionist" data-testid="tab-ai-receptionist">
            <Phone className="w-4 h-4 mr-1.5" /> AI Receptionist
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">
            <Settings className="w-4 h-4 mr-1.5" /> Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-6">
      {/* Contact & Meta */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-none shadow-md">
          <CardContent className="p-4 flex items-center gap-3">
            <User className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Contact</div>
              <div className="text-sm font-medium truncate" data-testid="text-tenant-contact-name">{tenant.contactName || 'N/A'}</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-md">
          <CardContent className="p-4 flex items-center gap-3">
            <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Email</div>
              <div className="text-sm font-medium truncate" data-testid="text-tenant-contact-email">{tenant.contactEmail || 'N/A'}</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-md">
          <CardContent className="p-4 flex items-center gap-3">
            <CalendarClock className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Provisioned</div>
              <div className="text-sm font-medium" data-testid="text-tenant-created">
                {new Date(tenant.createdAt).toLocaleDateString()}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Subscribed Modules */}
        <Card className="border-none shadow-md">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="w-5 h-5 text-primary" /> Subscribed Modules
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingModules ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </div>
            ) : !modules || modules.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-modules">
                This tenant has no modules provisioned yet.
              </p>
            ) : (
              <div className="divide-y" data-testid="list-tenant-modules">
                {modules.map((m) => (
                  <Link
                    key={m.moduleId}
                    href={`/modules/${m.moduleId}`}
                    className="flex items-center justify-between gap-4 py-3 px-2 -mx-2 rounded-lg hover:bg-muted/50 transition-colors"
                    data-testid={`link-tenant-module-${m.moduleId}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{m.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{m.category}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {m.paymentMode && (
                        <Badge
                          variant={m.paymentMode === 'live' ? 'default' : 'secondary'}
                          className="text-[9px] uppercase"
                          data-testid={`badge-payment-mode-${m.moduleId}`}
                        >
                          {m.paymentMode === 'live' ? 'Paid (Stripe)' : 'Simulated'}
                        </Badge>
                      )}
                      <Badge
                        variant="outline"
                        className="text-[9px] uppercase"
                        data-testid={`badge-cadence-${m.moduleId}`}
                      >
                        {m.billingCadence === 'biweekly' ? 'Bi-Weekly' : 'Monthly'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        Provisioned {new Date(m.provisionedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card className="border-none shadow-md">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" /> Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingActivity ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </div>
            ) : (
              <ActivityFeed
                variant="divided"
                items={tenantActivity}
                listTestId="list-tenant-activity"
                empty={
                  <p className="text-sm text-muted-foreground" data-testid="text-no-activity">
                    No recent activity for this tenant.
                  </p>
                }
                hasMore={hasMoreActivity}
                isLoadingMore={isLoadingMore}
                loadMoreError={loadMoreError}
                onLoadMore={loadMoreActivity}
                loadMoreTestId="button-load-more-activity"
                loadMoreErrorTestId="text-load-more-error"
              />
            )}
          </CardContent>
        </Card>
      </div>
        </TabsContent>

        <TabsContent value="rules" className="mt-4">
          <RulesTab tenantId={tenantId} />
        </TabsContent>
        <TabsContent value="clients" className="mt-4">
          <ClientsTab tenantId={tenantId} />
        </TabsContent>
        <TabsContent value="communications" className="mt-4">
          <CommunicationsTab tenantId={tenantId} />
        </TabsContent>
        {/* Former standalone pages, folded in as tabs. Both read the tenant
            id from the /tenants/:id route params, so tenant scoping is
            preserved. Old URLs (/tenants/:id/ai-receptionist and
            /tenants/:id/settings) redirect here. */}
        <TabsContent value="ai-receptionist" className="mt-4">
          <AiReceptionistPage embedded />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsPage embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
