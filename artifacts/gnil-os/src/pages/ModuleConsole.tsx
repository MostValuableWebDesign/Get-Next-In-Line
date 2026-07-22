import { useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListModules,
  useGetModulesPricing,
  useGetAgencySettings,
  useGetModuleTenantCounts,
  useGetModuleTenants,
  getGetModuleTenantsQueryKey,
  useGetAdminModuleDetail,
  getGetAdminModuleDetailQueryKey,
  type AdminModuleDetail,
} from '@workspace/api-client-react';
import { CheckoutSimulationDialog } from '@/components/checkout/CheckoutSimulationDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { ActivityFeed } from '@/components/shared/ActivityFeed';
import { EditConnectorDialog } from '@/components/EditConnectorDialog';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft, CreditCard, FileText, History, Lock, Pencil, RefreshCw, Server, Settings, ShieldAlert, ShieldCheck, Sliders, Users,
} from 'lucide-react';

// Maps a module category to the matching section of the unified
// Configuration screen so each console links to one obvious settings home.
const CATEGORY_SETTINGS_ANCHOR: Record<string, string> = {
  operations: '/settings#sos-operations',
  marketing: '/settings#sms',
};

// Modules with a dedicated settings section link straight to it. Keyed by
// module name — the public modules API deliberately omits internal slugs.
const MODULE_SETTINGS_ANCHOR: Record<string, string> = {
  'No-Show Shield & Deposits': '/settings#no-show-shield',
};

const CATEGORY_ROUTES: Record<string, { path: string; label: string }> = {
  marketing: { path: '/marketing', label: 'Marketing OS & Bridge' },
  operations: { path: '/operations', label: 'Operations' },
  partners: { path: '/partners', label: 'Partners' },
  media: { path: '/media', label: 'Media' },
};

/**
 * Unified module detail page. Serves both /modules/:id (console view) and
 * /modules/:id (the old /admin/modules/:id path redirects here).
 * The connector-mapping section renders only when the admin module-detail
 * endpoint is accessible to the current session.
 */
export default function ModuleConsole() {
  const params = useParams<{ id: string }>();
  const moduleId = Number(params.id);
  const [location] = useLocation();
  const isAdminRoute = location.startsWith('/admin/');

  const { data: modules, isLoading: isLoadingModules } = useListModules();
  const { data: pricing, isLoading: isLoadingPricing } = useGetModulesPricing();
  const { data: settings, isLoading: isLoadingSettings } = useGetAgencySettings();
  const { data: tenantCounts } = useGetModuleTenantCounts();
  const { data: subscribers, isLoading: isLoadingSubscribers } = useGetModuleTenants(moduleId, {
    query: { queryKey: getGetModuleTenantsQueryKey(moduleId), enabled: Number.isInteger(moduleId) },
  });
  // Admin-only data: succeeds for admin sessions, errors otherwise — the
  // connector-mapping section simply doesn't render for non-admins.
  const { data: adminDetail } = useGetAdminModuleDetail(moduleId, {
    query: { queryKey: getGetAdminModuleDetailQueryKey(moduleId), enabled: Number.isInteger(moduleId) },
  });
  const { toast } = useToast();

  if (isLoadingModules || isLoadingPricing || isLoadingSettings) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="lg:col-span-2 h-[320px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
      </div>
    );
  }

  const module = modules?.find((m) => m.id === moduleId);

  if (!module) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Module not found</h1>
        <p className="text-muted-foreground">This module does not exist or is no longer available.</p>
        <Button asChild variant="outline">
          <Link href={isAdminRoute ? '/connectors' : '/'}>
            {isAdminRoute ? 'Back to Connector Registry' : 'Back to Command Center'}
          </Link>
        </Button>
      </div>
    );
  }

  const priceInfo = pricing?.find((p) => p.id === module.id);
  const isPartner = module.categorySlug === 'partners';
  const markupPercent = settings?.markupPercent ?? priceInfo?.markupPercent ?? 0;
  const activeTenants = tenantCounts?.find((c) => c.moduleId === module.id)?.activeTenantCount ?? 0;
  const backRoute = isAdminRoute
    ? { path: '/connectors', label: 'Connector Registry' }
    : CATEGORY_ROUTES[module.categorySlug] ?? { path: '/', label: 'Command Center' };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Button asChild variant="ghost" size="sm" className="gap-2 -ml-2 text-muted-foreground" data-testid="link-back-category">
        <Link href={backRoute.path}>
          <ArrowLeft className="w-4 h-4" /> Back to {backRoute.label}
        </Link>
      </Button>

      {/* Module Header */}
      <Card className="border-none shadow-md">
        <CardContent className="p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-xl text-primary">
              {isPartner ? <ShieldCheck className="w-8 h-8" /> : <Server className="w-8 h-8" />}
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight" data-testid="text-module-name">{module.name}</h1>
                <Badge variant="outline" className="uppercase text-[10px] tracking-wider border-emerald-500/40 text-emerald-600 bg-emerald-500/5">
                  {module.category}
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm mt-1" data-testid="text-module-description">{module.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 self-stretch md:self-auto justify-end">
            {isPartner ? (
              <Badge
                variant="outline"
                className="border-sky-500/40 text-sky-600 bg-sky-500/5 px-3 py-1"
                data-testid="badge-partner-direct"
              >
                Partner Direct (0% Markup)
              </Badge>
            ) : (
              <div className="text-right mr-2">
                <div className="text-xs text-muted-foreground">Resale Price w/ {markupPercent}% Markup</div>
                <div className="text-xl font-extrabold font-mono text-emerald-600" data-testid="text-resale-price">
                  {formatCurrency(priceInfo?.resalePrice ?? module.wholesalePrice)}
                  <span className="text-xs text-muted-foreground font-normal font-sans">/mo</span>
                </div>
                {priceInfo?.resalePriceBiweekly != null && (
                  <div className="text-xs font-mono text-muted-foreground mt-0.5" data-testid="text-resale-price-biweekly">
                    or {formatCurrency(priceInfo.resalePriceBiweekly)}
                    <span className="font-sans">/2wk</span>
                  </div>
                )}
              </div>
            )}
            <Button asChild variant="outline" className="gap-2" data-testid="link-module-settings">
              <Link href={MODULE_SETTINGS_ANCHOR[module.name] ?? CATEGORY_SETTINGS_ANCHOR[module.categorySlug] ?? '/settings'}>
                <Settings className="w-4 h-4" /> Configure
              </Link>
            </Button>
            {!isPartner && <ProvisionModuleDialog moduleId={module.id} moduleName={module.name} />}
          </div>
        </CardContent>
      </Card>

      {/* Console Interactive Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 border-none shadow-md">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-lg flex items-center gap-2">
              <Sliders className="w-5 h-5 text-primary" /> Operational & Marketing Proxy Console
            </CardTitle>
            <span className="text-xs text-muted-foreground bg-muted px-2.5 py-1 rounded-md border">
              Unified Ecosystem Active
            </span>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="p-6 bg-muted/40 rounded-xl border space-y-4">
              <div className="flex justify-between items-center pb-4 border-b">
                <span className="text-sm font-medium">Active Tenants Subscribed</span>
                <span className="text-sm font-bold text-emerald-600" data-testid="text-active-tenants">
                  {activeTenants} Active Subdomains
                </span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b">
                <span className="text-sm font-medium">API Gateway Status</span>
                <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-semibold">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> GNIL Bridge Connected
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Current Revenue Share Margin</span>
                <span className="text-sm font-bold text-primary" data-testid="text-markup-percent">
                  +{markupPercent}% Agency Markup
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              <Button
                variant="secondary"
                className="gap-2"
                data-testid="button-force-sync"
                onClick={() => toast({ title: 'Sync Complete', description: `Successfully synchronized data stream for ${module.name}` })}
              >
                <RefreshCw className="w-4 h-4" /> Force Sync Gateway
              </Button>
              <Button
                variant="secondary"
                className="gap-2"
                data-testid="button-export-ledger"
                onClick={() => toast({ title: 'Export Generated', description: `Generated compliance export report for ${module.name}` })}
              >
                <FileText className="w-4 h-4" /> Export Ledger Data
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 border-none shadow-md">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" /> Subscribed Tenants
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingSubscribers ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </div>
            ) : !subscribers || subscribers.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-subscribers">
                No tenants are subscribed to this module yet.
              </p>
            ) : (
              <div className="divide-y" data-testid="list-module-subscribers">
                {subscribers.map((s) => (
                  <Link
                    key={s.tenantId}
                    href={`/tenants/${s.tenantId}`}
                    className="flex items-center justify-between gap-4 py-3 px-2 -mx-2 rounded-lg hover:bg-muted/50 transition-colors"
                    data-testid={`link-subscriber-${s.tenantId}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.brandName}</div>
                      <div className="text-xs text-muted-foreground font-mono truncate">{s.subdomain}</div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <Badge variant="outline" className="text-[9px] uppercase" data-testid={`badge-cadence-${s.tenantId}`}>
                        {s.billingCadence === 'biweekly' ? 'Bi-Weekly' : 'Monthly'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        Provisioned {new Date(s.provisionedAt).toLocaleDateString()}
                      </span>
                      <StatusBadge status={s.status} variant="outline" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-none shadow-md">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Lock className="w-5 h-5 text-emerald-600" /> Unified Ecosystem Guard
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Front-end lead acquisition data flows directly into back-end operational scheduling, staff
              commissions, payroll, and high-margin programmatic media under your brand.
            </p>
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-2">
              <div className="text-xs font-bold text-emerald-600 uppercase tracking-wider">Status: Fully Integrated</div>
              <div className="text-xs text-muted-foreground">Seamless lead-to-payroll pipeline active across all tenants.</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Admin-only: connector mapping + provisioning activity (formerly the
          separate Admin Module Detail page). Rendered only when the admin
          module-detail endpoint is accessible. */}
      {adminDetail && <AdminConnectorSection moduleId={moduleId} detail={adminDetail} />}
    </div>
  );
}

function AdminConnectorSection({
  moduleId,
  detail,
}: {
  moduleId: number;
  detail: AdminModuleDetail;
}) {
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const { mapping } = detail;

  return (
    <div className="space-y-6" data-testid="section-admin-connector">
      <Card data-testid="card-connector-mapping">
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base font-semibold">Connector Mapping</CardTitle>
          <div className="flex items-center gap-3">
            <Badge variant="destructive" className="shrink-0 gap-1.5 uppercase tracking-wider font-mono">
              <ShieldAlert className="size-3.5" />
              Admin Only
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setEditing(true)}
              data-testid="button-edit-mapping"
            >
              <Pencil className="size-3.5" /> Edit Mapping
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Slug</div>
            {mapping.slug ? (
              <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded" data-testid="text-mapping-slug">{mapping.slug}</code>
            ) : (
              <span className="text-sm text-muted-foreground italic">no slug</span>
            )}
          </div>
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Upstream Vendor</div>
            <div className="text-sm" data-testid="text-mapping-vendor">
              {mapping.upstreamVendor ?? <span className="text-muted-foreground italic">—</span>}
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Hidden Connector</div>
            <div className="text-sm" data-testid="text-mapping-connector">
              {mapping.hiddenConnector ?? (
                <span className="text-muted-foreground italic">Internal — no external connector mapped</span>
              )}
            </div>
          </div>
          <div className="md:col-span-2">
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Proxy Notes</div>
            <div className="text-sm" data-testid="text-mapping-notes">
              {mapping.proxyNotes ?? <span className="text-muted-foreground italic">—</span>}
            </div>
          </div>
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Wholesale / Resale</div>
            <div className="text-sm font-mono" data-testid="text-mapping-pricing">
              {formatCurrency(detail.wholesalePrice)} → {formatCurrency(detail.resalePrice)}/mo
              <span className="text-muted-foreground font-sans"> ({detail.markupPercent}% markup)</span>
              {detail.resalePriceBiweekly != null && (
                <span className="text-muted-foreground"> · {formatCurrency(detail.resalePriceBiweekly)}/2wk</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Status</div>
            <StatusBadge
              status={mapping.isActive ? 'active' : 'inactive'}
              variant="outline"
              data-testid="badge-mapping-active"
            />
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-provisioning-activity">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <History className="size-4 text-primary" /> Recent Provisioning Activity
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ActivityFeed
            variant="divided"
            items={detail.activity.map((a) => ({
              id: a.id,
              action: a.action,
              timestamp: a.timestamp,
              details: a.details,
              tenantName: a.tenantName,
              tenantHref: `/tenants/${a.tenantId}`,
            }))}
            itemClassName="px-6"
            itemTestIdPrefix="activity-"
            listTestId="list-provisioning-activity"
            empty={
              <p className="text-sm text-muted-foreground px-6 pb-6" data-testid="text-no-activity">
                No provisioning activity recorded for this module yet.
              </p>
            }
          />
        </CardContent>
      </Card>

      {editing && (
        <EditConnectorDialog
          entry={mapping}
          onClose={() => setEditing(false)}
          onSaved={() =>
            queryClient.invalidateQueries({ queryKey: getGetAdminModuleDetailQueryKey(moduleId) })
          }
        />
      )}
    </div>
  );
}

function ProvisionModuleDialog({ moduleId, moduleName }: { moduleId: number; moduleName: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button className="gap-2" onClick={() => setOpen(true)} data-testid="button-provision-module">
        <CreditCard className="w-4 h-4" /> Provision Module
      </Button>
      <CheckoutSimulationDialog
        open={open}
        onOpenChange={setOpen}
        title={`Provision ${moduleName}`}
        description="Simulated Stripe checkout — select the tenant that will receive this module."
        lockedModuleId={moduleId}
      />
    </>
  );
}
